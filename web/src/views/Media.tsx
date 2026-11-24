import { ChevronLeft, ChevronRight, Download, FileText, Pause, Play, Repeat, X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../store';
import type { Item } from '../types';

const isImage = (it: Item) => it.mime.startsWith('image/') && !it.mime.includes('svg') && !/\.(heic|heif)$/i.test(it.file_url);
const isAudio = (it: Item) => it.mime.startsWith('audio/') || it.kind === 'listening';
const isPdf = (it: Item) => it.mime === 'application/pdf';

export function Attachment({ it }: { it: Item }) {
  const [viewer, setViewer] = useState(false);
  if (isImage(it)) {
    return (
      <>
        <div class="sec">附件</div>
        <button class="thumbbtn" onClick={() => setViewer(true)} aria-label={`全屏查看 ${it.filename}`}><img src={it.file_url} alt={it.filename} loading="lazy" /></button>
        {viewer && <ImageViewer start={it} onClose={() => setViewer(false)} />}
      </>
    );
  }
  if (isAudio(it)) return <><div class="sec">听力</div><AudioPlayer it={it} /></>;
  return (
    <>
      <div class="sec">附件</div>
      <div class="files">
        <a class="file" href={it.file_url} target="_blank" rel="noopener"><FileText size={15} />{isPdf(it) ? '打开 PDF' : '打开'} · {it.filename}</a>
        <a class="file" href={`${it.file_url}?download=1`}><Download size={15} />下载</a>
      </div>
    </>
  );
}

/** 全屏看图：在当前本子同一科目的图片之间左右翻，双指可以放大。 */
function ImageViewer({ start, onClose }: { start: Item; onClose: () => void }) {
  const { items } = useApp();
  const list = items.filter((i) => i.subject === start.subject && i.file_url && isImage(i));
  const [idx, setIdx] = useState(Math.max(0, list.findIndex((i) => i.id === start.id)));
  const touch = useRef(0);
  const cur = list[idx] || start;
  const go = (d: number) => setIdx((i) => (i + d + list.length) % list.length);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [list.length]);
  return (
    <div class="viewer" role="dialog" aria-label="查看图片"
      onTouchStart={(e) => { touch.current = e.touches.length === 1 ? e.touches[0].clientX : NaN; }}
      onTouchEnd={(e) => { const dx = e.changedTouches[0].clientX - touch.current; if (Math.abs(dx) > 60 && list.length > 1) go(dx < 0 ? 1 : -1); }}>
      <div class="v-top">
        <button class="f-ic" onClick={onClose} aria-label="关闭"><X size={22} /></button>
        <span>{cur.title}{list.length > 1 ? ` · ${idx + 1}/${list.length}` : ''}</span>
        <a class="f-ic" href={`${cur.file_url}?download=1`} aria-label="下载原图"><Download size={20} /></a>
      </div>
      <div class="v-img"><img src={cur.file_url} alt={cur.filename} /></div>
      {list.length > 1 && (
        <div class="v-nav">
          <button class="f-ic" onClick={() => go(-1)} aria-label="上一张"><ChevronLeft size={22} /></button>
          <button class="f-ic" onClick={() => go(1)} aria-label="下一张"><ChevronRight size={22} /></button>
        </div>
      )}
    </div>
  );
}

const fmt = (t: number) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '--:--');

/** 听力播放器：大号播放、拖动、前后 10 秒、倍速、整段循环和 AB 复读。 */
function AudioPlayer({ it }: { it: Item }) {
  const a = useRef<HTMLAudioElement>(null);
  const [, tick] = useState(0);
  const [rate, setRate] = useState(1);
  const [ab, setAb] = useState<[number | null, number | null]>([null, null]);
  const [err, setErr] = useState(false);
  useEffect(() => {
    const el = a.current!;
    const up = () => {
      tick((x) => x + 1);
      const [A, B] = ab;
      if (A !== null && B !== null && el.currentTime >= B) el.currentTime = A;
    };
    ['timeupdate', 'play', 'pause', 'loadedmetadata', 'ended'].forEach((e) => el.addEventListener(e, up));
    return () => ['timeupdate', 'play', 'pause', 'loadedmetadata', 'ended'].forEach((e) => el.removeEventListener(e, up));
  }, [ab]);
  const el = a.current;
  const t = el?.currentTime || 0, d = el?.duration || 0;
  const setAB = () => {
    if (!el) return;
    if (ab[0] === null) setAb([el.currentTime, null]);
    else if (ab[1] === null && el.currentTime > ab[0] + 0.5) setAb([ab[0], el.currentTime]);
    else setAb([null, null]);
  };
  return (
    <div class="audio">
      <audio ref={a} src={it.file_url} preload="metadata" onError={() => setErr(true)} />
      {err ? (
        <p class="hint">这段音频播放不了。<a href={`${it.file_url}?download=1`}>下载原文件</a></p>
      ) : (
        <>
          <div class="a-main">
            <button class="a-play" onClick={() => (el?.paused ? el.play() : el?.pause())} aria-label={el && !el.paused ? '暂停' : '播放'}>
              {el && !el.paused ? <Pause size={28} /> : <Play size={28} />}
            </button>
            <div class="a-track">
              <input type="range" min={0} max={d || 0} step={0.1} value={t} aria-label="播放进度" onInput={(e) => { if (el) el.currentTime = Number((e.target as HTMLInputElement).value); }} />
              <div class="a-time"><span>{fmt(t)}</span><span>{fmt(d)}</span></div>
            </div>
          </div>
          <div class="a-ctl">
            <button class="opt sm" onClick={() => el && (el.currentTime = Math.max(0, t - 10))}>−10 秒</button>
            <button class="opt sm" onClick={() => el && (el.currentTime = Math.min(d, t + 10))}>+10 秒</button>
            <button class="opt sm" onClick={() => { const r = [0.75, 1, 1.25, 1.5, 2][([0.75, 1, 1.25, 1.5, 2].indexOf(rate) + 1) % 5]; setRate(r); if (el) el.playbackRate = r; }}>{rate}×</button>
            <button class={`opt sm ${el?.loop ? 'on' : ''}`} onClick={() => { if (el) el.loop = !el.loop; tick((x) => x + 1); }} aria-pressed={!!el?.loop}><Repeat size={14} />循环</button>
            <button class={`opt sm ${ab[0] !== null ? 'on' : ''}`} onClick={setAB}>{ab[0] === null ? 'AB 复读' : ab[1] === null ? `A ${fmt(ab[0])} · 点设 B` : `${fmt(ab[0])}–${fmt(ab[1])} · 取消`}</button>
          </div>
        </>
      )}
    </div>
  );
}
