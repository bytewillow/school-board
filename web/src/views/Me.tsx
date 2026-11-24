import { BellRing, ChevronRight, Download, LogOut, Settings, Smartphone } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { addDays, fmtMinutes, isoDate, md, parseDate, weekStart, WEEKDAYS } from '../dates';
import { disablePush, enablePush, isIOS, pushState, type PushState } from '../push';
import { logout, navigate, savePrefs, showError, toast, useApp } from '../store';
import { applyTheme, getTheme, type Theme } from '../theme';
import { Chips, Group, Toggle } from '../ui';

export function MeView() {
  const s = useApp();
  const me = s.me!;
  const st = s.stats;
  const p = s.prefs;
  const name = me.children.find((c) => c.id === s.child)?.name || '';
  const now = new Date();
  const ws = weekStart(now);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [push, setPush] = useState<PushState | 'busy'>('busy');
  useEffect(() => { pushState().then(setPush).catch(() => setPush('unsupported')); }, [s.child]);

  const total = st ? st.week.reduce((a, w) => a + (w.minutes || 0), 0) : 0;
  const max = Math.max(60, ...(st?.week.map((w) => w.minutes || 0) || [0]));
  const cmp = st ? (total >= st.prevSameSpan ? `比上周同期多 ${fmtMinutes(total - st.prevSameSpan)}` : `比上周同期少 ${fmtMinutes(st.prevSameSpan - total)}`) : '';
  const lastLate = st?.lastLate ? parseDate(st.lastLate) : null;

  const togglePush = async () => {
    setPush('busy');
    try { setPush(push === 'on' ? await disablePush() : await enablePush()); } catch (e) { showError(e); setPush(await pushState()); }
  };
  const test = async (kind: 'due' | 'daily') => {
    try { await api('/app-api/push/test', { json: { kind, child_id: s.child } }); toast('已发送，几秒内会收到'); } catch (e) { showError(e); }
  };

  return (
    <div class="view">
      <section class="vhead mehead">
        <div class="who"><span class="avatar lg">{name.slice(-1)}</span><span><b>{name}</b><small>{me.role === 'parent' ? '家长在看' : '学生'}</small></span></div>
        {st && (
          <>
            <div class="streak"><b>{st.streak}</b><span>天<br />连续按时交完作业</span></div>
            <p>{st.streak >= 5 ? `保持住，下一个目标是 ${Math.ceil((st.streak + 1) / 10) * 10} 天。` : st.streak ? '继续保持。' : '今天写完就能开始记录。'}{lastLate ? `上次迟交是 ${md(lastLate)}（周${WEEKDAYS[lastLate.getDay()]}）。` : ''}没有作业的日子不算，也不会打断记录。</p>
          </>
        )}
      </section>

      {st && (
        <>
          <Group title="最近 4 周" extra={st.onTimeRate === null ? '' : `按时率 ${st.onTimeRate}%`}>
            <div class="hmap">
              <div class="hm-w" aria-hidden="true">{'一二三四五六日'.split('').map((x) => <span>{x}</span>)}</div>
              <div class="hm-g">
                {st.days.map((d) => {
                  const dt = parseDate(d.date)!;
                  const label = { ok: '按时交完', late: '有作业迟交', none: '没有作业', today: '今天还没写完', future: '还没到' }[d.status];
                  return <span class={`hm ${d.status}`} title={`${md(dt)} · ${label}`} aria-label={`${md(dt)} ${label}`}>{d.date === isoDate(now) ? '今' : ''}</span>;
                })}
              </div>
              <div class="legend"><span><i class="ok" />按时交完</span><span><i class="late" />有迟交</span><span><i class="none" />没有作业</span></div>
            </div>
          </Group>
          <Group title="本周" extra={`${md(ws)}–${addDays(ws, 6).getDate()}日`}>
            <div class="list wkbox">
              <div class="wkstat">
                <div><b>{st.weekDone}<small>/{st.weekTotal}</small></b><span>项作业已完成</span></div>
                <div><b>{Math.floor(total / 60) ? <>{Math.floor(total / 60)}<small>小时</small></> : null}{total % 60}<small>分</small></b><span>专注用时</span></div>
              </div>
              <p class="wkline">{total ? `本周专注 ${fmtMinutes(total)}，${cmp}` : '本周还没有用过专注计时'}</p>
              <div class="bars">
                {st.week.map((w) => {
                  const d = parseDate(w.date)!, isToday = w.date === isoDate(now);
                  return (
                    <div class={`bc ${isToday ? 'today' : ''} ${w.minutes === null ? 'fut' : ''}`}>
                      <span class="bv">{w.minutes || ''}</span>
                      <span class="bt"><i style={{ height: `${w.minutes ? Math.max(4, (w.minutes / max) * 100) : 0}%` }} /></span>
                      <span class="bw">{WEEKDAYS[d.getDay()]}</span>
                    </div>
                  );
                })}
              </div>
              <p class="src">单位：分钟，只统计用专注计时写作业的时间。</p>
            </div>
          </Group>
        </>
      )}

      <Group title="提醒">
        <div class="list">
          <div class="srow2">
            <span class="sl">在这台设备上接收提醒<small>{{
              busy: '正在检查…', on: '已打开。截止提醒、每日提醒和专注结束都会推送到这里', off: '打开后，没打开 App 也能收到提醒',
              denied: '通知权限被关掉了，请到系统设置里允许“作业簿”发通知', unsupported: '这个浏览器不支持推送提醒',
              'needs-install': '先在 Safari 里点“分享 → 添加到主屏幕”，从主屏幕打开后才能接收提醒',
            }[push]}</small></span>
            {['on', 'off'].includes(push) && <button class={`sw ${push === 'on' ? 'on' : ''}`} role="switch" aria-checked={push === 'on'} aria-label="接收提醒" onClick={togglePush}><i /></button>}
          </div>
          {push === 'on' && (
            <div class="srow-sub"><button class="opt sm" onClick={() => test('due')}><BellRing size={14} />试一条截止提醒</button><button class="opt sm" onClick={() => test('daily')}>试一条每日提醒</button></div>
          )}
          <Toggle on={p.remind} label={`截止前 ${p.before / 60} 小时提醒`} sub="早上交的作业改在前一晚 21:00 提醒" onChange={(v) => savePrefs({ remind: v })} />
          {p.remind && <div class="srow-sub"><Chips value={p.before} options={[[60, '1 小时前'], [120, '2 小时前'], [180, '3 小时前']]} onChange={(v) => savePrefs({ before: v })} label="提前多久" /></div>}
          <Toggle on={p.daily} label={`每天 ${p.dailyAt} 提醒写作业`} sub="告诉你今晚有几项、先写哪项；没有作业就不打扰" onChange={(v) => savePrefs({ daily: v })} />
          {p.daily && <div class="srow-sub"><Chips value={p.dailyAt} options={[['16:30', '16:30'], ['17:30', '17:30'], ['18:30', '18:30'], ['19:30', '19:30']]} onChange={(v) => savePrefs({ dailyAt: v })} label="每日提醒时间" /></div>}
          <Toggle on={p.lockDetail} label="通知里显示作业内容" sub="关掉后只显示“有作业快截止”，锁屏上别人看不到是什么作业" onChange={(v) => savePrefs({ lockDetail: v })} />
        </div>
      </Group>

      <Group title="专注">
        <div class="list">
          <div class="srow2 has-sub"><span class="sl">专注时长<small>每次结束后可以选择休息</small></span></div>
          <div class="srow-sub"><Chips value={p.focus} options={[[15, '15 分钟'], [25, '25 分钟'], [40, '40 分钟']]} onChange={(v) => savePrefs({ focus: v })} label="专注时长" /></div>
          <div class="srow2 has-sub"><span class="sl">休息时长</span></div>
          <div class="srow-sub"><Chips value={p.rest} options={[[5, '5 分钟'], [10, '10 分钟']]} onChange={(v) => savePrefs({ rest: v })} label="休息时长" /></div>
        </div>
      </Group>

      <Group title="这台设备">
        <div class="list">
          <div class="srow2 has-sub"><span class="sl">外观<small>只影响这台设备</small></span></div>
          <div class="srow-sub"><Chips value={theme} options={[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]} onChange={(v) => { setTheme(v); applyTheme(v); }} label="外观" /></div>
          {isIOS() && push === 'needs-install' && (
            <div class="srow2"><span class="sl"><Smartphone size={16} /> 装到主屏幕<small>Safari 底部点“分享”按钮，选“添加到主屏幕”。装好后可以离线查看、接收提醒、在图标上显示没写完的数量。</small></span></div>
          )}
          {me.role === 'parent' && (
            <>
              <button class="srow2 link" onClick={() => navigate('/manage')}><span class="sl"><Settings size={16} /> 管理<small>孩子、密码、学科、API 令牌</small></span><ChevronRight size={18} /></button>
              <a class="srow2 link" href="/app-api/admin/export" download><span class="sl"><Download size={16} /> 导出备份<small>全部作业和设置，JSON 文件（附件请备份 data/uploads 目录）</small></span><ChevronRight size={18} /></a>
            </>
          )}
          <button class="srow2 link" onClick={logout}><span class="sl"><LogOut size={16} /> 退出登录<small>会清掉这台设备上保存的作业数据</small></span></button>
        </div>
      </Group>
      <p class="ver">作业簿 2.0</p>
    </div>
  );
}
