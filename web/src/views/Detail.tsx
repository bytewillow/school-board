import { Bell, BellOff, Check, ChevronDown, ChevronLeft, ChevronUp, ExternalLink, Pencil, Timer } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { countdown, effectiveRemind, fmtMinutes, isHomework, itemDueLabel, remindAt, REMIND_LABELS, urgentId, dayLabel, pad, type RemindChoice } from '../dates';
import { getFocus, minimize, startFocus, useFocus } from '../focus';
import { closeItem, replaceItem, selectChild, setDone, setState, setStep, showError, toast, useApp } from '../store';
import type { Item } from '../types';
import { canEdit, fmtVisible, kindLabel, Mark } from '../ui';
import { Attachment } from './Media';

export function Detail({ id }: { id: number }) {
  const s = useApp();
  useFocus();
  const it = s.items.find((i) => i.id === id);
  // 家长从链接打开别的本子里的作业：自动切到那个本子
  useEffect(() => {
    if (it || s.me?.role !== 'parent' || !s.items.length) return;
    api<{ item: Item }>(`/app-api/items/${id}`).then((r) => { if (r.item.child_id && r.item.child_id !== s.child) selectChild(r.item.child_id); }).catch(() => {});
  }, [id, !!it, s.items.length]);
  if (!it) {
    return (
      <div class="d-scroll">
        <button class="back" onClick={closeItem}><ChevronLeft size={20} />返回</button>
        <p class="empty-note">没找到这条内容。它可能已被删除，或者还没到显示时间。</p>
      </div>
    );
  }
  return <DetailBody it={it} />;
}

function DetailBody({ it }: { it: Item }) {
  const s = useApp();
  const now = new Date();
  const hw = isHomework(it);
  const u = urgentId(s.items, now);
  const cd = hw ? countdown(it, now) : null;
  const sd = it.steps.filter((x) => x.done).length;
  const f = getFocus();
  const focusingThis = f && f.itemId === it.id && ['focus', 'break'].includes(f.phase);
  const backLabel = { today: '今天', cal: '日历', subj: '科目', me: '我的', login: '', manage: '', notebooks: '' }[s.route.view];

  const toggleDone = async () => {
    const ok = await setDone(it, !it.done);
    if (ok && !it.done) {
      const left = s.items.filter((i) => isHomework(i) && !i.done && i.id !== it.id && i.due === it.due).length;
      toast(left ? `完成了！这天还剩 ${left} 项` : '完成了！这天的作业都写完了', { label: '撤销', run: () => setDone({ ...it, done: true }, false) });
    }
  };

  return (
    <>
      <div class="d-scroll">
        <div class="d-top">
          <button class="back" onClick={closeItem}><ChevronLeft size={20} />{backLabel}</button>
          <span class="d-subj"><Mark subject={it.subject} hi={it.id === u} />{it.subject} · {kindLabel(it.kind)}</span>
        </div>
        <h2>{it.title}</h2>
        {it.hidden && <p class="hint">家长设置了定时显示：{fmtVisible(it.visible_at)} 之前孩子看不到这条。</p>}
        {it.shared && <p class="hint">这是共享内容，完成状态所有本子同步。</p>}

        {hw && (
          <div class={`due ${it.done ? 'ok' : it.id === u || cd?.past ? '' : 'calm'}`}>
            {it.done ? (
              <><small>已完成{it.due ? ` · 截止 ${itemDueLabel(it, now)}` : ''}</small><b>交上去了</b></>
            ) : cd ? (
              <><small>{cd.past ? '已经过了截止时间' : '距离截止'} · {itemDueLabel(it, now)}{it.due_time ? '' : '（没写时间，按 21:00 算）'}</small>
                <b>{cd.big}<em>{cd.unit}</em>{cd.small !== undefined && <>{cd.small}<em>{cd.unit2}</em></>}</b></>
            ) : (
              <><small>没有截止日期</small><b class="sm">想写的时候写</b></>
            )}
          </div>
        )}
        {hw && !it.done && it.due && <RemindRow it={it} />}

        {it.steps.length > 0 && (
          <>
            <div class="sec">步骤<span>{sd} / {it.steps.length}{it.focus_minutes ? ` · 已专注 ${fmtMinutes(it.focus_minutes)}` : ''}</span></div>
            <div class="steps">
              {it.steps.map((st) => (
                <button class={`step ${st.done ? 'on' : ''}`} aria-pressed={st.done} onClick={() => setStep(it, st.id, !st.done)}>
                  <span class="box"><Check size={14} strokeWidth={3} /></span>{st.text}
                </button>
              ))}
            </div>
          </>
        )}
        {!it.steps.length && hw && (it.est_minutes > 0 || it.focus_minutes > 0) && (
          <p class="meta-line">{it.est_minutes ? `预计 ${fmtMinutes(it.est_minutes)}` : ''}{it.est_minutes && it.focus_minutes ? ' · ' : ''}{it.focus_minutes ? `已专注 ${fmtMinutes(it.focus_minutes)}` : ''}</p>
        )}
        {it.body && (<><div class="sec">{hw ? '老师的话' : '内容'}</div><p class="note">{it.body}</p></>)}
        {it.link_url && <a class="file" href={it.link_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />打开原链接</a>}
        {it.file_url && <Attachment it={it} />}
      </div>
      <div class="d-act">
        {canEdit(it) && <button class="btn s" onClick={() => setState({ sheet: { mode: 'edit', id: it.id } })}><Pencil size={17} />修改</button>}
        {hw && !it.done && (
          <button class="btn p" onClick={() => (focusingThis ? minimize(false) : startFocus(it.id))}><Timer size={18} />{focusingThis ? '回到专注' : `开始专注 ${s.prefs.focus} 分钟`}</button>
        )}
        {hw && <button class={`btn ${it.done ? 's' : 'ok'}`} onClick={toggleDone}><Check size={18} />{it.done ? '取消完成' : '完成'}</button>}
      </div>
    </>
  );
}

function RemindRow({ it }: { it: Item }) {
  const s = useApp();
  const [open, setOpen] = useState(false);
  const prefs = { remind: s.prefs.remind, before: s.prefs.before };
  const choice = effectiveRemind(it.remind, it.due_time, prefs);
  const at = remindAt(it.due, it.due_time, it.remind, prefs);
  const now = new Date();
  const text = !at ? '不提醒' : at <= now ? `${REMIND_LABELS[choice]} · 时间已过` : `${dayLabel(at, now)} ${pad(at.getHours())}:${pad(at.getMinutes())} · ${REMIND_LABELS[choice]}`;
  const off = !at || at <= now;
  const pick = async (v: RemindChoice) => {
    setOpen(false);
    try {
      const r = await api<{ item: Item }>(`/app-api/items/${it.id}`, { method: 'PATCH', json: { remind: v } });
      replaceItem(r.item);
    } catch (e) { showError(e); }
  };
  return (
    <>
      <button class="remrow" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!canEdit(it)}>
        {off ? <BellOff size={18} /> : <Bell size={18} />}<span class="rl">提醒</span>
        <span class={`rv ${off ? 'off' : ''}`}>{text}</span>{canEdit(it) && (open ? <ChevronUp size={18} /> : <ChevronDown size={18} />)}
      </button>
      {open && (
        <div class="remopts">
          {(['off', '60', '120', '180', 'eve'] as RemindChoice[]).map((k) => (
            <button class={`opt sm ${choice === k ? 'on' : ''}`} onClick={() => pick(k)}>{REMIND_LABELS[k]}</button>
          ))}
        </div>
      )}
    </>
  );
}
