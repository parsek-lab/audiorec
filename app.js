const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
function setIconButton(button, name, text, tooltip) {
  button.replaceChildren();
  button.insertAdjacentHTML('afterbegin', icon(name));
  button.append(document.createTextNode(text));
  button.title = tooltip;
}
function updateVideoMute() {
  setIconButton($('video-mute'), video.muted ? 'mute' : 'volume', `Video audio: ${video.muted ? 'off' : 'on'}`, `${video.muted ? 'Unmute' : 'Mute'} video audio (no shortcut)`);
  $('video-mute').setAttribute('aria-pressed', String(video.muted));
}
function updateRecordButton() {
  setIconButton($('record'), recording ? 'stop' : 'record', recording ? 'Stop recording' : 'Record', `${recording ? 'Stop recording' : 'Record'} (*)`);
  $('record').classList.toggle('active', recording);
  document.body.classList.toggle('is-recording', recording);
}
function updateMicButton() {
  setIconButton($('test-mic'), stream ? 'stop' : 'record', stream ? 'Stop test' : 'Test microphone', `${stream ? 'Stop microphone test' : 'Test microphone'} (no shortcut)`);
  $('test-mic').setAttribute('aria-pressed', String(!!stream));
}
const video = $('video');
const tracks = [];
let context, stream, source, analyser, meterFrame, processor, silentGain, recording = false, nextId = 1, videoURL;
let playingSources = [];
const PX_PER_SECOND = 80;
let playheadFrame = null, scrubbing = false;
function updatePlayhead() {
  const scroller = $('timeline-scroll');
  const position = 260 + Math.max(0, video.currentTime || 0) * PX_PER_SECOND;
  $('playhead').style.left = `${position}px`;
  $('time-display').textContent = formatTime(video.currentTime || 0);
  if (scrubbing) return;
  const center = 260 + Math.max(0, scroller.clientWidth - 260) / 2;
  scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, position - center));
}
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60), rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}
function animatePlayhead() {
  updatePlayhead();
  if (!video.paused && !video.ended) playheadFrame = requestAnimationFrame(animatePlayhead);
  else playheadFrame = null;
}
function stopPlayhead() {
  if (playheadFrame !== null) cancelAnimationFrame(playheadFrame);
  playheadFrame = null;
  updatePlayhead();
}
const clipDuration = clip => Math.max(0, clip.buffer.duration - (clip.trimStart || 0) - (clip.trimEnd || 0));
const FADE_SECONDS = .005;
function fadeGain(position, duration, fade) {
  return fade > 0 ? Math.max(0, Math.min(1, position / fade, (duration - position) / fade)) : 0;
}
let databasePromise, saveQueue = Promise.resolve(), selectedVideo = null, restoring = true;
function database() {
  return databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('audio-sopra-video', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('project');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function projectData() {
  return { nextId, videoFile: selectedVideo, videoMuted: video.muted,
    tracks: tracks.map(t => ({ id: t.id, name: t.name || `Track ${t.id}`, armed: t.armed, muted: t.muted,
      clips: t.clips.map(c => ({ name: c.name || 'Clip', start: c.start, trimStart: c.trimStart || 0, trimEnd: c.trimEnd || 0,
        sampleRate: c.buffer.sampleRate, samples: new Float32Array(c.buffer.getChannelData(0)) })) })) };
}
function saveProject() {
  if (restoring) return saveQueue;
  const snapshot = projectData();
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const db = await database();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('project', 'readwrite');
      tx.objectStore('project').put(snapshot, 'current');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }).catch(error => { status(`Local save failed: ${error.message}`); });
  return saveQueue;
}
async function restoreProject() {
  try {
    const db = await database();
    const data = await new Promise((resolve, reject) => {
      const tx = db.transaction('project', 'readonly');
      const request = tx.objectStore('project').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      const handleRequest = tx.objectStore('project').get('fileHandle');
      handleRequest.onsuccess = () => { projectHandle = handleRequest.result || null; };
    });
    if (data) {
      tracks.length = 0;
      const audio = getContext();
      for (const saved of data.tracks) {
        const clips = saved.clips.map(c => {
          const buffer = audio.createBuffer(1, c.samples.length, c.sampleRate);
          buffer.copyToChannel(c.samples, 0);
          return { name: c.name || 'Clip', start: c.start, trimStart: c.trimStart, trimEnd: c.trimEnd, buffer };
        });
        tracks.push({ id: saved.id, name: saved.name || `Track ${saved.id}`, armed: saved.armed, muted: saved.muted, clips });
      }
      nextId = data.nextId;
      selectedVideo = data.videoFile || null;
      if (selectedVideo) {
        videoURL = URL.createObjectURL(selectedVideo); video.src = videoURL;
        $('video-name').textContent = selectedVideo.name;
      }
      video.muted = !!data.videoMuted;
      updateVideoMute();
      status('Project restored from the browser.');
    } else tracks.push({ id: nextId, name: `Track ${nextId++}`, armed: true, muted: false, clips: [] });
  } catch (error) {
    tracks.length = 0;
    tracks.push({ id: nextId, name: `Track ${nextId++}`, armed: true, muted: false, clips: [] });
    status(`Local storage unavailable: ${error.message}`);
  } finally {
    restoring = false; renderTracks();
    for (const id of ['video-file', 'add-track', 'record', 'export', 'new-project', 'save-project', 'open-project', 'open-project-button']) $(id).disabled = false;
  }
}
function renderTimeline() {
  const end = Math.max(10, Number.isFinite(video.duration) ? video.duration : 0, ...tracks.flatMap(t => t.clips.map(c => c.start + clipDuration(c))));
  const seconds = Math.ceil(end + 2), width = seconds * PX_PER_SECOND;
  const tail = Math.ceil($('timeline-scroll').clientWidth / 2);
  $('timeline').style.width = `${width + tail + 280}px`;
  $('ruler').style.width = `${width + tail}px`;
  $('ruler').replaceChildren();
  updatePlayhead();
  for (let s = 0; s <= seconds; s += 2) {
    const tick = document.createElement('span'); tick.className = 'tick'; tick.style.left = `${s * PX_PER_SECOND}px`; tick.textContent = `${s}s`; $('ruler').append(tick);
  }
}
function editClip(event, clip, mode, element) {
  event.preventDefault(); event.stopPropagation();
  const pointer = event.pointerId, x = event.clientX;
  const original = { start: clip.start, trimStart: clip.trimStart || 0, trimEnd: clip.trimEnd || 0 };
  const minimum = Math.min(.05, clip.buffer.duration);
  element.setPointerCapture(pointer); element.classList.add('dragging');
  const move = e => {
    if (e.pointerId !== pointer) return;
    const delta = (e.clientX - x) / PX_PER_SECOND;
    if (mode === 'move') clip.start = Math.max(0, original.start + delta);
    if (mode === 'left') {
      const change = Math.max(-original.trimStart, -original.start, Math.min(delta, clip.buffer.duration - original.trimStart - original.trimEnd - minimum));
      clip.trimStart = original.trimStart + change;
      clip.start = original.start + change;
    }
    if (mode === 'right') clip.trimEnd = Math.max(0, Math.min(clip.buffer.duration - original.trimStart - minimum, original.trimEnd - delta));
    element.style.left = `${clip.start * PX_PER_SECOND}px`;
    element.style.width = `${Math.max(8, clipDuration(clip) * PX_PER_SECOND)}px`;
    const wave = element.querySelector('.clip-wave');
    if (wave) wave.style.left = `${-(clip.trimStart || 0) * PX_PER_SECOND}px`;
  };
  const done = e => {
    if (e.pointerId !== pointer) return;
    element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', done); element.removeEventListener('pointercancel', done);
    element.classList.remove('dragging');
    if (clip.start !== original.start || (clip.trimStart || 0) !== original.trimStart || (clip.trimEnd || 0) !== original.trimEnd) {
      renderTracks(); syncPlayback(); saveProject();
    }
  };
  element.addEventListener('pointermove', move); element.addEventListener('pointerup', done); element.addEventListener('pointercancel', done);
}

