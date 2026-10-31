/* Original, dependency-free focus clock. No network calls or demo data. */
(() => {
  'use strict';
  document.querySelectorAll('[data-focus-timer]').forEach(box => {
    const display = box.querySelector('.focus-time');
    const arc = box.querySelector('.focus-arc');
    const status = box.querySelector('.focus-status');
    const toggle = box.querySelector('.focus-toggle');
    const reset = box.querySelector('.focus-reset');
    const presets = [...box.querySelectorAll('[data-minutes]')];
    const key = 'school-board-focus-v1-' + box.dataset.child;
    let duration = 25 * 60, remaining = duration, deadline = null, lastShown = null;
    // Timer-only state, scoped by notebook. Storage can be disabled in private browsing.
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (saved && [900, 1500, 2700].includes(saved.duration) &&
          Number.isFinite(saved.remaining) && saved.remaining >= 0 && saved.remaining <= saved.duration &&
          (saved.deadline === null || (Number.isFinite(saved.deadline) && saved.deadline <= Date.now() + saved.duration * 1000))) {
        ({duration, remaining, deadline} = saved);
      }
    } catch (_) { /* The clock also works without storage. */ }
    function save() {
      try { sessionStorage.setItem(key, JSON.stringify({duration, remaining, deadline})); } catch (_) { /* optional */ }
    }
    function draw() {
      const seconds = Math.ceil(remaining);
      if (seconds !== lastShown) {
        display.textContent = Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + (seconds % 60).toString().padStart(2, '0');
        lastShown = seconds;
      }
      arc.style.strokeDashoffset = String(100 * remaining / duration);
      box.dataset.running = String(deadline !== null);
      toggle.textContent = deadline !== null ? '暂停' : remaining === 0 ? '再专注一轮' : remaining === duration ? '开始专注' : '继续专注';
      toggle.setAttribute('aria-pressed', String(deadline !== null));
      presets.forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) * 60 === duration)));
    }
    function tick() {
      if (deadline !== null) {
        // Deadline rather than counting interval callbacks: background-tab throttling does not slow the clock.
        remaining = Math.max(0, (deadline - Date.now()) / 1000);
        if (remaining === 0) { deadline = null; status.textContent = '时间到，休息一下吧'; save(); }
      }
      draw();
    }
    presets.forEach(button => button.addEventListener('click', () => {
      duration = Number(button.dataset.minutes) * 60;
      remaining = duration;
      deadline = null;
      status.textContent = '已设为 ' + button.dataset.minutes + ' 分钟，准备好了就开始';
      save(); draw();
    }));
    toggle.addEventListener('click', () => {
      tick();
      if (deadline !== null) {
        deadline = null;
        status.textContent = '已暂停，随时可以继续';
      } else {
        if (remaining === 0) remaining = duration;
        deadline = Date.now() + remaining * 1000;
        status.textContent = '正在专注，慢慢来';
      }
      save(); draw();
    });
    reset.addEventListener('click', () => {
      remaining = duration; deadline = null;
      status.textContent = '已重置，准备好了就开始';
      save(); draw();
    });
    toggle.disabled = reset.disabled = false;
    if (deadline !== null) status.textContent = '正在专注，慢慢来';
    else if (remaining < duration && remaining > 0) status.textContent = '已暂停，随时可以继续';
    tick();
    setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('pagehide', () => { tick(); save(); });
    window.addEventListener('pageshow', tick);
  });
})();
