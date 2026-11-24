import { BellOff, Check, ChevronDown, CircleCheck, Coffee, Pause, Play, Plus, RotateCcw, SkipForward, Square, Timer, X } from 'lucide-preact';
import { addFive, closeFocus, finish, leftSec, minimize, pauseResume, startFocus, useFocus } from '../focus';
import { openItem, setDone, setStep, toast, useApp } from '../store';
import { fmtMinutes, itemDueLabel } from '../dates';
import { Mark } from '../ui';

const RC = 2 * Math.PI * 108;
const clk = (x: number) => { x = Math.ceil(Math.max(0, x)); return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

/** 全屏专注：深色背景、圆环倒计时、当前这一步。专注时屏幕保持常亮。 */
export function FocusView() {
  const s = useApp();
  const f = useFocus(true)!;
  const it = s.items.find((i) => i.id === f.itemId);
  if (!it) {
    return (
      <div class="focus open" role="dialog" aria-label="专注计时">
        <div class="f-main done"><h2>这项作业找不到了</h2><p>可能已经被删掉。</p></div>
        <div class="f-acts"><button class="btn fl2" onClick={closeFocus}>关闭</button></div>
      </div>
    );
  }
  const left = leftSec(f);
  const active = f.phase === 'focus' || f.phase === 'break';
  const brk = f.phase === 'break';
  const nx = it.steps.findIndex((x) => !x.done);
  const doneSteps = it.steps.filter((x) => x.done).length;

  const endEarly = async () => {
    if (brk) return startFocus(it.id);
    if ((await finish(true)) === 'short') toast('不到 1 分钟，这次没有记录');
  };
  const back = () => { const id = it.id; closeFocus(); openItem(id); };

  return (
    <div class="focus open" role="dialog" aria-modal="true" aria-label="专注计时">
      <div class="f-top">
        {active ? <button class="f-ic" onClick={() => minimize(true)} aria-label="收起，继续计时"><ChevronDown size={22} /></button>
          : <button class="f-ic" onClick={back} aria-label="关闭"><X size={22} /></button>}
        <span class="f-cnt">{active ? (brk ? '休息时间' : `今天第 ${f.count + 1} 个专注`) : `今天已专注 ${f.count} 次`}</span>
        <span class="f-ic ghost" />
      </div>
      {active ? (
        <>
          <div class="f-main">
            <div class="f-subj"><Mark subject={it.subject} /><span>{it.subject}{it.due ? ` · ${itemDueLabel(it, new Date())} 截止` : ''}<b>{it.title}</b></span></div>
            <div class={`f-ring ${brk ? 'brk' : ''}`}>
              <svg viewBox="0 0 240 240" aria-hidden="true">
                <circle class="trk" cx="120" cy="120" r="108" />
                <circle class="prg" cx="120" cy="120" r="108" stroke-dasharray={RC} style={{ strokeDashoffset: RC * (1 - left / f.total) }} />
              </svg>
              <div class="f-mid" role="timer" aria-live="off"><b>{clk(left)}</b><span>{f.running ? (brk ? '休息中' : '专注中') : '已暂停'}</span></div>
            </div>
            {brk ? (
              <div class="f-step"><div class="l"><small>休息一下</small><b>站起来走走，看看窗外。{nx >= 0 ? `回来接着做：${it.steps[nx].text}` : ''}</b></div></div>
            ) : nx >= 0 ? (
              <div class="f-step">
                <div class="l"><small>现在做 · 第 {nx + 1} / {it.steps.length} 步</small><b>{it.steps[nx].text}</b>
                  <span class="f-dots">{it.steps.map((x) => <i class={x.done ? 'on' : ''} />)}</span></div>
                <button class="f-done-step" onClick={() => setStep(it, it.steps[nx].id, true)}><Check size={15} />这步做完了</button>
              </div>
            ) : it.steps.length ? (
              <div class="f-step"><div class="l"><small>步骤都做完了</small><b>检查一遍就可以提前结束</b></div></div>
            ) : null}
          </div>
          <div class="f-ctl">
            <button class="f-btn" onClick={endEarly}><span>{brk ? <SkipForward size={22} /> : <Square size={20} />}</span>{brk ? '跳过休息' : '结束'}</button>
            <button class="f-btn main" onClick={pauseResume} aria-label={f.running ? '暂停' : '继续'}><span>{f.running ? <Pause size={28} /> : <Play size={28} />}</span>{f.running ? '暂停' : '继续'}</button>
            <button class="f-btn" onClick={addFive}><span><Plus size={22} /></span>加 5 分钟</button>
          </div>
          <p class="f-foot"><BellOff size={14} />屏幕会保持常亮；切到别的 App 也没关系，时间到了会推送提醒</p>
        </>
      ) : f.phase === 'done' ? (
        <>
          <div class="f-main done">
            <span class="f-check"><Check size={38} /></span>
            <h2>{f.early ? '提前结束，' : ''}专注了 {f.result} 分钟</h2>
            <p>{it.subject}这项已累计专注 <b>{fmtMinutes(it.focus_minutes)}</b>{it.est_minutes ? <>，预计要 <b>{fmtMinutes(it.est_minutes)}</b></> : null}。{it.done ? '作业已经完成。' : it.steps.length ? `还剩 ${it.steps.length - doneSteps} 步。` : ''}</p>
          </div>
          <div class="f-acts">
            {!it.done && <button class="btn fp" onClick={async () => { if (await setDone(it, true)) { closeFocus(); toast(`${it.subject}作业完成了`); } }}><CircleCheck size={18} />作业写完了</button>}
            <button class={`btn ${it.done ? 'fp' : 'fs'}`} onClick={() => startFocus(it.id, 'break')}><Coffee size={18} />休息 {s.prefs.rest} 分钟</button>
            {!it.done && <button class="btn fs" onClick={() => startFocus(it.id)}><RotateCcw size={18} />再专注 {s.prefs.focus} 分钟</button>}
            <button class="btn fl2" onClick={back}>回到作业</button>
          </div>
        </>
      ) : (
        <>
          <div class="f-main done">
            <span class="f-check brk"><Coffee size={36} /></span>
            <h2>休息好了吗？</h2>
            <p>{nx >= 0 ? `接着做第 ${nx + 1} 步：${it.steps[nx].text}` : it.done ? '这项作业已经完成了。' : '接着写吧。'}</p>
          </div>
          <div class="f-acts">
            {!it.done && <button class="btn fp" onClick={() => startFocus(it.id)}><Timer size={18} />继续专注 {s.prefs.focus} 分钟</button>}
            <button class="btn fl2" onClick={back}>回到作业</button>
          </div>
        </>
      )}
    </div>
  );
}

/** 收起后顶部的小胶囊，点一下回到全屏计时。 */
export function FocusPill() {
  const s = useApp();
  const f = useFocus(true)!;
  const it = s.items.find((i) => i.id === f.itemId);
  if (!['focus', 'break'].includes(f.phase)) return null;
  return (
    <button class={`fpill ${f.phase === 'break' ? 'brk' : ''} ${f.running ? '' : 'paused'}`} onClick={() => minimize(false)} aria-label="回到专注计时">
      <i class="dot" />{f.phase === 'break' ? '休息' : it?.subject || '专注'}<b>{clk(leftSec(f))}</b>{!f.running && <small>已暂停</small>}
    </button>
  );
}
