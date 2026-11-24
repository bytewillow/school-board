import { Calendar, Clock, Minus, Paperclip, Plus, ScanText, Trash2, X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, ApiError, OfflineError } from '../api';
import { addDays, dueAt, fmtMinutes, isHomework, isoDate, md, parseDate, remainingMinutes, validTime, weekStart, WEEKDAYS } from '../dates';
import { closeItem, refresh, replaceItem, setState, showError, toast, useApp } from '../store';
import type { Draft, Item } from '../types';
import { kindLabel } from '../ui';

interface Form {
  subject: string; title: string; kind: string; day: string; time: string; est: number; steps: string[]; body: string;
  visible_at: string; pinned: boolean; child_id: number; file: File | null; auto: Record<string, boolean>;
}

/** 记作业 / 修改作业。手机从底部弹出，平板在屏幕中间。 */
export function AddSheet() {
  const s = useApp();
  const sheet = s.sheet!;
  const me = s.me!;
  const editing = sheet.mode === 'edit' ? s.items.find((i) => i.id === sheet.id) : undefined;
  const now = new Date();
  const tk = isoDate(now), tm = isoDate(addDays(now, 1));
  const initial = useMemo<Form>(() => {
    if (editing) {
      return {
        subject: editing.subject, title: editing.title, kind: editing.kind, day: editing.due, time: editing.due_time, est: editing.est_minutes || 30,
        steps: editing.steps.map((x) => x.text), body: editing.body, visible_at: editing.visible_at, pinned: editing.pinned, child_id: editing.child_id, file: null, auto: {},
      };
    }
    const preset = sheet.mode === 'add' ? sheet : { day: undefined, subject: undefined };
    const fromRoute = s.route.view === 'subj' ? s.route.subject : null;
    const calDay = s.route.view === 'cal' && s.calSel >= tk ? s.calSel : '';
    const day = preset.day || calDay || tm;
    return {
      subject: preset.subject || fromRoute || '', title: '', kind: 'homework', day, time: day === tk ? '21:00' : '08:00', est: 30, steps: [], body: '',
      visible_at: '', pinned: false, child_id: s.child!, file: null, auto: {},
    };
  }, []);
  const [f, setF] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<'idle' | 'busy' | 'done'>('idle');
  const [drafts, setDrafts] = useState<(Draft & { pick: boolean })[]>([]);
  const [pasted, setPasted] = useState('');
  const [more, setMore] = useState(!!(initial.visible_at || initial.pinned || (initial.kind !== 'homework')));
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const up = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch, auto: Object.fromEntries(Object.entries(x.auto).filter(([k]) => !(k in patch))) }));
  const close = () => setState({ sheet: null });

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

  const hw = f.kind === 'homework';
  const at = f.day ? dueAt(f.day, f.time) : null;
  const mins = at ? Math.round((at.getTime() - now.getTime()) / 60000) : null;
  const past = !editing && mins !== null && mins <= 0;
  const reason = !f.subject ? '先选科目' : !f.title.trim() && !f.file ? '写下作业内容' : past ? '换一个截止时间' : '';
  const sameDay = s.items.filter((i) => isHomework(i) && !i.done && i.due === f.day && i.id !== editing?.id);
  const sameMin = sameDay.reduce((a, i) => a + remainingMinutes(i), 0) + (hw ? f.est : 0);

  const ws = weekStart(now);
  const dayOpts: [string, string][] = [[tk, '今天'], [tm, '明天']];
  for (let i = 2; i <= 3; i++) { const d = addDays(now, i); if (d < addDays(ws, 7)) dayOpts.push([isoDate(d), '周' + WEEKDAYS[d.getDay()]]); }
  dayOpts.push([isoDate(addDays(ws, 7)), '下周一']);
  const customDay = f.day && !dayOpts.some(([k]) => k === f.day);

  async function save() {
    if (reason || busy) return;
    setBusy(true);
    try {
      if (editing) {
        const patch: Record<string, unknown> = {
          title: f.title.trim(), subject: f.subject, kind: f.kind, due: f.day, due_time: f.day ? f.time : '', est_minutes: hw ? f.est : 0,
          steps: f.steps.map((x) => x.trim()).filter(Boolean), body: f.body, pinned: f.pinned,
        };
        if (me.role === 'parent') { patch.visible_at = f.visible_at; patch.child_id = f.child_id; }
        const r = await api<{ item: Item }>(`/app-api/items/${editing.id}`, { method: 'PATCH', json: patch });
        replaceItem(r.item);
        if (r.item.child_id !== s.child && r.item.child_id !== 0) refresh();
        toast('改好了');
      } else {
        const fd = new FormData();
        const put = (k: string, v: string) => fd.append(k, v);
        put('child_id', String(f.child_id)); put('subject', f.subject); put('title', f.title.trim()); put('kind', f.kind);
        put('due', f.day); put('due_time', f.day ? f.time : ''); put('est_minutes', String(hw ? f.est : 0)); put('body', f.body);
        put('steps', JSON.stringify(f.steps.map((x) => x.trim()).filter(Boolean)));
        if (me.role === 'parent') { put('visible_at', f.visible_at); if (f.pinned) put('pinned', '1'); }
        if (f.file) fd.append('file', f.file, f.file.name);
        const r = await api<{ item: Item }>('/app-api/items', { form: fd });
        if (r.item.child_id === s.child) replaceItem(r.item);
        const d = parseDate(r.item.due);
        toast(`已记下：${r.item.subject}${d ? ` · ${md(d)}${r.item.due_time ? ' ' + r.item.due_time : ''}` : ''}`, { label: '查看', run: () => { import('../store').then((m) => m.openItem(r.item.id)); } });
        refresh();
      }
      close();
    } catch (e) {
      // 连接中断时结果不明：保留表单，不自动重试，免得重复登记
      if (e instanceof OfflineError) toast('没有网络，作业还没保存。联网后再点一次保存。');
      else showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing || !confirm('删除后无法恢复，家长也找不回来。确定删除吗？')) return;
    try {
      await api(`/app-api/items/${editing.id}`, { method: 'DELETE' });
      setState((st) => ({ items: st.items.filter((i) => i.id !== editing.id), sheet: null }));
      closeItem();
      toast('已删除');
      refresh();
    } catch (e) { showError(e); }
  }

  async function recognize(image: File | null, text: string) {
    setScan('busy');
    const fd = new FormData();
    fd.append('child_id', String(f.child_id));
    if (text) fd.append('text', text);
    if (image) fd.append('file', image, image.name || 'photo.jpg');
    try {
      const r = await api<{ drafts: Draft[] }>('/api/ai-parse', { form: fd });
      const list = r.drafts.filter((d) => d.title || d.body);
      if (!list.length) { setScan('idle'); toast('没认出作业，换个角度再拍一张，或者手动填'); return; }
      if (list.length === 1) {
        const d = list[0];
        setF((x) => ({
          ...x, subject: d.subject || x.subject, title: d.title || x.title, kind: d.kind || x.kind, day: d.due || x.day, body: d.body || x.body,
          auto: { subject: !!d.subject, title: !!d.title, day: !!d.due, body: !!d.body },
        }));
        setScan('done');
      } else {
        setDrafts(list.map((d) => ({ ...d, pick: true })));
        setScan('done');
      }
    } catch (e) {
      setScan('idle');
      if (e instanceof ApiError && e.code === 'llm_not_configured') toast('服务器没有配置识别服务，请手动填写');
      else showError(e);
    }
  }

  async function saveDrafts() {
    const picked = drafts.filter((d) => d.pick);
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      const r = await api<{ created: { index: number; id: number; title: string }[]; failed: { index: number; message: string }[] }>('/api/ai-batch', { json: { drafts: picked.map(({ pick, ...d }) => ({ ...d, child_id: f.child_id })) } });
      const failedIdx = new Set(r.failed.map((x) => x.index));
      setDrafts(picked.filter((_, i) => failedIdx.has(i)).map((d) => ({ ...d, pick: true })));
      await refresh();
      if (!r.failed.length) { toast(`已记下 ${r.created.length} 项`); close(); }
      else toast(`记下 ${r.created.length} 项，还有 ${r.failed.length} 项没保存：${r.failed[0].message}`);
    } catch (e) {
      if (e instanceof OfflineError) toast('连接中断，结果不确定。先刷新看看有没有记上，再决定要不要重试。');
      else showError(e);
    } finally { setBusy(false); }
  }

  const A = (k: string) => (f.auto[k] ? <em class="auto">已识别</em> : null);
  const subjects = me.subjects;

  return (
    <div class="sheet-wrap open">
      <div class="backdrop" onClick={close} />
      <div class="sheet" role="dialog" aria-modal="true" aria-label={editing ? '修改作业' : '记作业'}>
        <div class="sh-head">
          <button class="lnk" onClick={close}>取消</button>
          <h2>{editing ? '修改' : '记作业'}</h2>
          {editing ? <button class="lnk danger" onClick={remove} aria-label="删除"><Trash2 size={18} /></button> : <span />}
        </div>
        <div class="sh-body">
          {!editing && me.features.ai && (
            <>
              <div class="scan-row">
                <button class={`scan ${scan === 'busy' ? 'busy' : ''}`} disabled={scan === 'busy'} onClick={() => camRef.current?.click()}>
                  {scan === 'busy' ? <span class="spin" /> : <ScanText size={28} />}
                  <span><b>{scan === 'busy' ? '正在识别…' : scan === 'done' ? '识别好了，请核对' : '拍照识别作业'}</b><small>{scan === 'busy' ? '把作业单放平，文字更容易认出来' : '拍黑板或作业单，自动填好下面的内容'}</small></span>
                </button>
                <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const file = (e.target as HTMLInputElement).files?.[0]; if (file) recognize(file, ''); (e.target as HTMLInputElement).value = ''; }} />
              </div>
              <details class="paste">
                <summary>粘贴老师发的消息</summary>
                <textarea class="fin" rows={3} value={pasted} onInput={(e) => setPasted((e.target as HTMLTextAreaElement).value)} placeholder="把家长群里的作业消息粘贴到这里" />
                <button class="opt" disabled={!pasted.trim() || scan === 'busy'} onClick={() => recognize(null, pasted.trim())}>识别这段文字</button>
              </details>
            </>
          )}

          {drafts.length > 0 ? (
            <div class="drafts">
              <div class="fl">识别出 {drafts.length} 项<span>勾选要保存的，可以直接改</span></div>
              {drafts.map((d, i) => (
                <div class={`draft ${d.pick ? '' : 'off'}`}>
                  <label class="dpick"><input type="checkbox" checked={d.pick} onChange={() => setDrafts(drafts.map((x, j) => (j === i ? { ...x, pick: !x.pick } : x)))} /> 保存</label>
                  <select class="fin sm" value={d.subject} onChange={(e) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, subject: (e.target as HTMLSelectElement).value } : x)))} aria-label="科目">
                    <option value="">选科目</option>{subjects.map((n) => <option value={n}>{n}</option>)}
                  </select>
                  <input class="fin sm" value={d.title} onInput={(e) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, title: (e.target as HTMLInputElement).value } : x)))} aria-label="内容" />
                  <input class="fin sm" type="date" value={d.due} onInput={(e) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, due: (e.target as HTMLInputElement).value } : x)))} aria-label="截止日期" />
                  <small>{kindLabel(d.kind || 'notice')}{d.body ? ' · ' + d.body.slice(0, 40) : ''}</small>
                </div>
              ))}
              <button class="lnk" onClick={() => { setDrafts([]); setScan('idle'); }}>不用这些，手动填一项</button>
            </div>
          ) : (
            <>
              {me.role === 'parent' && me.children.length > 1 && (
                <>
                  <div class="fl">给谁记</div>
                  <div class="opts">{me.children.map((c) => <button class={`opt ${f.child_id === c.id ? 'on' : ''}`} onClick={() => up({ child_id: c.id })}>{c.name}</button>)}</div>
                </>
              )}
              <div class="fl">科目{A('subject')}</div>
              <div class="opts">
                {subjects.map((n) => <button class={`opt ${f.subject === n ? 'on' : ''}`} aria-pressed={f.subject === n} onClick={() => up({ subject: n })}><span class="om">{n.slice(0, 1)}</span>{n}</button>)}
              </div>
              <div class="fl">{hw ? '作业内容' : '标题'}{A('title')}</div>
              <textarea class={`fin ${f.auto.title ? 'af' : ''}`} rows={2} value={f.title} placeholder="例如：练习册 P44，第 1–10 题" onInput={(e) => up({ title: (e.target as HTMLTextAreaElement).value })} />

              <div class="fl">{hw ? '什么时候交' : '截止日期（可选）'}{A('day')}</div>
              <div class="opts">
                {!hw && <button class={`opt ${!f.day ? 'on' : ''}`} onClick={() => up({ day: '' })}>不设</button>}
                {dayOpts.map(([k, l]) => <button class={`opt ${f.day === k ? 'on' : ''}`} onClick={() => up({ day: k })}>{l}</button>)}
                <label class={`opt pick ${customDay ? 'on' : ''}`}><Calendar size={15} />{customDay ? md(parseDate(f.day)!) : '其他日期'}
                  <input type="date" min={editing ? undefined : tk} value={f.day} onChange={(e) => up({ day: (e.target as HTMLInputElement).value })} /></label>
              </div>
              {f.day && (
                <div class="opts">
                  {([['08:00', '上课前 08:00'], ['21:00', '今晚 21:00']] as const).map(([t, l]) => <button class={`opt ${f.time === t ? 'on' : ''}`} onClick={() => up({ time: t })}>{l}</button>)}
                  <label class={`opt pick ${f.time && !['08:00', '21:00'].includes(f.time) ? 'on' : ''}`}><Clock size={15} />{f.time && !['08:00', '21:00'].includes(f.time) ? f.time : '其他时间'}
                    <input type="time" value={f.time} onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (validTime(v)) up({ time: v }); }} /></label>
                </div>
              )}

              {hw && (
                <>
                  <div class="fl">大概要多久<span>用来排今晚的时间</span></div>
                  <div class="estrow">
                    <div class="stepper">
                      <button onClick={() => up({ est: Math.max(5, f.est - 5) })} aria-label="减 5 分钟"><Minus size={18} /></button>
                      <b>{f.est}<small>分钟</small></b>
                      <button onClick={() => up({ est: Math.min(180, f.est + 5) })} aria-label="加 5 分钟"><Plus size={18} /></button>
                    </div>
                    <div class="opts tight">{[15, 30, 45, 60].map((v) => <button class={`opt ${f.est === v ? 'on' : ''}`} onClick={() => up({ est: v })}>{v}</button>)}</div>
                  </div>
                  <div class="fl">分步骤<span>选填，拆开写更容易开始</span></div>
                  <div class="fsteps">
                    {f.steps.map((t, i) => (
                      <div class="fstep">
                        <span class="box" />
                        <input class="fin sm" value={t} placeholder={`第 ${i + 1} 步`} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setF((x) => ({ ...x, steps: x.steps.map((y, j) => (j === i ? v : y)) })); }} />
                        <button class="x" onClick={() => setF((x) => ({ ...x, steps: x.steps.filter((_, j) => j !== i) }))} aria-label="删除这一步"><X size={18} /></button>
                      </div>
                    ))}
                    <button class="addstep" onClick={() => setF((x) => ({ ...x, steps: [...x.steps, ''] }))}><Plus size={16} />添加一步</button>
                  </div>
                </>
              )}
              <div class="fl">{hw ? '老师的话' : '内容'}{A('body')}<span>选填</span></div>
              <textarea class={`fin ${f.auto.body ? 'af' : ''}`} rows={2} value={f.body} placeholder="例如：要写出完整步骤" onInput={(e) => up({ body: (e.target as HTMLTextAreaElement).value })} />

              {!editing && (
                <>
                  <div class="fl">附件<span>照片、PDF 或听力音频，最大 50MB</span></div>
                  <div class="opts">
                    <button class="opt" onClick={() => fileRef.current?.click()}><Paperclip size={15} />{f.file ? f.file.name : '选文件'}</button>
                    {f.file && <button class="opt" onClick={() => up({ file: null })}>去掉</button>}
                  </div>
                  <input ref={fileRef} type="file" hidden accept="image/*,application/pdf,audio/*" onChange={(e) => up({ file: (e.target as HTMLInputElement).files?.[0] || null })} />
                </>
              )}

              {me.role === 'parent' && (
                <details class="paste" open={more} onToggle={(e) => setMore((e.target as HTMLDetailsElement).open)}>
                  <summary>更多选项：类型、定时显示、置顶{editing ? '、换本子' : ''}</summary>
                  <div class="fl">类型</div>
                  <div class="opts">{me.kinds.map((k) => <button class={`opt sm ${f.kind === k.code ? 'on' : ''}`} onClick={() => up({ kind: k.code })}>{k.label}</button>)}</div>
                  <div class="fl">到这个时间才给孩子看<span>比如答案</span></div>
                  <input class="fin sm" type="datetime-local" value={f.visible_at} onInput={(e) => up({ visible_at: (e.target as HTMLInputElement).value })} />
                  <label class="check-line"><input type="checkbox" checked={f.pinned} onChange={() => up({ pinned: !f.pinned })} /> 置顶，显示在首页最上面</label>
                  {editing && me.children.length > 1 && !editing.shared && (
                    <>
                      <div class="fl">属于哪个本子</div>
                      <div class="opts">{me.children.map((c) => <button class={`opt sm ${f.child_id === c.id ? 'on' : ''}`} onClick={() => up({ child_id: c.id })}>{c.name}</button>)}</div>
                    </>
                  )}
                </details>
              )}
            </>
          )}
        </div>
        <div class="sh-foot">
          {drafts.length > 0 ? (
            <>
              <div class="sh-sum">勾选了 {drafts.filter((d) => d.pick).length} 项。没选科目的不会保存。</div>
              <button class="btn p" disabled={busy || !drafts.some((d) => d.pick)} onClick={saveDrafts}>{busy ? '正在保存…' : `保存 ${drafts.filter((d) => d.pick).length} 项`}</button>
            </>
          ) : (
            <>
              <div class="sh-sum">
                {past ? <span class="warn">这个时间已经过了，换一个吧</span>
                  : at ? <><b>{f.day === tk ? '今天' : f.day === tm ? '明天' : md(parseDate(f.day)!)} {f.time || '21:00'} {hw ? '交' : '截止'}</b>{mins !== null && mins > 0 ? ` · 还有 ${mins < 1440 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${Math.floor(mins / 1440)} 天`}` : ''}<br />
                    <span>{hw ? (sameDay.length ? `那天已有 ${sameDay.length} 项，加上这项共约 ${fmtMinutes(sameMin)}` : '那天还没有别的作业') : ''}</span></>
                  : <span>没有截止日期</span>}
              </div>
              <button class="btn p" disabled={!!reason || busy} onClick={save}>{busy ? '正在保存…' : reason || (editing ? '保存修改' : '保存作业')}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
