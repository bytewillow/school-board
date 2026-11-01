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
// Without dialog/fetch support the title remains an ordinary edit-page link.
if (typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal === 'function' && typeof window.fetch === 'function') {
  document.querySelectorAll('.item-title[data-item-detail]').forEach(link => {
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
        const detail = document.createElement('a'); detail.href = link.dataset.itemDetail; detail.className = 'detail-link'; detail.textContent = '查看详情与附件';
        dialog.append(form, detail); document.body.append(dialog);
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => { dialog.remove(); link.focus(); }, {once:true});
        dialog.showModal();
        form.querySelector('#edit-title').focus({preventScroll:true});
      } catch (_) { location.assign(link.href); }
      finally { delete link.dataset.loading; link.removeAttribute('aria-busy'); }
    });
  });
}
