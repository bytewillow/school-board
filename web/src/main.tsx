import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import { render } from 'preact';
import { App } from './App';
import './styles.css';
import { applyTheme } from './theme';

applyTheme();
render(<App />, document.getElementById('root')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
