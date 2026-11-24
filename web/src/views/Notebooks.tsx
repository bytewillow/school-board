import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { dueLabel } from '../dates';
import { navigate, selectChild, setState, showError, useApp } from '../store';

interface Cover { id: number; name: string; undone: number; overdue: number; today: number; next: { title: string; subject: string; due: string; due_time: string } | null }

/** 家长有多个孩子时先选本子：每本显示待办、逾期、今天截止和下一项。 */
export function Notebooks() {
  const s = useApp();
  const [covers, setCovers] = useState<Cover[] | null>(null);
  useEffect(() => { api<{ notebooks: Cover[] }>('/app-api/notebooks').then((r) => setCovers(r.notebooks)).catch(showError); }, []);
  const open = async (id: number, add = false) => {
    await selectChild(id);
    navigate(`/?child=${id}`);
    if (add) setState({ sheet: { mode: 'add' } });
  };
  const now = new Date();
  return (
    <div class="page">
      <header class="page-head"><span class="logo" aria-hidden="true">作</span><h1>选一个本子</h1><button class="lnk" onClick={() => navigate('/manage')}>管理</button></header>
      {!covers ? <p class="empty-note">正在加载…</p> : !covers.length ? (
        <div class="empty-note">还没有孩子的本子。<button class="lnk" onClick={() => navigate('/manage')}>去添加孩子</button></div>
      ) : (
        <div class="covers">
          {covers.map((c) => (
            <article class="cover" style={{ '--spine': `var(--page-spine-${c.id % 6})` } as any}>
              <h2>{c.name}</h2>
              <p class="cover-stat"><b>{c.undone}</b> 项没写完{c.overdue ? <span class="tag warn">{c.overdue} 项已过截止</span> : null}{c.today ? <span class="tag">今天交 {c.today} 项</span> : null}</p>
              <p class="cover-next">{c.next ? `下一项：${c.next.subject} · ${dueLabel(c.next.due, c.next.due_time, now)} · ${c.next.title}` : '暂时没有待办'}</p>
              <div class="cover-act">
                <a class="btn p" href={`/?child=${c.id}`} onClick={(e) => { if (!(e as MouseEvent).metaKey && !(e as MouseEvent).ctrlKey) { e.preventDefault(); open(c.id); } }}>打开本子</a>
                <button class="btn s" onClick={() => open(c.id, true)}>给{c.name}记作业</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {s.child !== null && <p class="center"><button class="lnk" onClick={() => navigate('/')}>回到{s.me?.children.find((x) => x.id === s.child)?.name}的本子</button></p>}
    </div>
  );
}
