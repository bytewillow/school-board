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
      box.dataset.finished = String(remaining === 0);
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

// Deadline controls enhance ordinary forms; list date updates also work without JS.
document.querySelectorAll('[data-due-shortcuts]').forEach(group => { group.hidden = false; });
document.querySelectorAll('[data-due-target]').forEach(button => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.dueTarget);
    if (input) {
      input.value = button.dataset.dueValue;
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }
  });
});
document.querySelectorAll('[data-notebook-return]').forEach(input => {
  input.value = window.location.pathname + window.location.search;
});

// The date label is the disclosure. Choosing a date submits the same authorized POST.
document.querySelectorAll('.quick-due').forEach(details => {
  details.classList.add('js-quick-due');
  const form = details.querySelector('form');
  const input = form.querySelector('[data-auto-due]');
  if (typeof form.requestSubmit === 'function') {
    form.classList.add('js-due');
    input.addEventListener('change', () => {
      if (input.checkValidity()) form.requestSubmit(form.querySelector('.due-save'));
    });
  }
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    document.querySelectorAll('.quick-due[open]').forEach(other => { if (other !== details) other.open = false; });
    // Anchor to the viewport: detail-page metadata can reflow when its disclosure opens.
    form.style.position = 'fixed';
    form.style.left = '12px';
    const anchor = details.querySelector('summary').getBoundingClientRect();
    const bounds = form.getBoundingClientRect();
    form.style.left = Math.max(12, Math.min(anchor.left, innerWidth - 12 - bounds.width)) + 'px';
    form.style.top = Math.max(12, Math.min(anchor.bottom + 4, innerHeight - 12 - bounds.height)) + 'px';
  });
  details.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); details.open = false; details.querySelector('summary').focus(); }
  });
});
// Close rather than leave a detached date picker behind while the page moves.
window.addEventListener('resize', () => document.querySelectorAll('.quick-due[open]').forEach(d => { d.open = false; }));
window.addEventListener('scroll', () => document.querySelectorAll('.quick-due[open]').forEach(d => { d.open = false; }), {passive:true});
document.addEventListener('click', event => {
  document.querySelectorAll('.quick-due[open]').forEach(details => {
    if (!details.contains(event.target)) details.open = false;
  });
});

// Reuse the server's permission-checked edit form. No parallel write API or optimistic save.
// Explicit Modify opens the editor; titles always navigate to details, including without JS.
if (typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal === 'function' && typeof window.fetch === 'function') {
  document.querySelectorAll('.item-edit[data-item-detail]').forEach(link => {
    link.addEventListener('click', async event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      if (link.dataset.loading) return;
      link.dataset.loading = '1';
      link.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch(link.href, {credentials: 'same-origin'});
        if (!response.ok) throw new Error('edit unavailable');
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const form = doc.querySelector('form[action="/item/edit"]');
        if (!form) throw new Error('session or permissions changed');
        const dialog = document.createElement('dialog');
        dialog.className = 'item-edit-dialog';
        dialog.setAttribute('aria-label', '修改作业');
        const header = document.createElement('header');
        const heading = document.createElement('h2'); heading.textContent = '修改作业';
        const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '取消修改');
        header.append(heading, close); dialog.append(header);
        // Keep the title, body, subject and deadline close; move infrequent fields into a disclosure.
        const fieldGroup = document.createElement('div'); fieldGroup.className = 'edit-fields';
        const extra = document.createElement('details'); extra.className = 'edit-extra';
        const summary = document.createElement('summary'); summary.textContent = '更多设置'; extra.append(summary);
        for (const id of ['edit-subject', 'edit-due']) {
          const field = form.querySelector('#' + id); const label = form.querySelector('label[for="' + id + '"]');
          const wrapper = document.createElement('div'); wrapper.append(label, field); fieldGroup.append(wrapper);
        }
        const bodyField = form.querySelector('#edit-body'); bodyField.after(fieldGroup);
        for (const id of ['edit-kind', 'edit-link', 'edit-visible']) {
          extra.append(form.querySelector('label[for="' + id + '"]'), form.querySelector('#' + id));
        }
        const pinned = form.querySelector('input[name=pinned]'); if (pinned) extra.append(pinned.closest('label'));
        form.querySelectorAll('[data-due-shortcuts]').forEach(group => group.remove());
        const save = form.querySelector('button.full'); save.before(extra);
        form.querySelector('input[name=return_to]').value = location.pathname + location.search;
        form.addEventListener('submit', event => {
          if (form.dataset.submitting) { event.preventDefault(); return; }
          form.dataset.submitting = '1'; save.textContent = '保存中…';
        });
        dialog.append(form); document.body.append(dialog);
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => { dialog.remove(); link.focus(); }, {once:true});
        dialog.showModal();
        form.querySelector('#edit-title').focus({preventScroll:true});
      } catch (_) { location.assign(link.href); }
      finally { delete link.dataset.loading; link.removeAttribute('aria-busy'); }
    });
  });
}

