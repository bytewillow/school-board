export type Theme = 'system' | 'light' | 'dark';
const mq = matchMedia('(prefers-color-scheme: dark)');
export const getTheme = (): Theme => (localStorage.getItem('sb-theme') as Theme) || 'system';
export const isDark = () => (getTheme() === 'system' ? mq.matches : getTheme() === 'dark');

/** 主题只存在这台设备上（localStorage），默认跟随系统。 */
export function applyTheme(t: Theme = getTheme()) {
  localStorage.setItem('sb-theme', t);
  const dark = t === 'system' ? mq.matches : t === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0E1220' : '#FFFFFF');
}
mq.addEventListener?.('change', () => { if (getTheme() === 'system') applyTheme('system'); });
