import { ChevronLeft, ChevronRight } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { addDays, fmtMinutes, isHomework, isoDate, md, parseDate, remainingMinutes, urgentId, weekStart, weekdayName, dayLabel } from '../dates';
import { setState, useApp } from '../store';
import { Empty, Group, ItemRow } from '../ui';

export function CalendarView() {
  const s = useApp();
  const now = new Date();
  const sel = s.calSel || isoDate(now);
  const selDate = parseDate(sel)!;
  const [ym, setYm] = useState<[number, number]>([selDate.getFullYear(), selDate.getMonth()]);
  const [y, m] = ym;
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const tk = isoDate(now);
  const hw = s.items.filter(isHomework);
  const u = urgentId(s.items, now);

  const ws = weekStart(now), we = addDays(ws, 7);
  const weekLeft = hw.filter((i) => !i.done && i.due && parseDate(i.due)! >= ws && parseDate(i.due)! < we && i.due >= tk);
  const byDay = new Map<string, number>();
  weekLeft.forEach((i) => byDay.set(i.due, (byDay.get(i.due) || 0) + 1));
  const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const head = weekLeft.length ? `这周还剩 ${weekLeft.length} 项，${dayLabel(parseDate(busiest[0])!, now)}最多` : '这周的作业都写完了';

  const list = s.items.filter((i) => i.due === sel).sort((a, b) => Number(a.done) - Number(b.done) || a.due_time.localeCompare(b.due_time));
  const rest = list.filter((i) => isHomework(i) && !i.done).reduce((a, i) => a + remainingMinutes(i), 0);
  const move = (d: number) => setYm(([yy, mm]) => (mm + d < 0 ? [yy - 1, 11] : mm + d > 11 ? [yy + 1, 0] : [yy, mm + d]));

  return (
    <div class="view">
      <section class="vhead">
        <div class="mhead">
          <span class="k">{y}年{m + 1}月</span>
          <span class="mnav">
            <button onClick={() => move(-1)} aria-label="上个月"><ChevronLeft size={18} /></button>
            <button onClick={() => move(1)} aria-label="下个月"><ChevronRight size={18} /></button>
          </span>
        </div>
        <h2>{head}</h2>
        <p>点日期看当天要交的作业，圆点越多，那天越忙。</p>
      </section>
      <div class="cal">
        <div class="cal-w" aria-hidden="true">{'一二三四五六日'.split('').map((x) => <span>{x}</span>)}</div>
        <div class="cal-g">
          {Array.from({ length: offset }, () => <span class="cd empty" />)}
          {Array.from({ length: days }, (_, i) => {
            const d = new Date(y, m, i + 1), k = isoDate(d);
            const its = hw.filter((x) => x.due === k).sort((a, b) => Number(a.done) - Number(b.done));
            return (
              <button class={`cd ${k === tk ? 'today' : ''} ${k < tk ? 'past' : ''} ${k === sel ? 'sel' : ''}`} aria-pressed={k === sel}
                aria-label={`${md(d)}，${its.length} 项作业`} onClick={() => setState({ calSel: k })}>
                {i + 1}
                <span class="dots">{its.slice(0, 3).map((x) => <i class={x.done ? 'd' : ''} />)}</span>
              </button>
            );
          })}
        </div>
        <div class="legend"><span><i />未完成</span><span><i class="d" />已完成</span></div>
      </div>
      <Group title={`${md(selDate)} ${weekdayName(selDate)}`} extra={list.length ? `${list.length} 项 · ${rest ? '还需约 ' + fmtMinutes(rest) : '都完成了'}` : ''}>
        {list.length ? <div class="list">{list.map((it) => <ItemRow it={it} urgent={it.id === u} now={now} />)}</div> : <Empty>这天没有要交的作业</Empty>}
      </Group>
    </div>
  );
}