// Check on open/resume. Never replace a page with unsaved work automatically.
if ('serviceWorker' in navigator) {
  let registration;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'}).then(reg => {
    registration = reg;
    return reg.update();
  }).catch(() => { /* Network unavailable: keep current page usable. */ });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || document.querySelector('.pwa-update')) return;
    const notice = document.createElement('div'); notice.className = 'pwa-update';
    notice.setAttribute('role', 'status');
    notice.append('新版已就绪，保存当前修改后可刷新。');
    const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '刷新';
    refresh.addEventListener('click', () => location.reload()); notice.append(refresh);
    document.body.append(notice);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && registration) registration.update().catch(() => {});
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && registration) registration.update().catch(() => {});
  });
}

// Only a confirmed server completion can create the one-shot celebration receipt.
(() => {
  const receiptKey = 'school-board-celebrate';
  try {
    const at = Number(sessionStorage.getItem(receiptKey));
    sessionStorage.removeItem(receiptKey);
    if (at && Date.now() - at >= 0 && Date.now() - at < 15000) {
      const layer = document.createElement('div'); layer.className = 'completion-celebration';
      const status = document.createElement('div'); status.className = 'completion-cheer';
      status.setAttribute('role', 'status'); status.textContent = '又完成一项，真棒！'; layer.append(status);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (let i = 0; i < 100; i++) {
          const piece = document.createElement('i'); piece.className = 'confetti'; piece.setAttribute('aria-hidden', 'true');
          piece.style.setProperty('--x', Math.random() * 100 + 'vw');
          piece.style.setProperty('--drift', (Math.random() - .5) * 50 + 'vw');
          piece.style.setProperty('--delay', Math.random() * .35 + 's');
          piece.style.setProperty('--spin', (Math.random() - .5) * 1000 + 'deg');
          piece.style.backgroundColor = ['#3158df', '#efb34f', '#64aa8b', '#dd7b98', '#a18bd1'][i % 5];
          layer.append(piece);
        }
      }
      document.body.append(layer); setTimeout(() => layer.remove(), 3000);
    }
  } catch (_) { /* Optional tab storage; completion still works. */ }
  if (typeof fetch !== 'function') return;
  document.querySelectorAll('form[action="/done"]').forEach(form => {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.dataset.completionPending) return;
      form.dataset.completionPending = '1';
      const button = form.querySelector('button'); button.disabled = true;
      try {
        const response = await fetch('/done', {method: 'POST', credentials: 'same-origin',
          headers: {'Accept': 'application/json'}, body: new URLSearchParams(new FormData(form))});
        const result = await response.json();
        if (!response.ok || result.ok !== true || typeof result.done !== 'boolean') throw new Error('unconfirmed');
        if (result.done) {
          try { sessionStorage.setItem(receiptKey, String(Date.now())); } catch (_) {}
        }
        location.assign(result.redirect);
      } catch (_) {
        // Do not retry a possibly accepted mutation or celebrate an unknown outcome.
        const status = document.createElement('p'); status.setAttribute('role', 'status');
        status.textContent = '完成状态未确认，请刷新查看后再操作。';
        const refresh = document.createElement('a'); refresh.href = location.href; refresh.textContent = '刷新查看';
        status.append(refresh); form.append(status);
      }
    });
  });
})();