const STATUS_ERROR = /^(Could not|Local save failed|Local storage unavailable|Microphone|Devices unavailable|Playback not started|Recording not started|Audio output:|Enable REC|Stop recording before|No unmuted|Recording too long)/;
const status = text => {
  const box = $('status');
  box.textContent = text; box.dataset.kind = STATUS_ERROR.test(text) ? 'error' : 'info';
  box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
};

function addTrack() {
  const track = { id: nextId, name: `Track ${nextId++}`, armed: tracks.length === 0, muted: false, clips: [] };
  tracks.push(track);
  renderTracks(); saveProject();
}
function drawWaveform(clip) {
  const width = Math.ceil(clip.buffer.duration * PX_PER_SECOND), height = 44;
  if (width < 1 || width > 16000) return null;
  const canvas = document.createElement('canvas'), ratio = window.devicePixelRatio || 1;
  canvas.className = 'clip-wave'; canvas.width = Math.ceil(width * ratio); canvas.height = Math.ceil(height * ratio);
  canvas.style.width = `${width}px`; canvas.style.left = `${-(clip.trimStart || 0) * PX_PER_SECOND}px`;
  const g = canvas.getContext('2d'), data = clip.buffer.getChannelData(0), step = data.length / canvas.width, middle = canvas.height / 2;
  g.fillStyle = 'rgba(230,235,255,.75)';
  for (let x = 0; x < canvas.width; x++) {
    let peak = 0;
    for (let i = Math.floor(x * step), end = Math.min(data.length, Math.floor((x + 1) * step)); i < end; i++) peak = Math.max(peak, Math.abs(data[i]));
    const bar = Math.max(ratio / 2, Math.min(1, peak * 1.6) * middle * .85);
    g.fillRect(x, middle - bar, 1, bar * 2);
  }
  return canvas;
}
function renderTracks() {
  renderTimeline();
  $('tracks').replaceChildren();
  const laneWidth = Math.ceil((parseInt($('timeline').style.width, 10) - 280));
  for (const track of tracks) {
    const row = document.createElement('div'); row.className = 'track';
    const title = document.createElement('span'); title.className = 'track-name'; title.textContent = track.name;
    title.title = 'Rename track (double-click)';
    title.ondblclick = () => {
      const name = window.prompt('Track name:', track.name);
      if (name === null || !name.trim()) return;
      track.name = name.trim();
      renderTracks(); saveProject(); status(`Track renamed: ${track.name}.`);
    };
    const info = document.createElement('span'); info.className = 'track-info'; info.textContent = `${track.clips.length} recording${track.clips.length === 1 ? '' : 's'}`;
    const rec = document.createElement('button'); rec.type = 'button'; setIconButton(rec, 'record', 'REC', `Arm or disarm recording on ${track.name} (no shortcut)`); rec.setAttribute('aria-pressed', String(track.armed)); rec.disabled = recording;
    rec.setAttribute('aria-label', `Arm recording on track ${track.id}`);
    rec.onclick = () => { track.armed = !track.armed; renderTracks(); saveProject(); };
    const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'muted'; setIconButton(mute, track.muted ? 'mute' : 'volume', 'Mute', `Toggle mute on ${track.name} (no shortcut)`); mute.setAttribute('aria-pressed', String(track.muted));
    mute.setAttribute('aria-label', `Mute track ${track.id}`);
    mute.onclick = () => { track.muted = !track.muted; renderTracks(); syncPlayback(); saveProject(); };
    const remove = document.createElement('button'); remove.type = 'button'; setIconButton(remove, 'close', 'Remove', `Remove ${track.name} (no shortcut)`);
    remove.className = 'remove-track'; remove.disabled = recording;
    remove.setAttribute('aria-label', `Remove track ${track.id}`);
    remove.onclick = () => {
      if (track.clips.length && !window.confirm(`Remove ${track.name} and all its recordings?`)) return;
      const index = tracks.indexOf(track);
      if (index < 0) return;
      tracks.splice(index, 1);
      renderTracks(); syncPlayback(); saveProject(); status(`Track ${track.id} removed.`);
    };
    const controls = document.createElement('div'); controls.className = 'track-controls'; controls.append(title, info, rec, mute, remove);
    const lane = document.createElement('div'); lane.className = 'clip-lane'; lane.style.width = `${laneWidth}px`;
    for (const clip of track.clips) {
      const block = document.createElement('div'); block.className = `clip${track.muted ? ' muted-clip' : ''}`;
      block.style.left = `${clip.start * PX_PER_SECOND}px`;
      block.style.width = `${Math.max(8, clipDuration(clip) * PX_PER_SECOND)}px`;
      block.title = `${clip.name || 'Clip'} · ${clip.start.toFixed(2)} s · ${clipDuration(clip).toFixed(2)} s · Rename (double-click)`;
      const wave = drawWaveform(clip);
      if (wave) block.append(wave);
      const label = document.createElement('span'); label.className = 'clip-label'; label.textContent = clip.name || 'Clip'; block.append(label);
      for (const side of ['left', 'right']) {
        const handle = document.createElement('span'); handle.className = `clip-handle ${side}`;
        handle.setAttribute('aria-label', `Edit clip ${side === 'left' ? 'start' : 'end'}`);
        handle.title = `Edit clip ${side === 'left' ? 'start' : 'end'} (drag)`;
        handle.addEventListener('pointerdown', e => editClip(e, clip, side, block)); block.append(handle);
      }
      const deleteClip = document.createElement('button');
      deleteClip.type = 'button'; deleteClip.className = 'delete-clip'; deleteClip.textContent = '×';
      deleteClip.disabled = recording;
      deleteClip.setAttribute('aria-label', `Remove clip from track ${track.id}`);
      deleteClip.title = 'Remove clip (no shortcut)';
      deleteClip.addEventListener('pointerdown', e => e.stopPropagation());
      deleteClip.onclick = e => {
        e.stopPropagation();
        if (!window.confirm(`Remove this clip from Track ${track.id}?`)) return;
        const index = track.clips.indexOf(clip);
        if (index < 0) return;
        track.clips.splice(index, 1);
        renderTracks(); syncPlayback(); saveProject(); status(`Clip removed from Track ${track.id}.`);
      };
      block.append(deleteClip);
      block.addEventListener('pointerdown', e => { if (e.target === block) editClip(e, clip, 'move', block); });
      block.addEventListener('dblclick', e => {
        if (e.target !== block) return;
        e.stopPropagation();
        const name = window.prompt('Clip name:', clip.name || 'Clip');
        if (name === null || !name.trim()) return;
        clip.name = name.trim();
        renderTracks(); saveProject(); status(`Clip renamed: ${clip.name}.`);
      });
      lane.append(block);
    }
    row.append(controls, lane); $('tracks').append(row);
  }
}
function getContext() { return context ??= new AudioContext(); }
function stopPlayback() { for (const { node, gain } of playingSources) { try { node.stop(); } catch {} node.disconnect(); gain.disconnect(); } playingSources = []; }
function syncPlayback() {
  stopPlayback();
  if (video.paused || recording || !context) return;
  const now = video.currentTime;
  for (const track of tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      const elapsed = Math.max(0, now - clip.start);
      const duration = clipDuration(clip);
      if (duration <= 0 || elapsed >= duration) continue;
      const offset = (clip.trimStart || 0) + elapsed;
      const startTime = context.currentTime + Math.max(0, clip.start - now);
      const fade = Math.min(FADE_SECONDS, duration / 2);
      const node = context.createBufferSource(), gain = context.createGain();
      node.buffer = clip.buffer; node.connect(gain); gain.connect(context.destination);
      gain.gain.setValueAtTime(fadeGain(elapsed, duration, fade), startTime);
      if (elapsed < fade) gain.gain.linearRampToValueAtTime(1, startTime + fade - elapsed);
      if (elapsed < duration - fade) gain.gain.setValueAtTime(1, startTime + duration - fade - elapsed);
      gain.gain.linearRampToValueAtTime(0, startTime + duration - elapsed);
      node.start(startTime, offset, duration - elapsed);
      playingSources.push({ node, gain });
    }
  }
}
async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [kind, selectId] of [['audioinput', 'input-device'], ['audiooutput', 'output-device']]) {
      const select = $(selectId), previous = select.value;
      select.replaceChildren(new Option('Default', ''));
      devices.filter(d => d.kind === kind).forEach((d, i) => select.add(new Option(d.label || `${kind === 'audioinput' ? 'Microphone' : 'Output'} ${i + 1}`, d.deviceId)));
      if ([...select.options].some(o => o.value === previous)) select.value = previous;
    }
  } catch (error) { status(`Devices unavailable: ${error.message}`); }
}
async function setOutput() {
  const id = $('output-device').value || 'default';
  try {
    if (!video.setSinkId || !getContext().setSinkId) throw new Error('output selection not supported by this browser');
    await video.setSinkId(id); await context.setSinkId(id);
    status('Audio output updated.');
  } catch (error) { status(`Audio output: ${error.message}`); }
}
function stopMonitoring() {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  source?.disconnect();
  stream?.getTracks().forEach(t => t.stop());
  stream = null; source = null; analyser = null;
  $('mic-level').value = 0;
  $('mic-state').textContent = 'Inactive';
  updateMicButton();
}
async function startMonitoring() {
  const audio = getContext(); await audio.resume();
  const mic = await navigator.mediaDevices.getUserMedia({ audio: $('input-device').value ? { deviceId: { exact: $('input-device').value } } : true });
  try {
    const input = audio.createMediaStreamSource(mic);
    const meter = audio.createAnalyser(); meter.fftSize = 2048;
    input.connect(meter);
    stream = mic; source = input; analyser = meter;
    const samples = new Float32Array(meter.fftSize);
    const update = () => {
      if (!analyser) return;
      meter.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      $('mic-level').value = Math.min(100, Math.round(rms * 300));
      meterFrame = requestAnimationFrame(update);
    };
    update();
    $('mic-state').textContent = 'Listening';
    updateMicButton();
    await listDevices();
  } catch (error) { mic.getTracks().forEach(t => t.stop()); throw error; }
}
function finishRecording() {
  if (!recording) return;
  recording = false;
  processor.disconnect(); silentGain.disconnect();
  stopMonitoring();
  for (const track of tracks) {
    if (!track.pending) continue;
    const { chunks, start, sampleRate } = track.pending;
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (length) {
      const buffer = context.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0); let position = 0;
      for (const chunk of chunks) { data.set(chunk, position); position += chunk.length; }
      track.clips.push({ name: `Clip ${track.clips.length + 1}`, start, buffer });
    }
    delete track.pending;
  }
  updateRecordButton();
  $('input-device').disabled = false; $('test-mic').disabled = false; renderTracks(); status('Recording complete. Saving locally…');
  saveProject().then(() => { if ($('status').textContent === 'Recording complete. Saving locally…') status('Recording saved in the browser. Press Play to listen back.'); });
}
async function toggleRecording() {
  if (recording) { finishRecording(); return; }
  if (!tracks.some(t => t.armed)) { status('Enable REC on at least one track.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { status('Microphone only available on localhost or HTTPS.'); return; }
  $('record').disabled = true;
  try {
    const audio = getContext(); await audio.resume();
    if (!stream) await startMonitoring();
    stopPlayback();
    if (video.src && video.paused) await video.play();
    const start = video.src ? video.currentTime : 0;
    processor = audio.createScriptProcessor(4096, 1, 1);
    silentGain = audio.createGain(); silentGain.gain.value = 0;
    for (const track of tracks) if (track.armed) track.pending = { start, sampleRate: audio.sampleRate, chunks: [] };
    processor.onaudioprocess = event => {
      const chunk = event.inputBuffer.getChannelData(0);
      for (const track of tracks) if (track.pending) track.pending.chunks.push(new Float32Array(chunk));
    };
    source.connect(processor); processor.connect(silentGain); silentGain.connect(audio.destination);
    recording = true; updateRecordButton();
    $('input-device').disabled = true; $('test-mic').disabled = true; renderTracks(); status('Recording…');
  } catch (error) {
    stopMonitoring();
    for (const track of tracks) delete track.pending;
    status(`Recording not started: ${error.message}`);
  } finally { $('record').disabled = false; }
}
let projectHandle = null;
const PROJECT_TYPES = [{ description: 'Audiorec project', accept: { 'application/octet-stream': ['.audiorec'] } }];
function rememberProjectFile(handle) {
  projectHandle = handle;
  database().then(db => { db.transaction('project', 'readwrite').objectStore('project').put(handle, 'fileHandle'); }).catch(() => {});
}
function projectBlob() {
    const data = projectData();
    const manifest = {
      version: 1, nextId: data.nextId, videoMuted: data.videoMuted,
      video: data.videoFile ? { name: data.videoFile.name, type: data.videoFile.type, size: data.videoFile.size } : null,
      tracks: data.tracks.map(track => ({ id: track.id, name: track.name, armed: track.armed, muted: track.muted,
        clips: track.clips.map(clip => ({ name: clip.name, start: clip.start, trimStart: clip.trimStart, trimEnd: clip.trimEnd,
          sampleRate: clip.sampleRate, sampleCount: clip.samples.length })) }))
    };
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const header = new ArrayBuffer(12), view = new DataView(header);
    for (let i = 0; i < 8; i++) view.setUint8(i, 'AUDIOREC'.charCodeAt(i));
    view.setUint32(8, json.length, true);
    const parts = [header, json];
    if (data.videoFile) parts.push(data.videoFile);
    for (const track of data.tracks) for (const clip of track.clips) parts.push(clip.samples);
    return new Blob(parts, { type: 'application/octet-stream' });
}
async function saveProjectFile() {
  try {
    const blob = projectBlob();
    if (!window.showSaveFilePicker) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'project.audiorec'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status('Project file downloaded (this browser cannot overwrite files).');
      return;
    }
    let handle = projectHandle;
    if (handle && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') handle = null;
    handle ??= await window.showSaveFilePicker({ suggestedName: 'project.audiorec', types: PROJECT_TYPES });
    const writable = await handle.createWritable();
    await writable.write(blob); await writable.close();
    rememberProjectFile(handle);
    status(`Project saved to ${handle.name}.`);
  } catch (error) {
    if (error.name !== 'AbortError') status(`Could not save project: ${error.message}`);
  }
}
async function openProject(file, handle = null) {
  if (recording) { status('Stop recording before opening a project.'); return; }
  try {
    const bytes = await file.arrayBuffer(), view = new DataView(bytes);
    if (bytes.byteLength < 12 || new TextDecoder().decode(new Uint8Array(bytes, 0, 8)) !== 'AUDIOREC') throw new Error('unrecognized format');
    const jsonLength = view.getUint32(8, true);
    if (jsonLength > bytes.byteLength - 12) throw new Error('incomplete file');
    const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 12, jsonLength)));
    if (manifest.version !== 1 || !Array.isArray(manifest.tracks)) throw new Error('unsupported version');
    let position = 12 + jsonLength;
    const videoSize = manifest.video?.size || 0;
    if (!Number.isSafeInteger(videoSize) || videoSize < 0 || videoSize > bytes.byteLength - position) throw new Error('invalid video');
    const importedVideo = manifest.video ? new File([bytes.slice(position, position + videoSize)], manifest.video.name, { type: manifest.video.type }) : null;
    position += videoSize;
    const audio = getContext();
    const importedTracks = manifest.tracks.map(track => {
      if (!Array.isArray(track.clips) || !Number.isSafeInteger(track.id)) throw new Error('invalid track');
      return { id: track.id, name: track.name || `Track ${track.id}`, armed: !!track.armed, muted: !!track.muted,
        clips: track.clips.map(clip => {
          const { sampleCount, sampleRate } = clip;
          if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || !Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 192000 || sampleCount * 4 > bytes.byteLength - position) throw new Error('invalid audio');
          const samples = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) samples[i] = view.getFloat32(position + i * 4, true);
          position += sampleCount * 4;
          const buffer = audio.createBuffer(1, sampleCount, sampleRate);
          buffer.copyToChannel(samples, 0);
          if (!Number.isFinite(clip.start) || clip.start < 0 || !Number.isFinite(clip.trimStart) || clip.trimStart < 0 || !Number.isFinite(clip.trimEnd) || clip.trimEnd < 0 || clip.trimStart + clip.trimEnd >= buffer.duration) throw new Error('invalid clip');
          return { name: clip.name || 'Clip', start: clip.start, trimStart: clip.trimStart, trimEnd: clip.trimEnd, buffer };
        }) };
    });
    if (position !== bytes.byteLength || !Number.isSafeInteger(manifest.nextId) || manifest.nextId <= Math.max(0, ...importedTracks.map(t => t.id))) throw new Error('invalid project file');
    if (!window.confirm('Open this project? The current project will be replaced.')) return;
    video.pause(); stopPlayback(); stopMonitoring();
    if (videoURL) URL.revokeObjectURL(videoURL);
    selectedVideo = importedVideo;
    videoURL = importedVideo ? URL.createObjectURL(importedVideo) : null;
    video.removeAttribute('src'); if (videoURL) video.src = videoURL; else video.load();
    $('video-name').textContent = importedVideo?.name || 'No video selected';
    video.muted = !!manifest.videoMuted;
    updateVideoMute();
    tracks.splice(0, tracks.length, ...importedTracks); nextId = manifest.nextId;
    rememberProjectFile(handle);
    renderTracks(); await saveProject(); status(`Project opened: ${file.name}.`);
  } catch (error) { status(`Could not open project: ${error.message}`); }
}
async function newProject() {
  if (recording) { status('Stop recording before starting a new project.'); return; }
  const hasContent = selectedVideo || tracks.some(t => t.clips.length);
  const message = hasContent ? 'Start a new project? The current video and recordings will be cleared. Use “Save project” first to keep a copy.' : 'Start a new project?';
  if (!window.confirm(message)) return;
  video.pause(); stopPlayback(); stopMonitoring();
  if (videoURL) URL.revokeObjectURL(videoURL);
  selectedVideo = null; videoURL = null;
  rememberProjectFile(null);
  video.removeAttribute('src'); video.load();
  $('video-file').value = '';
  $('video-name').textContent = 'No video selected';
  video.muted = false;
  updateVideoMute();
  nextId = 1;
  tracks.splice(0, tracks.length, { id: nextId, name: `Track ${nextId++}`, armed: true, muted: false, clips: [] });
  renderTracks(); await saveProject(); status('New project started.');
}
function exportWav() {
  if (recording) finishRecording();
  const clips = tracks.filter(t => !t.muted).flatMap(t => t.clips);
  if (!clips.length) { status('No unmuted recordings to export.'); return; }
  const rate = context.sampleRate;
  const length = Math.max(1, ...clips.map(c => Math.ceil((c.start + clipDuration(c)) * rate)));
  if (length * 2 + 44 > 0xffffffff) { status('Recording too long for a single WAV.'); return; }
  const mix = new Float32Array(length);
  for (const clip of clips) {
    const data = clip.buffer.getChannelData(0), start = Math.round(clip.start * rate);
    const trim = Math.round((clip.trimStart || 0) * rate), count = Math.round(clipDuration(clip) * rate);
    const fadeSamples = Math.min(Math.round(FADE_SECONDS * rate), (count - 1) / 2);
    for (let i = 0; i < count && trim + i < data.length && start + i < length; i++) {
      const gain = fadeSamples > 0 ? Math.min(1, i / fadeSamples, (count - 1 - i) / fadeSamples) : 0;
      mix[start + i] += data[trim + i] * gain;
    }
  }
  const bytes = new ArrayBuffer(44 + length * 2), view = new DataView(bytes);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) { const sample = Math.max(-1, Math.min(1, mix[i])); view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true); }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const link = document.createElement('a'); link.href = url; link.download = 'recording.wav'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000); status('WAV exported.');
}
$('video-file').onchange = event => {
  const file = event.target.files[0]; if (!file) return;
  if (recording) finishRecording(); stopPlayback();
  if (videoURL) URL.revokeObjectURL(videoURL);
  selectedVideo = file;
  videoURL = URL.createObjectURL(file); video.src = videoURL;
  saveProject();
  $('video-name').textContent = file.name; status('Video loaded. Press Play or Record.');
};
$('video-mute').onclick = () => { video.muted = !video.muted; updateVideoMute(); saveProject(); };
$('add-track').onclick = addTrack;
$('record').onclick = toggleRecording;
$('export').onclick = exportWav;
$('new-project').onclick = newProject;
$('save-project').onclick = saveProjectFile;
$('open-project-button').onclick = async () => {
  if (!window.showOpenFilePicker) { $('open-project').click(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({ types: PROJECT_TYPES });
    await openProject(await handle.getFile(), handle);
  } catch (error) { if (error.name !== 'AbortError') status(`Could not open project: ${error.message}`); }
};
$('open-project').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) await openProject(file);
};
for (const tip of document.querySelectorAll('.tip')) tip.addEventListener('toggle', event => {
  const button = document.querySelector(`[popovertarget="${tip.id}"]`);
  button.classList.toggle('open', event.newState === 'open');
  if (event.newState !== 'open') return;
  const anchor = button.getBoundingClientRect();
  const left = Math.min(Math.max(12, anchor.right - tip.offsetWidth), window.innerWidth - tip.offsetWidth - 12);
  const below = anchor.bottom + 8, above = anchor.top - tip.offsetHeight - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${below + tip.offsetHeight > window.innerHeight - 12 && above > 12 ? above : below}px`;
});
$('open-settings').onclick = () => $('device-dialog').showModal();
$('output-device').onchange = setOutput;
$('input-device').onchange = () => { if (!recording && stream) stopMonitoring(); };
$('test-mic').onclick = async () => {
  if (recording) return;
  if (stream) { stopMonitoring(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { status('Microphone only available on localhost or HTTPS.'); return; }
  $('test-mic').disabled = true;
  try { await startMonitoring(); } catch (error) { stopMonitoring(); status(`Microphone unavailable: ${error.message}`); }
  finally { $('test-mic').disabled = false; }
};
document.addEventListener('keydown', async event => {
  const isSpace = event.code === 'Space';
  const isRecord = event.key === '*' || event.code === 'NumpadMultiply';
  if ((!isSpace && !isRecord) || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if ($('device-dialog').open) return;
  const target = event.target;
  if (target instanceof Element && target.closest('button, input, select, textarea, a, [contenteditable="true"], [role="button"]')) return;
  if (isRecord) {
    if ($('record').disabled) return;
    event.preventDefault();
    await toggleRecording();
    return;
  }
  if (target === video || !video.src) return;
  event.preventDefault();
  if (video.paused) {
    try { await video.play(); } catch (error) { status(`Playback not started: ${error.message}`); }
  } else video.pause();
});
$('ruler').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !video.src || !Number.isFinite(video.duration)) return;
  event.preventDefault();
  const ruler = $('ruler'), pointer = event.pointerId, wasPlaying = !video.paused;
  const seek = e => {
    const seconds = (e.clientX - ruler.getBoundingClientRect().left) / PX_PER_SECOND;
    video.currentTime = Math.max(0, Math.min(video.duration, seconds));
    updatePlayhead();
  };
  scrubbing = true;
  if (wasPlaying) video.pause();
  ruler.setPointerCapture(pointer); ruler.classList.add('scrubbing');
  seek(event);
  const move = e => { if (e.pointerId === pointer) seek(e); };
  const done = async e => {
    if (e.pointerId !== pointer) return;
    ruler.removeEventListener('pointermove', move); ruler.removeEventListener('pointerup', done); ruler.removeEventListener('pointercancel', done);
    ruler.classList.remove('scrubbing');
    scrubbing = false;
    if (wasPlaying) {
      try { await video.play(); } catch (error) { status(`Playback not started: ${error.message}`); }
    }
  };
  ruler.addEventListener('pointermove', move); ruler.addEventListener('pointerup', done); ruler.addEventListener('pointercancel', done);
});
window.addEventListener('resize', renderTracks);
video.addEventListener('loadedmetadata', renderTracks);
video.addEventListener('play', async () => { if (context) await context.resume(); syncPlayback(); if (playheadFrame === null) animatePlayhead(); });
video.addEventListener('pause', () => { if (recording) finishRecording(); stopPlayback(); stopPlayhead(); });
video.addEventListener('seeking', () => { if (recording) finishRecording(); stopPlayback(); });
video.addEventListener('timeupdate', updatePlayhead);
video.addEventListener('seeked', () => { syncPlayback(); updatePlayhead(); });
video.addEventListener('ended', () => { if (recording) finishRecording(); stopPlayback(); stopPlayhead(); });
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
for (const id of ['video-file', 'add-track', 'record', 'export', 'new-project', 'save-project', 'open-project', 'open-project-button']) $(id).disabled = true;
restoreProject(); listDevices();
