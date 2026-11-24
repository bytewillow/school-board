import { ChevronLeft, Search } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { addDays, fmtMinutes, isHomework, itemDueAt, itemDueLabel, md, parseDate, urgentId, weekStart } from '../dates';
import { navigate, useApp } from '../store';
import type { Item } from '../types';
import { Empty, Group, ItemRow, Mark } from '../ui';

export function SubjectsView() {
  const s = useApp();
  const [q, setQ] = useState('');
  const now = new Date();
  const u = urgentId(s.items, now);
  if (s.route.subject) return <SubjectDetail name={s.route.subject} />;

  const ws = weekStart(now), we = addDays(ws, 7);
  const inWeek = (i: Item) => { const d = parseDate(i.due); return !!d && d >= ws && d < we; };
  const names = [...new Set([...s.me!.subjects, ...s.items.map((i) => i.subject)])];
  const rows = names.map((n) => {
    const its = s.items.filter((i) => i.subject === n);
    const wk = its.filter((i) => isHomework(i) && inWeek(i));
    const next = its.filter((i) => isHomework(i) && !i.done && itemDueAt(i) && itemDueAt(i)! >= now).sort((a, b) => itemDueAt(a)!.getTime() - itemDueAt(b)!.getTime())[0];
    return { n, its, wk, min: wk.reduce((a, i) => a + (i.est_minutes || 0), 0), todo: its.filter((i) => isHomework(i) && !i.done).length, next };
  }).filter((r) => r.its.length || s.me!.subjects.includes(r.n))
    .sort((a, b) => b.min - a.min || b.wk.length - a.wk.length || b.todo - a.todo);
  const max = Math.max(1, ...rows.map((r) => r.min || r.wk.length));
  const top = rows[0];
  const head = top && top.min ? `本周${top.n}最花时间：约 ${fmtMinutes(top.min)}` : top && top.wk.length ? `本周${top.n}的作业最多：${top.wk.length} 项` : '这周还没有作业';

  const query = q.trim().toLowerCase();
  const hits = query ? s.items.filter((i) => `${i.title} ${i.body} ${i.filename}`.toLowerCase().includes(query)).slice(0, 50) : [];

  return (
    <div class="view">
      <section class="vhead">
        <span class="k">本周 {md(ws)}–{addDays(ws, 6).getDate()}日</span>
        <h2>{head}</h2>
        <label class="search"><Search size={17} /><input type="search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="搜作业、通知、附件名" aria-label="搜索" /></label>
      </section>
      {query ? (
        <Group title="搜索结果" extra={`${hits.length} 项`}>
          {hits.length ? <div class="list">{hits.map((it) => <ItemRow it={it} urgent={it.id === u} now={now} />)}</div> : <Empty>没有找到“{q}”</Empty>}
        </Group>
      ) : (
        <Group title="按本周用时排序" extra="点科目看全部内容">
          <div class="list">
            {rows.map((r, i) => (
              <button class={`srow ${i === 0 && (r.min || r.wk.length) ? 'top' : ''}`} onClick={() => navigate(`/subjects/${encodeURIComponent(r.n)}`)}>
                <Mark subject={r.n} hi={!!r.next && r.next.id === u} />
                <span class="sb">
                  <span class="sname">{r.n}<small>{r.todo ? `${r.todo} 项未完成` : '没有未完成'}</small></span>
                  <span class="snext">{r.next ? `下一项：${itemDueLabel(r.next, now)} · ${r.next.title}` : '暂时没有新作业'}</span>
                </span>
                <span class="scount">{r.wk.filter((x) => x.done).length}/{r.wk.length}<small>本周完成</small></span>
                <span class="sbar"><i style={{ width: `${((r.min || r.wk.length) / max) * 100}%` }} /></span>
                <span class="smin">{r.min ? fmtMinutes(r.min) : `${r.wk.length} 项`}</span>
              </button>
            ))}
          </div>
        </Group>
      )}
    </div>
  );
}

function SubjectDetail({ name }: { name: string }) {
  const s = useApp();
  const now = new Date();
  const u = urgentId(s.items, now);
  const its = s.items.filter((i) => i.subject === name);
  const byDue = (a: Item, b: Item) => (itemDueAt(a)?.getTime() ?? Infinity) - (itemDueAt(b)?.getTime() ?? Infinity);
  const todo = its.filter((i) => isHomework(i) && !i.done).sort(byDue);
  const other = its.filter((i) => !isHomework(i));
  const done = its.filter((i) => isHomework(i) && i.done).sort((a, b) => (b.done_at || b.due).localeCompare(a.done_at || a.due));
  const ws = weekStart(now), we = addDays(ws, 7);
  const wk = its.filter((i) => isHomework(i) && parseDate(i.due) && parseDate(i.due)! >= ws && parseDate(i.due)! < we);
  const focus = its.reduce((a, i) => a + i.focus_minutes, 0);
  return (
    <div class="view">
      <section class="vhead">
        <button class="vback" onClick={() => navigate('/subjects')}><ChevronLeft size={20} />科目</button>
        <div class="shead">
          <Mark subject={name} size="lg" />
          <div><h2>{name}</h2><p>本周 {wk.length} 项，已完成 {wk.filter((i) => i.done).length} 项{focus ? `，累计专注 ${fmtMinutes(focus)}` : ''}</p></div>
        </div>
      </section>
      {todo.length > 0 && <Group title="未完成" extra={`${todo.length} 项`}><div class="list">{todo.map((it) => <ItemRow it={it} urgent={it.id === u} now={now} showSubject={false} />)}</div></Group>}
      {other.length > 0 && <Group title="通知和资料" extra={`${other.length} 项`}><div class="list">{other.map((it) => <ItemRow it={it} urgent={false} now={now} showSubject={false} />)}</div></Group>}
      {done.length > 0 && <Group title="已完成" extra={`${done.length} 项`}><div class="list">{done.slice(0, 30).map((it) => <ItemRow it={it} urgent={false} now={now} showSubject={false} />)}</div></Group>}
      {!its.length && <Group title="内容"><Empty>{name}还没有内容</Empty></Group>}
    </div>
  );
}
