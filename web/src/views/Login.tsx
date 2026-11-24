import { useState } from 'preact/hooks';
import { api, ApiError } from '../api';

export function Login() {
  const [as, setAs] = useState<'child' | 'parent'>(new URLSearchParams(location.search).get('as') === 'parent' ? 'parent' : 'child');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      await api(as === 'parent' ? '/app-api/admin-login' : '/app-api/login', { json: as === 'parent' ? { password: pw } : { name: name.trim(), password: pw } });
      location.href = '/';
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : '连不上服务器，请检查网络');
      setBusy(false);
    }
  };
  return (
    <div class="login">
      <form class="login-card" onSubmit={submit}>
        <span class="logo lg" aria-hidden="true">作</span>
        <h1>作业簿</h1>
        <p>打开就知道今晚先写哪一项。</p>
        <div class="seg" role="tablist">
          <button type="button" role="tab" aria-selected={as === 'child'} class={as === 'child' ? 'on' : ''} onClick={() => { setAs('child'); setMsg(''); }}>我是学生</button>
          <button type="button" role="tab" aria-selected={as === 'parent'} class={as === 'parent' ? 'on' : ''} onClick={() => { setAs('parent'); setMsg(''); }}>我是家长</button>
        </div>
        {as === 'child' && (
          <><label class="fl" for="ln">名字</label>
            <input id="ln" class="fin" autocomplete="username" required value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></>
        )}
        <label class="fl" for="lp">{as === 'parent' ? '管理密码' : '密码'}</label>
        <input id="lp" class="fin" type="password" autocomplete="current-password" required value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        {msg && <p class="login-err" role="alert">{msg}</p>}
        <button class="btn p" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
        {as === 'child' && <p class="hint">还没有密码？请家长在“管理”里给你设一个。</p>}
      </form>
    </div>
  );
}
