import { Moon, Sun, Pin } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { addDays, diffDays, fmtMinutes, groupOf, isHomework, isoDate, itemDueAt, remainingMinutes, urgentId, weekStart, WEEKDAYS, type Group as G } from '../dates';
import { navigate, openItem, setState, useApp } from '../store';
import { applyTheme, isDark } from '../theme';
import { Empty, Group, ItemRow } from '../ui';

const GROUPS: [G, string][] = [['overdue', '已过截止'], ['today', '今天截止'], ['tomorrow', '明天截止'], ['week', '本周稍后'], ['later', '以后'], ['nodate', '没有截止日期']];

export function Today() {
  const s = useApp();
  const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('all');
  const [, setDark] = useState(isDark());
  const now = new Date();
  const me = s.me!;
  const name = me.children.find((c) => c.id === s.child)?.name || '';
  const hw = s.items.filter(isHomework);
  const today = hw.filter((i) => groupOf(i, now) === 'today' || (groupOf(i, now) === 'overdue' && i.due === isoDate(now)));
  const left = today.filter((i) => !i.done);
  const doneN = today.length - left.length;
  const est = left.reduce((a, i) => a + remainingMinutes(i), 0);
  const u = urgentId(s.items, now);
  const pinned = s.items.filter((i) => i.pinned && !i.done && !isHomework(i)).slice(0, 3);
  const fresh = s.items.filter((i) => !isHomework(i) && !i.pinned && diffDays(now, new Date(i.created.replace(' ', 'T'))) <= 3).slice(0, 4);
  const hour = now.getHours();
  const hello = hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';

  const shown = hw.filter((i) => (filter === 'todo' ? !i.done : filter === 'done' ? i.done : true));
  const byGroup = new Map<G, typeof hw>();
  for (const it of shown) {
    const g = groupOf(it, now);
    if (g === 'past' || (g === 'overdue' && it.done)) continue;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(it);
  }
  for (const list of byGroup.values()) list.sort((a, b) => (itemDueAt(a)?.getTime() || 0) - (itemDueAt(b)?.getTime() || 0) || Number(a.done) - Number(b.done));
  const anyLeft = hw.some((i) => !i.done);

  return (
    <div class="view">
      <section class="hero">
        <div class="hello">
          <span>{WEEKDAYS[now.getDay()] && `周${WEEKDAYS[now.getDay()]}`} · {now.getMonth() + 1}月{now.getDate()}日　{name}，{hello}</span>
          <span class="hello-r">
            <button class="theme-btn" aria-label={isDark() ? '切换浅色模式' : '切换深色模式'} onClick={() => { applyTheme(isDark() ? 'light' : 'dark'); setDark(isDark()); }}>
              {isDark() ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button class="avatar" aria-label="我的" onClick={() => navigate('/me')}>{name.slice(-1)}</button>
          </span>
        </div>
        {today.length ? (
          <>
            <div class="big"><b>{left.length}</b><small>项作业<br />今天要交</small></div>
            <div class="prog" role="progressbar" aria-valuemin={0} aria-valuemax={today.length} aria-valuenow={doneN}><i style={{ width: `${(doneN / today.length) * 100}%` }} /></div>
            <div class="prog-label">
              {left.length ? <>已完成 <b>{doneN} / {today.length}</b>{est ? <> · 预计还需 <b>{fmtMinutes(est)}</b></> : null}</> : '今天的作业都写完了，可以休息了'}
            </div>
          </>
        ) : (
          <div class="big calm"><small>今天没有要交的作业{anyLeft ? '，可以提前写写后面的' : ''}</small></div>
        )}
      </section>

      {pinned.length > 0 && (
        <div class="pins">
          {pinned.map((p) => (
            <button class="pin" onClick={() => openItem(p.id)}><Pin size={15} /><span><b>{p.subject}</b> {p.title}</span></button>
          ))}
        </div>
      )}

      <WeekStrip />

      <div class="bar">
        {(['all', 'todo', 'done'] as const).map((f) => (
          <button class={`chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{{ all: '全部', todo: '未完成', done: '已完成' }[f]}</button>
        ))}
        <button class="new-btn" onClick={() => setState({ sheet: { mode: 'add' } })}>+ 记作业</button>
      </div>

      {GROUPS.map(([g, label]) => {
        const list = byGroup.get(g);
        if (!list?.length) return null;
        const todo = list.filter((i) => !i.done).length;
        return (
          <Group title={label} extra={todo ? `${todo} 项未完成` : '都完成了'}>
            <div class="list">{list.map((it) => <ItemRow it={it} urgent={it.id === u} now={now} />)}</div>
          </Group>
        );
      })}
      {!shown.length && (
        <Group title={filter === 'done' ? '已完成' : '作业'}>
          <Empty>{filter === 'done' ? '还没有完成的作业' : hw.length ? '没有未完成的作业' : '还没有作业。点右下角的 + 记下第一项。'}</Empty>
        </Group>
      )}

      {fresh.length > 0 && (
        <Group title="新到的通知和资料">
          <div class="list">{fresh.map((it) => <ItemRow it={it} urgent={false} now={now} />)}</div>
        </Group>
      )}
    </div>
  );
}

function WeekStrip() {
  const { items } = useApp();
  const now = new Date();
  const ws = weekStart(now);
  return (
    <div class="week" role="list" aria-label="本周">
      {Array.from({ length: 7 }, (_, i) => {
        const d = addDays(ws, i), k = isoDate(d), df = diffDays(d, now);
        const n = items.filter((x) => isHomework(x) && x.due === k).length;
        return (
          <button role="listitem" class={`day ${df === 0 ? 'today' : ''} ${df < 0 ? 'past' : ''}`} aria-label={`周${WEEKDAYS[d.getDay()]} ${d.getDate()} 日，${n} 项作业`}
            onClick={() => { setState({ calSel: k }); navigate('/calendar'); }}>
            {WEEKDAYS[d.getDay()]}<b>{d.getDate()}</b>
            <span class="dots">{Array.from({ length: Math.min(n, 3) }, () => <i />)}</span>
          </button>
        );
      })}
    </div>
  );
}
