import { BookOpen, CalendarDays, ListChecks, UserRound, Plus, WifiOff } from 'lucide-preact';
import { useEffect } from 'preact/hooks';
import { pendingCount } from './api';
import { checkFocus, useFocus } from './focus';
import { boot, navigate, setState, useApp } from './store';
import { AddSheet } from './views/AddSheet';
import { CalendarView } from './views/Calendar';
import { Detail } from './views/Detail';
import { FocusView, FocusPill } from './views/FocusView';
import { Login } from './views/Login';
import { Manage } from './views/Manage';
import { MeView } from './views/Me';
import { Notebooks } from './views/Notebooks';
import { SubjectsView } from './views/Subjects';
import { Today } from './views/Today';

const NAV = [
  { view: 'today', path: '/', label: '今天', Icon: ListChecks },
  { view: 'cal', path: '/calendar', label: '日历', Icon: CalendarDays },
  { view: 'subj', path: '/subjects', label: '科目', Icon: BookOpen },
  { view: 'me', path: '/me', label: '我的', Icon: UserRound },
] as const;

export function App() {
  const s = useApp();
  const focus = useFocus();
  useEffect(() => { boot(); }, []);
  useEffect(() => { checkFocus(); }, [s.boot]);

  // 通知里点“开始专注”会带 ?focus=1 打开作业
  useEffect(() => {
    if (s.boot === 'ready' && s.route.itemId && s.route.params.get('focus') === '1' && s.items.some((i) => i.id === s.route.itemId)) {
      import('./focus').then((f) => { if (!f.getFocus()) f.startFocus(s.route.itemId!); else f.minimize(false); });
      navigate(`/item/${s.route.itemId}`, { replace: true });
    }
  }, [s.boot, s.route, s.items.length]);

  // 旧版的 /register?child=&subject= 链接：打开记作业表单
  useEffect(() => {
    if (s.boot === 'ready' && s.child !== null && location.pathname === '/register') {
      const q = new URLSearchParams(location.search);
      setState({ sheet: { mode: 'add', subject: q.get('subject') || undefined } });
      navigate('/', { replace: true });
    }
  }, [s.boot, s.child]);

  if (s.boot === 'loading') return <div class="splash" aria-busy="true"><span class="logo">作</span></div>;
  if (s.boot === 'error') return <div class="splash err"><span class="logo">作</span><p>{s.bootError}</p><button class="btn p" onClick={() => { setState({ boot: 'loading' }); boot(); }}>重试</button></div>;
  if (!s.me || s.route.view === 'login') return <Login />;
  if (s.route.view === 'manage') return <Manage />;
  if (s.route.view === 'notebooks' || s.child === null) return <Notebooks />;

  const childName = s.me.children.find((c) => c.id === s.child)?.name || '';
  const pending = pendingCount();
  return (
    <div class={`app ${s.route.itemId ? 'show' : ''}`}>
      <nav class="nav" aria-label="主导航">
        <span class="logo" aria-hidden="true">作</span>
        {NAV.map(({ view, path, label, Icon }) => (
          <button class={s.route.view === view ? 'on' : ''} aria-current={s.route.view === view ? 'page' : undefined} onClick={() => navigate(path)}>
            <Icon size={23} strokeWidth={1.9} />{label}
          </button>
        ))}
      </nav>
      <main class="main" id="main">
        {s.me.role === 'parent' && (
          <div class="ctx-bar">
            <span>正在看 <b>{childName}</b> 的本子</span>
            {s.me.children.length > 1 && <button class="lnk" onClick={() => navigate('/notebooks')}>换一本</button>}
            <button class="lnk" onClick={() => navigate('/manage')}>管理</button>
          </div>
        )}
        {(s.offline || pending > 0) && (
          <div class="offline" role="status"><WifiOff size={16} />{s.offline ? `没有网络，显示的是${s.cachedAt ? ' ' + s.cachedAt.slice(11, 16) + ' ' : ''}保存的数据` : ''}{pending ? ` · ${pending} 项改动等联网后同步` : ''}</div>
        )}
        {s.route.view === 'today' && <Today />}
        {s.route.view === 'cal' && <CalendarView />}
        {s.route.view === 'subj' && <SubjectsView />}
        {s.route.view === 'me' && <MeView />}
      </main>
      <button class="fab" aria-label="记作业" onClick={() => setState({ sheet: { mode: 'add' } })}><Plus size={26} strokeWidth={2.2} /></button>
      <aside class="detail" aria-label="作业详情">{s.route.itemId ? <Detail id={s.route.itemId} /> : <div class="detail-empty">点左边的作业，在这里看详情</div>}</aside>
      {s.toast && (
        <div class="toast on" role="status" key={s.toast.id}>
          <span>{s.toast.text}</span>
          {s.toast.action && <button onClick={() => { s.toast!.action!.run(); setState({ toast: null }); }}>{s.toast.action.label}</button>}
        </div>
      )}
      {s.sheet && <AddSheet />}
      {focus && !focus.min && <FocusView />}
      {focus && focus.min && <FocusPill />}
    </div>
  );
}
