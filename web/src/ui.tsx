import type { ComponentChildren } from 'preact';
import { Check } from 'lucide-preact';
import { groupOf, itemDueLabel, md, parseDate } from './dates';
import { getState, openItem, setDone, useApp } from './store';
import type { Item } from './types';

export const mark = (subject: string) => (subject || '?').slice(0, 1);

export function Mark({ subject, hi, size }: { subject: string; hi?: boolean; size?: 'lg' | 'sm' }) {
  return <span class={`mark ${hi ? 'hi' : ''} ${size || ''}`} aria-hidden="true">{mark(subject)}</span>;
}

export const kindLabel = (code: string) => getState().me?.kinds.find((k) => k.code === code)?.label || code;

export function canEdit(it: Item): boolean {
  const me = getState().me;
  if (!me) return false;
  return me.role === 'parent' || (it.child_id === me.child_id && !it.hidden);
}

/** 列表里的一行：左边科目字块，中间标题和截止时间，右边完成圆圈。 */
export function ItemRow({ it, urgent, now, showSubject = true }: { it: Item; urgent: boolean; now: Date; showSubject?: boolean }) {
  const { route } = useApp();
  const hw = it.kind === 'homework';
  const overdue = hw && !it.done && groupOf(it, now) === 'overdue';
  const meta = [showSubject ? it.subject : '', hw ? itemDueLabel(it, now) : kindLabel(it.kind), it.est_minutes && hw && !it.done ? `约 ${it.est_minutes} 分钟` : ''].filter(Boolean).join(' · ');
  return (
    <div class={`item ${it.done ? 'done' : ''} ${urgent ? 'urgent' : ''} ${route.itemId === it.id ? 'sel' : ''}`}>
      <button class="item-main" onClick={() => openItem(it.id)} aria-label={`${it.title}，${meta}`}>
        <Mark subject={it.subject} hi={urgent} />
        <span class="ib">
          <span class="it">{it.title}</span>
          <span class="im">
            {urgent && <span class="tag">最急</span>}
            {overdue && <span class="tag warn">已过截止</span>}
            {it.hidden && <span class="tag soft">{fmtVisible(it.visible_at)} 才显示</span>}
            {it.pinned && !hw && <span class="tag soft">置顶</span>}
            <span>{meta}</span>
          </span>
        </span>
      </button>
      {hw && (
        <button class={`check ${it.done ? 'on' : ''}`} onClick={() => setDone(it, !it.done)} aria-pressed={it.done} aria-label={it.done ? '取消完成' : '标记完成'}>
          <Check size={16} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}

export function fmtVisible(v: string) {
  const d = parseDate(v.slice(0, 10));
  return d ? `${md(d)} ${v.slice(11, 16)}` : v;
}

export function Toggle({ on, label, sub, onChange, disabled }: { on: boolean; label: string; sub?: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div class="srow2">
      <span class="sl">{label}{sub && <small>{sub}</small>}</span>
      <button class={`sw ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}><i /></button>
    </div>
  );
}

export function Chips<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label?: string }) {
  return (
    <div class="opts" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button type="button" role="radio" aria-checked={v === value} class={`opt ${v === value ? 'on' : ''}`} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

export function Group({ title, extra, children }: { title: string; extra?: string; children: ComponentChildren }) {
  return (
    <section class="group">
      <h3>{title}{extra && <span>{extra}</span>}</h3>
      {children}
    </section>
  );
}

export const Empty = ({ children }: { children: ComponentChildren }) => <div class="empty-note">{children}</div>;
