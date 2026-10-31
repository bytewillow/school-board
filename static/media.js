/* Native, dependency-free audio and image UI; PDF renderer is local PDF.js. */
'use strict';
function timeLabel(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  return Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + Math.floor(seconds % 60).toString().padStart(2, '0');
}
document.querySelectorAll('.listening-player').forEach(box => {
  const audio = box.querySelector('audio'), play = box.querySelector('.audio-play');
  const seek = box.querySelector('.audio-seek'), status = box.querySelector('.audio-status');
  let pointA = null, pointB = null;
  box.querySelector('.audio-enhanced').hidden = false;
  audio.controls = false;
  function say(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
  function ready() {
    const valid = Number.isFinite(audio.duration) && audio.duration > 0;
    seek.disabled = !valid;
    box.querySelector('.audio-duration').textContent = timeLabel(audio.duration);
    box.querySelectorAll('[data-skip],.audio-a,.audio-b').forEach(b => b.disabled = !valid);
    if (valid) say('准备好了，点击播放开始听。');
  }
  function updateAB() {
    box.querySelector('.audio-ab').textContent = pointA === null ? '先设起点，再播放到终点设置 B；不改变原文件。' :
      'A ' + timeLabel(pointA) + ' → B ' + (pointB === null ? '待设置' : timeLabel(pointB)) + (pointB === null ? '' : ' · 区间复读已开启');
  }
  play.onclick = async () => {
    if (!audio.paused) { audio.pause(); return; }
    try { if (pointB !== null && (audio.currentTime < pointA || audio.currentTime >= pointB)) audio.currentTime = pointA; await audio.play(); }
    catch (_) { audio.controls = true; say('无法播放。可重试、使用浏览器播放器，或下载原文件。', true); }
  };
  audio.addEventListener('play', () => {
    box.classList.add('is-playing');
    document.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); });
    play.textContent = '暂停'; play.setAttribute('aria-label', '暂停'); say('正在播放');
  });
  audio.addEventListener('pause', () => { box.classList.remove('is-playing'); play.textContent = '播放'; play.setAttribute('aria-label', '播放'); if (!audio.ended) say('已暂停'); });
  audio.addEventListener('ended', () => { box.classList.remove('is-playing'); play.textContent = '重播'; play.setAttribute('aria-label', '重播'); say('播放完毕'); });
  audio.addEventListener('loadedmetadata', ready);
  audio.addEventListener('durationchange', ready);
  audio.addEventListener('waiting', () => say('正在缓冲…'));
  const loadError = () => { box.classList.remove('is-playing'); audio.controls = true; say('音频加载失败或格式不受支持，请打开或下载原文件。', true); };
  audio.addEventListener('error', loadError);
  audio.addEventListener('timeupdate', () => {
    if (pointB !== null && audio.currentTime >= pointB) audio.currentTime = pointA;
    if (Number.isFinite(audio.duration) && audio.duration) seek.value = Math.round(audio.currentTime / audio.duration * 1000);
    box.querySelector('.audio-current').textContent = timeLabel(audio.currentTime);
    seek.setAttribute('aria-valuetext', timeLabel(audio.currentTime) + ' / ' + timeLabel(audio.duration));
  });
  seek.oninput = () => { if (!seek.disabled) audio.currentTime = seek.value / 1000 * audio.duration; };
  box.querySelectorAll('[data-skip]').forEach(button => button.onclick = () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + Number(button.dataset.skip)));
  });
  box.querySelector('.audio-rate').onchange = event => { audio.playbackRate = Number(event.target.value); say('播放速度 ' + event.target.value + ' 倍'); };
  box.querySelector('.audio-loop').onclick = event => {
    audio.loop = !audio.loop;
    if (audio.loop) { pointA = pointB = null; updateAB(); }
    event.target.textContent = '整段循环：' + (audio.loop ? '开' : '关'); event.target.setAttribute('aria-pressed', String(audio.loop));
  };
  box.querySelector('.audio-a').onclick = () => { pointA = audio.currentTime; pointB = null; updateAB(); };
  box.querySelector('.audio-b').onclick = () => {
    if (pointA === null || audio.currentTime <= pointA + .25) { say('请先设置 A，再在至少 0.25 秒之后设置 B。', true); return; }
    pointB = audio.currentTime; audio.loop = false;
    box.querySelector('.audio-loop').textContent = '整段循环：关'; box.querySelector('.audio-loop').setAttribute('aria-pressed', 'false'); updateAB(); say('AB 区间复读已开启');
  };
  box.querySelector('.audio-clear').onclick = () => { pointA = pointB = null; updateAB(); say('已清除 AB'); };
  box.querySelector('.audio-native').onclick = () => { audio.controls = !audio.controls; };
  ready();
  if (audio.error) loadError();
});

