import { ChevronLeft, Copy, KeyRound, Trash2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { boot, getState, logout, navigate, showError, toast, useApp } from '../store';

interface Overview {
  children: { id: number; name: string; has_password: boolean; items: number }[];
  shared_items: number; subjects: { name: string; items: number }[];
  token: { env: boolean; created: string }; upcoming_hidden: number;
}

/** 家长管理：一屏放下孩子、学科、API 令牌。每个操作单独保存，失败只影响那一项。 */
export function Manage() {
  const s = useApp();
  const [o, setO] = useState<Overview | null>(null);
  const [newChild, setNewChild] = useState('');
  const [newSubj, setNewSubj] = useState('');
  const [pw, setPw] = useState<Record<number, string>>({});
  const [rename, setRename] = useState<Record<number, string>>({});
  const [token, setToken] = useState('');
  const load = () => api<Overview>('/app-api/admin/overview').then(setO).catch(showError);
  useEffect(() => { if (s.me?.role === 'parent') load(); }, [s.me]);

  if (s.me?.role !== 'parent') {
    return (
      <div class="page">
        <header class="page-head"><button class="lnk" onClick={() => navigate('/')}><ChevronLeft size={18} />回首页</button><h1>管理</h1></header>
        <p class="empty-note">只有家长能打开管理。<button class="lnk" onClick={logout}>换家长登录</button></p>
      </div>
    );
  }
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); await load(); await boot(); } catch (e) { showError(e); }
  };
  const back = () => navigate(getState().child !== null ? '/' : '/notebooks');

  return (
    <div class="page">
      <header class="page-head">
        <button class="lnk" onClick={back}><ChevronLeft size={18} />{getState().child !== null ? '回本子' : '选本子'}</button>
        <h1>管理</h1>
        <button class="lnk" onClick={logout}>退出</button>
      </header>
      {!o ? <p class="empty-note">正在加载…</p> : (
        <div class="manage">
          <p class="summary">{o.children.length} 个孩子 · {o.subjects.length} 个学科{o.shared_items ? ` · ${o.shared_items} 条共享内容` : ''}{o.upcoming_hidden ? ` · ${o.upcoming_hidden} 条定时显示中` : ''}</p>
          <section class="group">
            <h3>孩子<span>设了密码才能登录</span></h3>
            <div class="list">
              {o.children.map((c) => (
                <div class="mrow">
                  <div class="mrow-h">
                    <input class="fin sm" value={rename[c.id] ?? c.name} aria-label={`${c.name}的名字`} onInput={(e) => setRename({ ...rename, [c.id]: (e.target as HTMLInputElement).value })} />
                    {(rename[c.id] ?? c.name) !== c.name && <button class="opt sm" onClick={() => act(() => api(`/app-api/admin/children/${c.id}`, { method: 'PATCH', json: { name: rename[c.id] } }), '名字改好了')}>改名</button>}
                    <span class={`tag ${c.has_password ? 'soft' : 'warn'}`}>{c.has_password ? '已设密码' : '未设密码'}</span>
                  </div>
                  <div class="mrow-b">
                    <input class="fin sm" type="password" autocomplete="new-password" placeholder="新密码，至少 6 位" value={pw[c.id] || ''} onInput={(e) => setPw({ ...pw, [c.id]: (e.target as HTMLInputElement).value })} aria-label={`${c.name}的新密码`} />
                    <button class="opt sm" disabled={(pw[c.id] || '').length < 6} onClick={() => act(async () => { await api(`/app-api/admin/children/${c.id}`, { method: 'PATCH', json: { password: pw[c.id] } }); setPw({ ...pw, [c.id]: '' }); }, '密码已更新，旧的登录已失效')}><KeyRound size={14} />设密码</button>
                    {c.has_password && <button class="opt sm" onClick={() => confirm(`清除${c.name}的密码？清除后${c.name}无法登录。`) && act(() => api(`/app-api/admin/children/${c.id}`, { method: 'PATCH', json: { clearPassword: true } }), '密码已清除')}>清除</button>}
                    <button class="x" aria-label={`删除${c.name}`} onClick={() => confirm(`删除${c.name}？${c.items ? `TA 的 ${c.items} 条内容会变成共享，不会删除。` : ''}`) && act(() => api(`/app-api/admin/children/${c.id}`, { method: 'DELETE' }), '已删除')}><Trash2 size={17} /></button>
                  </div>
                </div>
              ))}
              <form class="mrow add" onSubmit={(e) => { e.preventDefault(); if (newChild.trim()) act(async () => { await api('/app-api/admin/children', { json: { name: newChild.trim() } }); setNewChild(''); }, '加好了，记得给 TA 设密码'); }}>
                <input class="fin sm" placeholder="孩子的名字" value={newChild} onInput={(e) => setNewChild((e.target as HTMLInputElement).value)} aria-label="新孩子的名字" />
                <button class="opt sm" disabled={!newChild.trim()}>加一个孩子</button>
              </form>
            </div>
          </section>

          <section class="group">
            <h3>学科<span>有内容的学科不能删</span></h3>
            <div class="list chips-box">
              {o.subjects.map((sub) => (
                <span class="subj-chip">{sub.name}<small>{sub.items}</small>
                  {!sub.items && <button aria-label={`删除${sub.name}`} onClick={() => act(() => api(`/app-api/admin/subjects/${encodeURIComponent(sub.name)}`, { method: 'DELETE' }), '已删除')}><Trash2 size={13} /></button>}
                </span>
              ))}
              <form class="mrow add" onSubmit={(e) => { e.preventDefault(); if (newSubj.trim()) act(async () => { await api('/app-api/admin/subjects', { json: { name: newSubj.trim() } }); setNewSubj(''); }, '学科加好了'); }}>
                <input class="fin sm" placeholder="新学科" value={newSubj} onInput={(e) => setNewSubj((e.target as HTMLInputElement).value)} aria-label="新学科" />
                <button class="opt sm" disabled={!newSubj.trim()}>添加</button>
              </form>
            </div>
          </section>

          <section class="group">
            <h3>API 令牌<span>给外部 AI 用</span></h3>
            <div class="list pad">
              <p class="hint">环境变量令牌：{o.token.env ? '已配置' : '未配置'}；管理页生成的令牌：{o.token.created ? `已生成（${o.token.created.replace('T', ' ')}）` : '未生成'}。
                令牌只能查列表、读可见内容、新建条目，不能删除或管理孩子、学科。生成新令牌会让旧的失效（环境变量令牌不受影响）。{!o.token.env && !o.token.created ? ' 现在没有任何令牌，/api/lists 和 /api/items 对局域网开放，公网访问前一定要先生成。' : ''}</p>
              {token && (
                <div class="token">
                  <code>{token}</code>
                  <button class="opt sm" onClick={() => navigator.clipboard?.writeText(token).then(() => toast('已复制'))}><Copy size={14} />复制</button>
                  <p class="hint">只显示这一次，刷新就看不到了。丢了就重新生成。</p>
                </div>
              )}
              <div class="opts">
                <button class="opt sm" onClick={() => act(async () => { const r = await api<{ token: string }>('/app-api/admin/token', { json: {} }); setToken(r.token); }, '新令牌已生成')}>生成新令牌</button>
                {o.token.created && <button class="opt sm" onClick={() => confirm('吊销后，用这个令牌的 AI 都会连不上。确定吗？') && act(async () => { await api('/app-api/admin/token', { method: 'DELETE' }); setToken(''); }, '已吊销')}>吊销</button>}
              </div>
              <details class="paste">
                <summary>给 AI 的配置</summary>
                <pre>{`GET  https://你的地址/api/lists
POST https://你的地址/api/items
Header: X-API-Token: <令牌>
表单字段：subject（和 lists 里完全一致）、child_id、title、kind、body、due(YYYY-MM-DD)、file（可选）
可选扩展：due_time(HH:MM)、est_minutes、steps（JSON 数组）`}</pre>
                <p class="hint">完整说明见仓库里的 SKILL.md。</p>
              </details>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
