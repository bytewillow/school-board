/* Optional voice capture. No browser speech service or client-side API keys. */
(function () {
  'use strict';
  var root = document.getElementById('voice-controls');
  if (!root) return;
  var start = document.getElementById('voice-start');
  var submit = document.getElementById('voice-submit');
  var cancel = document.getElementById('voice-cancel');
  var file = document.getElementById('voice-file');
  var status = document.getElementById('voice-status');
  if (root.dataset.configured !== 'true') return;
  var state = 'idle', stream, recorder, chunks = [], audio, timer, began, generation = 0;
  var sendOnStop = false, locked = [];
  var maxBytes = 10 * 1024 * 1024;
  function say(text) { status.textContent = text; }
  function lock() {
    locked = Array.from(document.querySelectorAll('#ai-entry button, #ai-entry input, #ai-entry select, #ai-entry textarea, [data-entry], #entry-child'))
      .filter(function (e) { return !root.contains(e) && e !== file; })
      .map(function (e) { var old = e.disabled; e.disabled = true; return [e, old]; });
  }
  function release() { locked.forEach(function (p) { p[0].disabled = p[1]; }); locked = []; }
  function stopTracks() {
    clearInterval(timer);
    if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
    stream = null;
  }
  function controls() {
    root.dataset.state = state;
    start.hidden = state !== 'idle';
    start.disabled = state !== 'idle' || !canRecord;
    submit.hidden = !['recording', 'ready'].includes(state);
    submit.disabled = state === 'uploading';
    cancel.hidden = !['permission', 'recording', 'ready'].includes(state);
    file.disabled = state !== 'idle';
  }
  function reset() {
    stopTracks(); recorder = null; chunks = []; audio = null;
    state = 'idle'; file.value = ''; release(); controls();
  }
  var canRecord = !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!canRecord) say('当前浏览器或地址不能录音。请用 HTTPS（本机可用 localhost）及支持录音的浏览器，或选择录音文件 / 使用文字和照片。');
  controls();
  function preserveTranscript(text) {
    if (!text) return;
    var input = document.getElementById('ai-text');
    input.value = input.value.trim() ? input.value + '\n' + text : text;
  }
  async function parseAudio(blob, name) {
    if (!blob || !blob.size) { say('没有录到声音，请重新录音或选择音频文件。'); reset(); return; }
    if (blob.size > maxBytes) { say('音频最大 10MB，请缩短后重试。'); reset(); return; }
    state = 'uploading'; controls(); say('语音转写并解析中…完成后会直接显示待核对草稿。');
    var fd = new FormData(); fd.append('audio', blob, name);
    fd.append('child_id', document.getElementById('entry-child').value);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 135000);
    try {
      var response = await fetch('/api/ai-voice', {method: 'POST', body: fd, signal: controller.signal});
      var result = await response.json();
      preserveTranscript(result.transcript);
      if (response.ok && result.ok && Array.isArray(result.drafts)) {
        window.sbVoiceDrafts(result.drafts);
        say(result.drafts.length ? '语音已解析，文字已保留在下方。请核对草稿后再创建作业。' : '语音已转写，但未生成草稿；文字已保留在下方，可修改后识别。');
        document.getElementById('ai-status').scrollIntoView({block: 'nearest', behavior: 'auto'});
      } else {
        say((result.message || '语音解析失败，请重新录音或改用文字。') + (result.transcript ? ' 转写文字已保留在下方，可修改后点“识别成草稿”，无需再次转写。' : ''));
      }
    } catch (error) {
      say('语音解析未完成，未创建作业；请重新录音或改用文字。服务商可能已处理并计费，请勿连续重复提交。');
    } finally { clearTimeout(timeout); reset(); }
  }
  function stopRecording(send) {
    if (state !== 'recording') return;
    sendOnStop = send;
    clearInterval(timer);
    state = 'stopping'; controls();
    recorder.stop();
  }
  start.onclick = async function () {
    if (state !== 'idle' || !canRecord) return;
    // A text parse/create already in progress owns its controls.
    if (document.getElementById('ai-parse-btn').disabled || document.getElementById('ai-create-btn').disabled) {
      say('请先完成当前操作；若创建结果未确认，请先到本子里核对。'); return;
    }
    var current = ++generation;
    state = 'permission'; lock(); controls(); say('请允许使用麦克风；可随时取消。');
    try {
      var captured = await navigator.mediaDevices.getUserMedia({audio: true});
      if (current !== generation) { captured.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = captured;
      var types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
      var mime = types.find(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); });
      recorder = mime ? new MediaRecorder(stream, {mimeType: mime}) : new MediaRecorder(stream);
      chunks = []; audio = null; sendOnStop = false;
      recorder.ondataavailable = function (e) { if (current === generation && e.data.size) chunks.push(e.data); };
      recorder.onerror = function () { if (current === generation) { generation++; say('录音中断，请重新录音或选择录音文件。'); reset(); } };
      recorder.onstop = function () {
        if (current !== generation) return;
        var type = recorder.mimeType || (chunks[0] && chunks[0].type) || 'audio/webm';
        audio = new Blob(chunks, {type: type});
        stopTracks(); recorder = null; chunks = [];
        if (!audio.size) { say('没有录到声音，请重新录音。'); reset(); return; }
        if (sendOnStop) parseAudio(audio, type.includes('mp4') ? 'recording.m4a' : type.includes('ogg') ? 'recording.ogg' : 'recording.webm');
        else { state = 'ready'; controls(); say('已到 2 分钟，录音已停止。提交语音即可自动解析，或取消丢弃。'); }
      };
      recorder.start(1000); state = 'recording'; began = Date.now(); controls();
      say('正在录音 0 秒…说完点“提交语音并解析”。');
      timer = setInterval(function () {
        var seconds = Math.floor((Date.now() - began) / 1000);
        say('正在录音 ' + seconds + ' 秒…说完点“提交语音并解析”。');
        if (seconds >= 120) stopRecording(false);
        else if (chunks.reduce(function (n, c) { return n + c.size; }, 0) > maxBytes) {
          cancel.onclick(); say('音频已超过 10MB，请缩短录音后重试。');
        }
      }, 1000);
    } catch (error) {
      if (current !== generation) return;
      say(error.name === 'NotAllowedError' ? '麦克风权限未获允许，请在浏览器站点设置中允许，或选择录音文件 / 使用文字。' : '无法使用麦克风，请检查设备是否被占用，或选择录音文件 / 使用文字。');
      reset();
    }
  };
  submit.onclick = function () {
    if (state === 'recording') stopRecording(true);
    else if (state === 'ready') parseAudio(audio, audio.type.includes('mp4') ? 'recording.m4a' : 'recording.webm');
  };
  cancel.onclick = function () {
    generation++;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    reset(); say('已取消录音，未提交音频。');
  };
  file.onchange = function () {
    var selected = file.files[0];
    if (!selected || state !== 'idle') return;
    if (document.getElementById('ai-parse-btn').disabled || document.getElementById('ai-create-btn').disabled) {
      say('请先完成当前操作，或先核对未确认的创建结果。'); file.value = ''; return;
    }
    // Some mobile file pickers omit MIME; use a strict extension fallback.
    var type = selected.type || ({webm:'audio/webm',mp4:'audio/mp4',m4a:'audio/mp4',wav:'audio/wav',mp3:'audio/mpeg',ogg:'audio/ogg'}[selected.name.split('.').pop().toLowerCase()]);
    lock(); parseAudio(type && !selected.type ? new Blob([selected], {type:type}) : selected, selected.name);
  };
  window.addEventListener('pagehide', function () {
    generation++;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    reset();
  });
}());