let pdfLibrary;
document.querySelectorAll('.media-open').forEach(link => link.addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !HTMLDialogElement.prototype.showModal) return;
  event.preventDefault(); openViewer(link);
}));
function openViewer(link) {
  const pdfMode = link.dataset.type === 'pdf';
  const gallery = pdfMode ? [{ url: link.dataset.url, title: link.dataset.title }] : JSON.parse(link.dataset.gallery);
  let index = Math.max(0, gallery.findIndex(item => item.url === link.dataset.url));
  let pageNumber = 1, totalPages = 1, zoom = 1, pdfDoc, loadingTask, renderTask, generation = 0, closed = false;
  const dialog = document.createElement('dialog'); dialog.className = 'media-viewer';
  dialog.setAttribute('aria-label', pdfMode ? 'PDF 全屏阅读器' : '图片全屏查看器');
  dialog.innerHTML = `<header class="viewer-bar"><h2 class="viewer-title"></h2><button type="button" class="viewer-system">系统全屏</button><a class="viewer-original" target="_blank" rel="noopener">原文件 ↗</a><button type="button" class="viewer-close" aria-label="关闭查看器">关闭</button></header>
    <p class="viewer-status" role="status" aria-live="polite"></p><div class="viewer-stage"></div>
    <p class="viewer-hint">${pdfMode ? '左右滑动翻页；放大后可拖动页面。' : '同本同科图片；左右滑动翻图，放大后可拖动。'} 键盘 ← → 翻动，Esc 关闭。</p>
    <footer class="viewer-controls"><button type="button" class="viewer-prev" aria-label="${pdfMode ? '上一页' : '上一张'}">${pdfMode ? '上一页' : '上一张'}</button><label class="viewer-position"><input type="number" min="1" aria-label="${pdfMode ? '页码' : '图片序号'}"><span></span></label><button type="button" class="viewer-next" aria-label="${pdfMode ? '下一页' : '下一张'}">${pdfMode ? '下一页' : '下一张'}</button><button type="button" class="viewer-minus" aria-label="缩小">−</button><span class="viewer-zoom">100%</span><button type="button" class="viewer-plus" aria-label="放大">＋</button><button type="button" class="viewer-fit">适应</button></footer>`;
  const q = selector => dialog.querySelector(selector), stage = q('.viewer-stage'), status = q('.viewer-status');
  const previousOverflow = document.body.style.overflow;
  document.body.append(dialog); dialog.showModal(); document.body.style.overflow = 'hidden'; q('.viewer-close').focus();
  function controls() {
    const total = pdfMode ? totalPages : gallery.length, position = pdfMode ? pageNumber : index + 1;
    q('.viewer-prev').disabled = position <= 1; q('.viewer-next').disabled = position >= total;
    q('input').max = total; q('input').value = position; q('.viewer-position span').textContent = '/ ' + total;
    q('.viewer-zoom').textContent = Math.round(zoom * 100) + '%';
    q('.viewer-title').textContent = gallery[index].title;
    q('.viewer-original').href = gallery[index].url;
  }
  async function render() {
    const token = ++generation; controls(); status.textContent = '加载中…';
    if (renderTask) { renderTask.cancel(); try { await renderTask.promise; } catch (_) {} renderTask = null; }
    if (closed || token !== generation) return;
    stage.replaceChildren(); stage.scrollTo(0, 0);
    try {
      if (pdfMode) {
        if (!pdfDoc) {
          pdfLibrary = pdfLibrary || import('/static/pdfjs/pdf.mjs');
          const lib = await pdfLibrary;
          lib.GlobalWorkerOptions.workerSrc = '/static/pdfjs/pdf.worker.mjs';
          loadingTask = lib.getDocument({ url: gallery[index].url, isEvalSupported: false, useSystemFonts: true });
          const doc = await loadingTask.promise;
          if (closed || token !== generation) { await loadingTask.destroy(); return; }
          pdfDoc = doc; totalPages = doc.numPages; controls();
        }
        const page = await pdfDoc.getPage(pageNumber);
        if (closed || token !== generation) return;
        const natural = page.getViewport({ scale: 1 });
        const fit = Math.min((stage.clientWidth - 24) / natural.width, (stage.clientHeight - 24) / natural.height);
        const scale = Math.max(.1, fit) * zoom, ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: scale * ratio });
        // Bound raster allocation for very large source pages; zoom remains scrollable.
        const cap = Math.min(1, 4096 / Math.max(viewport.width, viewport.height));
        const bounded = page.getViewport({ scale: scale * ratio * cap });
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(bounded.width); canvas.height = Math.ceil(bounded.height);
        canvas.style.width = bounded.width / (ratio * cap) + 'px'; canvas.style.height = bounded.height / (ratio * cap) + 'px';
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', gallery[index].title + '，第 ' + pageNumber + ' 页'); stage.append(canvas);
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: bounded }); await renderTask.promise; renderTask = null;
      } else {
        const image = new Image(); image.alt = gallery[index].title;
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = gallery[index].url; });
        if (closed || token !== generation) return;
        const fit = Math.min((stage.clientWidth - 24) / image.naturalWidth, (stage.clientHeight - 24) / image.naturalHeight, 1);
        image.style.width = image.naturalWidth * fit * zoom + 'px'; image.style.height = image.naturalHeight * fit * zoom + 'px'; stage.append(image);
      }
      if (!closed && token === generation) status.textContent = pdfMode ? `第 ${pageNumber} / ${totalPages} 页` : `第 ${index + 1} / ${gallery.length} 张 · 全部为当前本子同学科可见图片`;
    } catch (error) {
      if (!closed && token === generation && error.name !== 'RenderingCancelledException') { status.textContent = '无法显示此文件（格式、加密或浏览器兼容问题）。请用右上角“原文件”打开或下载。'; }
    }
  }
  function turn(delta) {
    if (pdfMode) pageNumber = Math.min(totalPages, Math.max(1, pageNumber + delta));
    else index = Math.min(gallery.length - 1, Math.max(0, index + delta));
    zoom = 1; render();
  }
  q('.viewer-prev').onclick = () => turn(-1); q('.viewer-next').onclick = () => turn(1);
  q('input').onchange = event => {
    const value = Number(event.target.value), max = pdfMode ? totalPages : gallery.length;
    if (!Number.isInteger(value) || value < 1 || value > max) { controls(); return; }
    if (pdfMode) pageNumber = value; else index = value - 1; zoom = 1; render();
  };
  function changeZoom(delta) { zoom = Math.max(.5, Math.min(3, zoom + delta)); render(); }
  q('.viewer-minus').onclick = () => changeZoom(-.25); q('.viewer-plus').onclick = () => changeZoom(.25);
  q('.viewer-fit').onclick = () => { zoom = 1; render(); };
  q('.viewer-close').onclick = () => dialog.close();
  dialog.addEventListener('keydown', event => {
    if (event.target.matches('input')) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); turn(1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); turn(-1); }
  });
  let touch;
  stage.addEventListener('touchstart', event => { touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; }, { passive: true });
  stage.addEventListener('touchend', event => {
    if (!touch || zoom !== 1 || !event.changedTouches.length) return;
    const x = event.changedTouches[0].clientX - touch.x, y = event.changedTouches[0].clientY - touch.y; touch = null;
    if (Math.abs(x) > 65 && Math.abs(x) > Math.abs(y) * 1.5) turn(x < 0 ? 1 : -1);
  }, { passive: true });
  q('.viewer-system').hidden = !dialog.requestFullscreen;
  q('.viewer-system').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await dialog.requestFullscreen(); } catch (_) { status.textContent = '浏览器不支持系统全屏，仍可在当前全屏窗口阅读。'; } };
  let resizeTimer; const resize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!closed) render(); }, 120); };
  window.addEventListener('resize', resize);
  dialog.addEventListener('close', () => {
    closed = true; generation++; clearTimeout(resizeTimer); window.removeEventListener('resize', resize);
    if (renderTask) renderTask.cancel(); if (loadingTask) loadingTask.destroy().catch(() => {});
    if (document.fullscreenElement === dialog) document.exitFullscreen().catch(() => {});
    document.body.style.overflow = previousOverflow; dialog.remove(); link.focus();
  }, { once: true });
  render();
}
