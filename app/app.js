const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
function setIconButton(button, name, text, tooltip) {
  button.replaceChildren();
  button.insertAdjacentHTML('afterbegin', icon(name));
  button.append(document.createTextNode(text));
  button.title = tooltip;
}
function updateRecordButton() {
  setIconButton($('record'), recording ? 'stop' : 'record', recording ? 'Stop recording' : 'Record', `${recording ? 'Stop recording' : 'Record'} (*)`);
  $('record').classList.toggle('active', recording);
  document.body.classList.toggle('is-recording', recording);
}
function updateMicButton() {
  setIconButton($('test-mic'), 'mic', stream ? 'Microphone on' : 'Turn on microphone', stream ? 'The microphone stays on to show the input level' : 'Turn on the microphone');
  $('test-mic').setAttribute('aria-pressed', String(!!stream));
  $('input-meter').setAttribute('aria-pressed', String(!!stream));
  $('input-meter').title = stream ? 'Input level' : 'Input level: click to turn on the microphone';
}
let meterLevel = 0, clipUntil = 0;
function showInputLevel(peak) {
  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  meterLevel = Math.max(Math.max(0, Math.min(100, (db + 60) / 60 * 100)), meterLevel * .9);
  if (peak >= .99) clipUntil = performance.now() + 1000;
  $('input-meter-fill').style.width = `${meterLevel}%`;
  $('input-meter').classList.toggle('clipping', performance.now() < clipUntil);
}
const video = $('video');
const tracks = [];
let context, stream, source, analyser, meterFrame, processor, silentGain, recording = false, nextId = 1, videoURL;
let playingSources = [];
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600], FRAME_STEPS = [1, 2, 3, 5, 6, 10, 12, 15];
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
let fps = 25;
let pxPerSecond = 80;
let playheadFrame = null, scrubbing = false;
let cursor = null, overPlaying = false, overFrom = 0, overStart = 0;
const videoLength = () => video.src && Number.isFinite(video.duration) ? video.duration : 0;
const clipsEnd = () => Math.max(0, ...tracks.flatMap(t => t.clips.map(c => c.start + clipDuration(c))));
const timelineEnd = () => Math.max(projectLength(), videoLength()) || Math.max(10, clipsEnd());
const openEnded = () => recording && timelineLength === null && !videoLength();
const playPosition = () => overPlaying ? overFrom + Math.max(0, context.currentTime - overStart) : cursor ?? (video.currentTime || 0);
const isPlaying = () => overPlaying || !video.paused;
function startOvertime() {
  if (overPlaying) return;
  const audio = getContext(); audio.resume();
  overFrom = cursor ?? (video.currentTime || 0); overStart = audio.currentTime; overPlaying = true; cursor = null;
  syncPlayback(); if (playheadFrame === null) animatePlayhead();
}
function stopOvertime() {
  if (!overPlaying) return;
  cursor = openEnded() ? playPosition() : Math.min(playPosition(), timelineEnd()); overPlaying = false;
  if (recording) finishRecording();
  stopPlayback(); stopPlayhead();
}
async function play() { if (cursor !== null || !videoLength()) startOvertime(); else await video.play(); }
function pause() { if (overPlaying) stopOvertime(); else video.pause(); }
function seekTo(seconds) {
  const duration = video.duration, time = Math.max(0, Math.min(timelineEnd(), seconds));
  if (time < duration) { cursor = null; video.currentTime = time; }
  else { cursor = time; if (video.currentTime < duration - .01) video.currentTime = Math.max(0, duration - .001); }
  updatePlayhead();
}
function updatePlayhead(scroll = 'smooth') {
  const scroller = $('timeline-scroll'), time = Math.max(0, playPosition());
  const position = time * pxPerSecond;
  $('playhead').style.left = `${position}px`;
  $('time-display').textContent = formatTime(time);
  if (overPlaying && time > +$('ruler').dataset.seconds) renderTracks();
  if (scrubbing || !scroll) return;
  scrollTimelineTo(Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, position - scroller.clientWidth / 2)), scroll === 'instant');
}
let scrollTarget = 0, scrollFrame = null, scrollFrom = 0, scrollStart = 0;
function scrollTimelineTo(target, instant = false) {
  const scroller = $('timeline-scroll');
  scrollTarget = target;
  if (instant) { stopTimelineScroll(); scroller.scrollLeft = target; return; }
  if (scrollFrame !== null) return;
  if (Math.abs(target - scroller.scrollLeft) <= 40) { scroller.scrollLeft = target; return; }
  scrollFrom = scroller.scrollLeft; scrollStart = performance.now();
  const step = now => {
    const t = Math.min(1, (now - scrollStart) / 350), ease = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    scroller.scrollLeft = scrollFrom + (scrollTarget - scrollFrom) * ease;
    scrollFrame = t < 1 ? requestAnimationFrame(step) : null;
  };
  scrollFrame = requestAnimationFrame(step);
}
function stopTimelineScroll() { if (scrollFrame !== null) cancelAnimationFrame(scrollFrame); scrollFrame = null; }
const clock = whole => `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
function formatTime(seconds) {
  const whole = Math.floor(seconds + 1e-6), frame = Math.min(Math.round(fps) - 1, Math.floor((seconds - whole) * fps + 1e-3));
  return `${clock(whole)}:${String(Math.max(0, frame)).padStart(2, '0')}`;
}
function setFps(value, file) {
  if (file !== selectedVideo || !Number.isFinite(value) || value < 1 || value > 240) return false;
  fps = STANDARD_FPS.find(f => Math.abs(f - value) < .02) ?? Math.round(value * 1000) / 1000;
  renderTracks(); return true;
}
async function mp4Fps(file) {
  const read = async (at, length) => new DataView(await file.slice(at, at + length).arrayBuffer());
  const type = (view, at) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at, 4));
  const boxes = (view, start, end) => {
    const list = [];
    for (let at = start; at + 8 <= end;) {
      let size = view.getUint32(at), header = 8;
      if (size === 1) { size = Number(view.getBigUint64(at + 8)); header = 16; } else if (size === 0) size = end - at;
      if (size < header || at + size > end) break;
      list.push({ type: type(view, at + 4), body: at + header, end: at + size }); at += size;
    }
    return list;
  };
  const child = (view, box, name) => boxes(view, box.body, box.end).find(b => b.type === name);
  let at = 0, moov = null;
  while (at + 8 <= file.size) {
    const head = await read(at, 16);
    let size = head.getUint32(0);
    if (size === 1) size = Number(head.getBigUint64(8)); else if (size === 0) size = file.size - at;
    if (size < 8) return null;
    if (type(head, 4) === 'moov') { if (size > 256e6) return null; moov = await read(at, size); break; }
    at += size;
  }
  if (!moov) return null;
  for (const trak of boxes(moov, 8, moov.byteLength).filter(b => b.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia'), hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!hdlr || type(moov, hdlr.body + 8) !== 'vide') continue;
    const mdhd = child(moov, mdia, 'mdhd'), minf = child(moov, mdia, 'minf'), stbl = minf && child(moov, minf, 'stbl'), stts = stbl && child(moov, stbl, 'stts');
    if (!mdhd || !stts) return null;
    const timescale = moov.getUint32(mdhd.body + (moov.getUint8(mdhd.body) === 1 ? 20 : 12));
    let samples = 0, duration = 0;
    for (let i = 0, count = moov.getUint32(stts.body + 4); i < count; i++) {
      const n = moov.getUint32(stts.body + 8 + i * 8); samples += n; duration += n * moov.getUint32(stts.body + 12 + i * 8);
    }
    return duration ? timescale * samples / duration : null;
  }
  return null;
}
async function webmFps(file) {
  const bytes = new Uint8Array(await file.slice(0, 4 << 20).arrayBuffer());
  const vint = (at, keepMarker) => {
    const length = Math.clz32(bytes[at]) - 23;
    if (length < 1 || length > 8) return null;
    let value = keepMarker ? bytes[at] : bytes[at] & (0xff >> length);
    for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
    return { value, length };
  };
  const elements = (start, end) => {
    const list = [];
    for (let at = start; at < end;) {
      const id = vint(at, true), size = id && vint(at + id.length);
      if (!size) break;
      const body = at + id.length + size.length;
      list.push({ id: id.value, body, end: Math.min(end, body + size.value) }); at = body + size.value;
    }
    return list;
  };
  const uint = e => { let value = 0; for (let i = e.body; i < e.end; i++) value = value * 256 + bytes[i]; return value; };
  for (let at = 0; at + 4 < bytes.length; at++) {
    if (bytes[at] !== 0x16 || bytes[at + 1] !== 0x54 || bytes[at + 2] !== 0xae || bytes[at + 3] !== 0x6b) continue;
    const size = vint(at + 4);
    if (!size) continue;
    for (const entry of elements(at + 4 + size.length, Math.min(bytes.length, at + 4 + size.length + size.value)).filter(e => e.id === 0xae)) {
      const fields = elements(entry.body, entry.end), kind = fields.find(e => e.id === 0x83), frame = fields.find(e => e.id === 0x23e383);
      if (kind && uint(kind) === 1) return frame && uint(frame) ? 1e9 / uint(frame) : null;
    }
  }
  return null;
}
function measureFps(file) {
  if (!video.requestVideoFrameCallback) return;
  const times = [];
  const step = (now, frame) => {
    if (file !== selectedVideo) return;
    times.push(frame.mediaTime);
    if (times.length < 40) { video.requestVideoFrameCallback(step); return; }
    const deltas = times.slice(1).map((t, i) => t - times[i]).filter(d => d > 0).sort((a, b) => a - b);
    if (deltas.length) setFps(1 / deltas[Math.floor(deltas.length / 2)], file);
  };
  video.requestVideoFrameCallback(step);
}
async function detectFps() {
  const file = selectedVideo;
  if (!file) return;
  let value = null;
  try { value = await mp4Fps(file) ?? await webmFps(file); } catch {}
  if (!setFps(value, file)) measureFps(file);
}
function animatePlayhead() {
  if (overPlaying && !openEnded() && playPosition() >= timelineEnd()) { playheadFrame = null; stopOvertime(); return; }
  updatePlayhead();
  if (isPlaying() && !(video.ended && !overPlaying)) playheadFrame = requestAnimationFrame(animatePlayhead);
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
  return { nextId, projectName, timelineLength, videoFile: selectedVideo, videoMuted: video.muted,
    tracks: tracks.map(t => ({ id: t.id, name: t.name || `Track ${t.id}`, armed: t.armed, muted: t.muted, volume: t.volume ?? 1, color: trackColor(t),
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
        tracks.push({ id: saved.id, name: saved.name || `Track ${saved.id}`, armed: saved.armed, muted: saved.muted, volume: validVolume(saved.volume) ? saved.volume : 1, color: validColor(saved.color) ? saved.color : undefined, clips });
      }
      nextId = data.nextId; timelineLength = validLength(data.timelineLength ?? null) ? data.timelineLength ?? null : null;
      showProjectName(typeof data.projectName === 'string' ? data.projectName : projectHandle?.name);
      selectedVideo = data.videoFile || null;
      if (selectedVideo) {
        videoURL = URL.createObjectURL(selectedVideo); video.src = videoURL;
        showVideoName(selectedVideo.name);
      }
      video.muted = !!data.videoMuted;
      status('Project restored from the browser.');
    } else tracks.push({ id: nextId, name: `Track ${nextId++}`, armed: true, muted: false, clips: [] });
  } catch (error) {
    tracks.length = 0;
    tracks.push({ id: nextId, name: `Track ${nextId++}`, armed: true, muted: false, clips: [] });
    status(`Local storage unavailable: ${error.message}`);
  } finally {
    restoring = false; clearHistory(); renderTracks();
    for (const id of ['video-file', 'add-track', 'import-audio', 'record', 'export', 'new-project', 'save-project', 'open-project', 'open-project-button']) $(id).disabled = false;
  }
}
function formatSpan(seconds) {
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(Math.round(seconds) / 60);
  return `${minutes}:${String(Math.round(seconds) - minutes * 60).padStart(2, '0')} min`;
}
let timelineLength = null;
const validLength = value => value === null || (Number.isFinite(value) && value > 0 && value <= 86400);
const projectLength = () => timelineLength ?? (Number.isFinite(video.duration) ? video.duration : 0);
function parseLength(text) {
  const parts = text.trim().split(':').map(part => part.trim());
  if (!parts.length || parts.length > 3 || parts.some(part => !/^\d+(\.\d+)?$/.test(part))) return NaN;
  const [a, b, c] = parts.map(Number);
  if (parts.length === 1) return a;
  if (parts.length === 2) return b < 60 ? a * 60 + b : NaN;
  return b < 60 && c < Math.round(fps) ? a * 60 + b + c / fps : NaN;
}
function updateLengthField() {
  const input = $('timeline-length');
  if (document.activeElement === input) return;
  input.value = timelineLength === null ? '' : formatTime(timelineLength);
  input.placeholder = Number.isFinite(video.duration) ? formatTime(video.duration) : 'Auto';
}
function setTimelineLength(text) {
  const value = text.trim() ? parseLength(text) : null;
  if (!validLength(value)) { status('Invalid length: use mm:ss:ff, mm:ss or seconds.'); updateLengthField(); return; }
  if (value === timelineLength) { updateLengthField(); return; }
  remember('change length'); timelineLength = value;
  renderTracks(); saveProject(); status(value === null ? 'Timeline length follows the video.' : `Timeline length: ${formatTime(value)}.`);
}
function renderTimeline() {
  const duration = projectLength();
  const end = Math.max(duration, clipsEnd(), overPlaying ? playPosition() + 5 : 0);
  const full = duration || Math.max(10, end), lane = Math.max(100, $('timeline-scroll').clientWidth);
  const visible = Math.min(full, full ** (1 - $('zoom').value / 1000));
  pxPerSecond = lane / visible;
  $('zoom-level').textContent = formatSpan(visible);
  const fit = visible >= end, seconds = fit ? visible : Math.ceil(end + 2), width = fit ? lane : seconds * pxPerSecond;
  const tail = fit ? 0 : Math.ceil($('timeline-scroll').clientWidth / 2);
  $('timeline').style.width = `${width + tail}px`;
  $('ruler').style.width = `${width + tail}px`;
  const endMarker = $('timeline-end');
  endMarker.hidden = !duration; endMarker.style.left = `${duration * pxPerSecond}px`;
  updateLengthField();
  updatePlayhead(false);
  $('ruler').dataset.seconds = seconds;
  const frame = pxPerSecond / fps, nominal = Math.round(fps);
  const frameStep = FRAME_STEPS.find(n => n < nominal && nominal % n === 0 && n * frame >= 120);
  const step = frameStep ? frameStep / fps : TICK_STEPS.find(s => s * pxPerSecond >= 120) ?? TICK_STEPS.at(-1);
  $('timeline').style.setProperty('--grid', `${frame >= 12 ? frame : step * pxPerSecond / 2}px`);
  renderTicks();
}
function renderTicks() {
  const ruler = $('ruler'), scroller = $('timeline-scroll'), seconds = +ruler.dataset.seconds || 0;
  const frame = pxPerSecond / fps, nominal = Math.round(fps);
  const frameStep = FRAME_STEPS.find(n => n < nominal && nominal % n === 0 && n * frame >= 120);
  const from = Math.max(0, (scroller.scrollLeft - scroller.clientWidth) / pxPerSecond), to = Math.min(seconds, (scroller.scrollLeft + 2 * scroller.clientWidth) / pxPerSecond);
  const ticks = [];
  if (frameStep) {
    for (let s = Math.floor(from); s <= to; s++) for (let f = 0; f < nominal; f += frameStep) if (s + f / fps >= from && s + f / fps <= to) ticks.push([s + f / fps, `${clock(s)}:${String(f).padStart(2, '0')}`]);
  } else {
    const step = TICK_STEPS.find(s => s * pxPerSecond >= 120) ?? TICK_STEPS.at(-1);
    for (let s = Math.ceil(from / step) * step; s <= to; s += step) ticks.push([s, clock(s)]);
  }
  ruler.replaceChildren(...ticks.map(([s, label]) => {
    const tick = document.createElement('span'); tick.className = 'tick'; tick.style.left = `${s * pxPerSecond}px`; tick.textContent = label; return tick;
  }));
}
const rescale = () => { renderTracks(); updatePlayhead('instant'); };
const zoomBy = steps => { $('zoom').value = +$('zoom').value + steps * 50; rescale(); };
function editClip(event, clip, mode, element) {
  event.preventDefault(); event.stopPropagation();
  const pointer = event.pointerId, x = event.clientX, before = snapshot(), wasSelected = selectedClips.has(clip);
  if (event.shiftKey) { selectClip(clip, true); if (!selectedClips.has(clip)) return; }
  else if (!wasSelected || mode !== 'move') selectClip(clip, false);
  const original = { start: clip.start, trimStart: clip.trimStart || 0, trimEnd: clip.trimEnd || 0 };
  const minimum = Math.min(.05, clip.buffer.duration), rows = [...$('tracks').children];
  const trackIndex = c => tracks.findIndex(t => t.clips.includes(c)), sourceIndex = trackIndex(clip);
  const items = (mode === 'move' ? [...selectedClips] : [clip]).map(c => ({ clip: c, element: clipElements.get(c), start: c.start, index: trackIndex(c) }));
  const earliest = Math.min(...items.map(i => i.start)), lowest = Math.min(...items.map(i => i.index)), highest = Math.max(...items.map(i => i.index));
  const rowTop = index => rows[index].getBoundingClientRect().top;
  let offset = 0, moved = false;
  const copying = mode === 'move' && event.altKey, ghosts = [];
  element.setPointerCapture(pointer);
  for (const item of items) {
    item.element?.classList.add('dragging'); item.element?.classList.toggle('copying', copying);
    if (copying && item.element) {
      const ghost = document.createElement('div'); ghost.className = 'clip-ghost';
      Object.assign(ghost.style, { left: item.element.style.left, width: item.element.style.width });
      item.element.before(ghost); ghosts.push(ghost);
    }
  }
  const place = item => {
    item.element.style.left = `${item.clip.start * pxPerSecond}px`;
    item.element.style.width = `${Math.max(8, clipDuration(item.clip) * pxPerSecond)}px`;
    const wave = item.element.querySelector('.clip-wave');
    if (wave) wave.style.left = `${-(item.clip.trimStart || 0) * pxPerSecond}px`;
  };
  const move = e => {
    if (e.pointerId !== pointer) return;
    moved = true;
    const delta = (e.clientX - x) / pxPerSecond;
    if (mode === 'move') {
      const index = rows.findIndex(row => { const box = row.getBoundingClientRect(); return e.clientY >= box.top && e.clientY < box.bottom; });
      if (index >= 0) offset = Math.max(-lowest, Math.min(tracks.length - 1 - highest, index - sourceIndex));
      const shift = offset ? 0 : Math.max(-earliest, delta), targets = new Set(offset ? items.map(i => i.index + offset) : []);
      rows.forEach((row, i) => row.classList.toggle('drop-target', targets.has(i)));
      for (const item of items) {
        if (!item.element) continue;
        item.clip.start = item.start + shift; place(item);
        item.element.style.transform = offset ? `translateY(${rowTop(item.index + offset) - rowTop(item.index)}px)` : '';
      }
      return;
    }
    if (mode === 'left') {
      const change = Math.max(-original.trimStart, -original.start, Math.min(delta, clip.buffer.duration - original.trimStart - original.trimEnd - minimum));
      clip.trimStart = original.trimStart + change;
      clip.start = original.start + change;
    }
    if (mode === 'right') clip.trimEnd = Math.max(0, Math.min(clip.buffer.duration - original.trimStart - minimum, original.trimEnd - delta));
    place(items[0]);
  };
  const done = e => {
    if (e.pointerId !== pointer) return;
    element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', done); element.removeEventListener('pointercancel', done);
    for (const item of items) if (item.element) { item.element.classList.remove('dragging', 'copying'); item.element.style.transform = ''; }
    rows.forEach(row => row.classList.remove('drop-target')); ghosts.forEach(ghost => ghost.remove());
    const count = items.length, what = count === 1 ? 'clip' : `${count} clips`;
    if (copying) {
      const copies = items.map(item => ({ ...item.clip, start: item.clip.start, index: item.index + offset, source: item }));
      for (const item of items) item.clip.start = item.start;
      if (e.type === 'pointerup' && (offset || copies.some(c => c.start !== c.source.start))) {
        remember(`duplicate ${what}`, before);
        selectedClips.clear();
        for (const { index, source, ...copy } of copies) { tracks[index].clips.push(copy); selectedClips.add(copy); }
        renderTracks(); syncPlayback(); saveProject(); status(`${count === 1 ? clip.name || 'Clip' : `${count} clips`} duplicated.`);
      } else renderTracks();
    } else if (offset && e.type === 'pointerup') {
      const label = items.every(i => i.index === items[0].index) ? tracks[items[0].index + offset].name : `${Math.abs(offset)} track${Math.abs(offset) === 1 ? '' : 's'} ${offset > 0 ? 'down' : 'up'}`;
      remember(`move ${what} to ${label}`, before);
      for (const item of items) { const from = tracks[item.index].clips; from.splice(from.indexOf(item.clip), 1); }
      for (const item of items) tracks[item.index + offset].clips.push(item.clip);
      renderTracks(); syncPlayback(); saveProject(); status(`${count === 1 ? clip.name || 'Clip' : `${count} clips`} moved to ${label}.`);
    } else if (items.some(i => i.clip.start !== i.start) || (clip.trimStart || 0) !== original.trimStart || (clip.trimEnd || 0) !== original.trimEnd) {
      remember(mode === 'move' ? `move ${what}` : 'trim clip', before);
      renderTracks(); syncPlayback(); saveProject();
    } else if (!moved && !event.shiftKey && wasSelected && selectedClips.size > 1) selectClip(clip, false);
  };
  element.addEventListener('pointermove', move); element.addEventListener('pointerup', done); element.addEventListener('pointercancel', done);
}

const STATUS_ERROR = /^(Invalid length|Could not|Local save failed|Local storage unavailable|Microphone|Devices unavailable|Playback not started|Recording not started|Audio output:|Enable REC|Stop recording before|No unmuted|Recording too long)/;
let statusTimer = null;
const status = text => {
  const box = $('status');
  box.textContent = text; box.dataset.kind = STATUS_ERROR.test(text) ? 'error' : 'info';
  box.classList.remove('flash', 'faded'); void box.offsetWidth; box.classList.add('flash');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(function hide() { if (recording) statusTimer = setTimeout(hide, 1000); else box.classList.add('faded'); }, 5000);
};

function ask(title, message, action, danger = true) {
  const dialog = $('confirm-dialog'), ok = $('confirm-ok');
  if (dialog.open) return Promise.resolve(false);
  $('confirm-title').textContent = title; $('confirm-message').textContent = message;
  ok.textContent = action; ok.className = danger ? 'danger' : 'accent';
  dialog.returnValue = ''; dialog.showModal(); (danger ? $('confirm-cancel') : ok).focus();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}
function editName(element, value, commit) {
  if (element.isContentEditable) return;
  try { element.contentEditable = 'plaintext-only'; } catch { element.contentEditable = 'true'; }
  element.spellcheck = false; element.classList.add('editing'); element.focus();
  getSelection().selectAllChildren(element);
  const off = new AbortController();
  const finish = save => {
    off.abort();
    const name = element.textContent.replace(/\s+/g, ' ').trim();
    element.removeAttribute('contenteditable'); element.classList.remove('editing'); element.scrollLeft = 0;
    if (save && name && name !== value) commit(name); else element.textContent = value;
  };
  element.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  }, { signal: off.signal });
  element.addEventListener('blur', () => finish(true), { signal: off.signal });
  element.addEventListener('pointerdown', e => e.stopPropagation(), { signal: off.signal });
}
const undoStack = [], redoStack = [], selectedClips = new Set(), clipElements = new Map();
const snapshot = () => ({ nextId, length: timelineLength, tracks: tracks.map(({ pending, ...t }) => ({ ...t, clips: t.clips.map(c => ({ ...c })) })) });
function updateHistoryButtons() {
  $('undo').disabled = !undoStack.length; $('undo').title = undoStack.length ? `Undo ${undoStack.at(-1).label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  $('redo').disabled = !redoStack.length; $('redo').title = redoStack.length ? `Redo ${redoStack.at(-1).label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
}
function remember(label, state = snapshot()) {
  undoStack.push({ label, state }); if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0; updateHistoryButtons();
}
function clearHistory() { undoStack.length = 0; redoStack.length = 0; selectedClips.clear(); updateHistoryButtons(); }
function travel(from, to, verb) {
  if (recording) { status(`Stop recording before ${verb === 'Undo' ? 'undoing' : 'redoing'}.`); return; }
  if (!from.length) return;
  const { label, state } = from.pop();
  to.push({ label, state: snapshot() });
  tracks.splice(0, tracks.length, ...state.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c })) }))); nextId = state.nextId; timelineLength = state.length ?? null;
  selectedClips.clear(); updateHistoryButtons();
  renderTracks(); syncPlayback(); saveProject(); status(`${verb}: ${label}.`);
}
const undo = () => travel(undoStack, redoStack, 'Undo'), redo = () => travel(redoStack, undoStack, 'Redo');
function updateSelection() { for (const [clip, element] of clipElements) element.classList.toggle('selected', selectedClips.has(clip)); }
function selectClip(clip, toggle) {
  if (!toggle) selectedClips.clear();
  if (toggle && selectedClips.has(clip)) selectedClips.delete(clip); else selectedClips.add(clip);
  updateSelection();
}
function selectArea(event, lane) {
  event.preventDefault();
  const timeline = $('timeline'), pointer = event.pointerId, base = new Set(event.shiftKey ? selectedClips : []);
  const origin = { x: event.clientX - timeline.getBoundingClientRect().left, y: event.clientY - timeline.getBoundingClientRect().top };
  let box = null;
  if (!event.shiftKey && selectedClips.size) { selectedClips.clear(); updateSelection(); }
  lane.setPointerCapture(pointer);
  const move = e => {
    if (e.pointerId !== pointer) return;
    const area = timeline.getBoundingClientRect(), x = e.clientX - area.left, y = e.clientY - area.top;
    if (!box && Math.hypot(x - origin.x, y - origin.y) < 4) return;
    if (!box) { box = document.createElement('div'); box.className = 'marquee'; timeline.append(box); }
    const left = Math.min(x, origin.x), top = Math.min(y, origin.y), right = Math.max(x, origin.x), bottom = Math.max(y, origin.y);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    selectedClips.clear(); for (const clip of base) selectedClips.add(clip);
    for (const [clip, element] of clipElements) {
      const r = element.getBoundingClientRect();
      if (r.right - area.left > left && r.left - area.left < right && r.bottom - area.top > top && r.top - area.top < bottom) selectedClips.add(clip);
    }
    updateSelection();
  };
  const done = e => {
    if (e.pointerId !== pointer) return;
    lane.removeEventListener('pointermove', move); lane.removeEventListener('pointerup', done); lane.removeEventListener('pointercancel', done);
    box?.remove();
  };
  lane.addEventListener('pointermove', move); lane.addEventListener('pointerup', done); lane.addEventListener('pointercancel', done);
}
async function importAudio(files, track = tracks.find(t => t.armed) ?? tracks[0], start = playPosition()) {
  if (recording || !files.length || !track) return;
  const audio = getContext(), clips = [], failed = [];
  status(`Importing ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
  for (const file of files) {
    try {
      const decoded = await audio.decodeAudioData(await file.arrayBuffer());
      const buffer = audio.createBuffer(1, decoded.length, decoded.sampleRate), mono = buffer.getChannelData(0);
      for (let c = 0; c < decoded.numberOfChannels; c++) { const data = decoded.getChannelData(c); for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels; }
      clips.push({ name: file.name.replace(/\.[^.]+$/, '') || 'Clip', start: Math.max(0, start), trimStart: 0, trimEnd: 0, buffer }); start += decoded.duration;
    } catch { failed.push(file.name); }
  }
  if (!tracks.includes(track) || recording) return;
  if (clips.length) {
    remember(clips.length === 1 ? 'import clip' : `import ${clips.length} clips`);
    track.clips.push(...clips); selectedClips.clear(); clips.forEach(clip => selectedClips.add(clip));
    renderTracks(); syncPlayback(); saveProject();
  }
  const imported = clips.length ? `${clips.length === 1 ? clips[0].name : `${clips.length} clips`} imported on ${track.name}.` : '';
  status(failed.length ? `Could not import ${failed.join(', ')}: unsupported audio. ${imported}`.trim() : imported);
}
function deleteSelectedClips() {
  const count = tracks.reduce((sum, t) => sum + t.clips.filter(c => selectedClips.has(c)).length, 0);
  if (recording || !count) return;
  remember(count === 1 ? 'remove clip' : `remove ${count} clips`);
  for (const track of tracks) track.clips = track.clips.filter(c => !selectedClips.has(c));
  selectedClips.clear();
  renderTracks(); syncPlayback(); saveProject(); status(`${count} clip${count === 1 ? '' : 's'} removed.`);
}
function askName(title, value, action) {
  const dialog = $('name-dialog'), input = $('name-input');
  if (dialog.open) return Promise.resolve(null);
  $('name-title').textContent = title; $('name-ok').textContent = action; input.value = value;
  dialog.returnValue = ''; dialog.showModal(); input.focus(); input.select();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' && input.value.trim() ? input.value.replace(/\s+/g, ' ').trim() : null), { once: true }));
}
function armTrack(track) { for (const t of tracks) t.armed = t === track; }
async function addTrack() {
  if (recording) return;
  const name = await askName('New track', `Track ${nextId}`, 'Add track');
  if (name === null || recording) return;
  remember('add track');
  const track = { id: nextId++, name, armed: true, muted: false, clips: [] };
  tracks.push(track); armTrack(track);
  renderTracks(); saveProject(); status(`Track added: ${name}.`);
}
function drawWaveform(clip) {
  const width = Math.ceil(clip.buffer.duration * pxPerSecond), height = 44;
  if (width < 1) return null;
  const canvas = document.createElement('canvas'), ratio = window.devicePixelRatio || 1;
  canvas.className = 'clip-wave'; canvas.width = Math.min(16000, Math.ceil(width * ratio)); canvas.height = Math.ceil(height * ratio);
  canvas.style.width = `${width}px`; canvas.style.left = `${-(clip.trimStart || 0) * pxPerSecond}px`;
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
  const armed = tracks.filter(t => t.armed);
  if (tracks.length && armed.length !== 1) armTrack(armed[0] ?? tracks[0]);
  renderTimeline();
  $('tracks').replaceChildren(); $('track-heads').replaceChildren(); clipElements.clear();
  const present = new Set(tracks.flatMap(t => t.clips));
  for (const clip of selectedClips) if (!present.has(clip)) selectedClips.delete(clip);
  const laneWidth = Math.ceil(parseInt($('timeline').style.width, 10));
  for (const track of tracks) {
    const row = document.createElement('div'); row.className = 'lane-row'; row.style.setProperty('--track-color', trackColor(track));
    const title = document.createElement('span'); title.className = 'track-name'; title.textContent = track.name;
    title.title = 'Rename track (double-click)';
    title.ondblclick = () => editName(title, track.name, name => { remember('rename track'); track.name = name; renderTracks(); saveProject(); status(`Track renamed: ${name}.`); });
    const rec = document.createElement('button'); rec.type = 'button'; setIconButton(rec, 'record', 'REC', track.armed ? `${track.name} records` : `Record on ${track.name}`); rec.setAttribute('aria-pressed', String(track.armed)); rec.disabled = recording;
    rec.setAttribute('aria-label', `Record on track ${track.id}`);
    rec.onclick = () => { if (track.armed) return; remember('move REC'); armTrack(track); renderTracks(); saveProject(); };
    const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'muted'; setIconButton(mute, track.muted ? 'mute' : 'volume', 'Mute', `Toggle mute on ${track.name}`); mute.setAttribute('aria-pressed', String(track.muted));
    mute.setAttribute('aria-label', `Mute track ${track.id}`);
    mute.onclick = () => { remember(track.muted ? 'unmute' : 'mute'); track.muted = !track.muted; renderTracks(); syncPlayback(); saveProject(); };
    const menu = document.createElement('div'); menu.className = 'menu'; menu.id = `track-menu-${track.id}`; menu.popover = 'auto';
    const more = document.createElement('button'); more.type = 'button'; more.className = 'icon-button ghost track-more'; more.innerHTML = icon('more');
    more.title = `More actions for ${track.name}`; more.setAttribute('aria-label', `More actions for track ${track.id}`); more.popoverTargetElement = menu;
    menu.addEventListener('toggle', event => { more.classList.toggle('open', event.newState === 'open'); if (event.newState === 'open') anchorPopover(menu, more); });
    const remove = document.createElement('button'); remove.type = 'button'; setIconButton(remove, 'trash', 'Remove track', `Remove ${track.name}`);
    remove.className = 'menu-item danger-item'; remove.disabled = recording;
    remove.onclick = async () => {
      menu.hidePopover();
      if (track.clips.length && !await ask(`Remove ${track.name}?`, 'The track and all its recordings will be deleted.', 'Remove track')) return;
      const index = tracks.indexOf(track);
      if (index < 0) return;
      remember('remove track');
      tracks.splice(index, 1);
      renderTracks(); syncPlayback(); saveProject(); status(`Track ${track.id} removed.`);
    };
    const swatches = document.createElement('div'); swatches.className = 'swatches'; swatches.setAttribute('role', 'group'); swatches.setAttribute('aria-label', 'Track color');
    for (const [label, color] of TRACK_COLORS) {
      const swatch = document.createElement('button'); swatch.type = 'button'; swatch.className = 'swatch'; swatch.style.setProperty('--swatch', color);
      swatch.title = `${label}`; swatch.setAttribute('aria-label', label); swatch.setAttribute('aria-pressed', String(trackColor(track) === color));
      swatch.onclick = () => { menu.hidePopover(); if (trackColor(track) === color) return; remember('change color'); track.color = color; renderTracks(); saveProject(); };
      swatches.append(swatch);
    }
    const colorLabel = document.createElement('span'); colorLabel.className = 'menu-label'; colorLabel.textContent = 'Color';
    const separator = document.createElement('div'); separator.className = 'menu-separator'; separator.setAttribute('role', 'separator');
    menu.append(colorLabel, swatches, separator, remove);
    const top = document.createElement('div'); top.className = 'track-head-top'; top.append(title, more, menu);
    const volume = document.createElement('input'); volume.type = 'range'; volume.className = 'track-volume'; volume.min = 0; volume.max = 200; volume.value = Math.round((track.volume ?? 1) * 100);
    volume.setAttribute('aria-label', `Volume of track ${track.id}`);
    const level = document.createElement('span'); level.className = 'track-volume-level';
    const showVolume = () => { level.textContent = `${volume.value}%`; volume.title = `Volume ${volume.value}% (double-click: 100%)`; volume.setAttribute('aria-valuetext', `${volume.value}%`); };
    let adjusting = false;
    volume.oninput = () => { if (!adjusting) { remember('change volume'); adjusting = true; } track.volume = volume.value / 100; showVolume(); applyVolume(track); };
    volume.onchange = () => { adjusting = false; saveProject(); };
    volume.ondblclick = () => { if (volume.value === '100') return; volume.value = 100; volume.oninput(); volume.onchange(); };
    showVolume();
    const bottom = document.createElement('div'); bottom.className = 'track-head-bottom'; bottom.append(rec, mute, volume, level);
    const head = document.createElement('div'); head.className = 'track-head'; head.style.setProperty('--track-color', trackColor(track)); head.append(top, bottom); $('track-heads').append(head);
    const lane = document.createElement('div'); lane.className = 'clip-lane'; lane.style.width = `${laneWidth}px`;
    lane.addEventListener('pointerdown', e => { if (e.target === lane && e.button === 0) selectArea(e, lane); });
    for (const clip of track.clips) {
      const block = document.createElement('div'); block.className = `clip${track.muted ? ' muted-clip' : ''}${selectedClips.has(clip) ? ' selected' : ''}`;
      clipElements.set(clip, block);
      block.style.left = `${clip.start * pxPerSecond}px`;
      block.style.width = `${Math.max(8, clipDuration(clip) * pxPerSecond)}px`;
      block.title = `${clip.name || 'Clip'} · ${clip.start.toFixed(2)} s · ${clipDuration(clip).toFixed(2)} s · Select (click, Shift+click to add) · Rename (double-click)`;
      const wave = drawWaveform(clip);
      if (wave) block.append(wave);
      const label = document.createElement('span'); label.className = 'clip-label'; label.textContent = clip.name || 'Clip'; block.append(label);
      for (const side of ['left', 'right']) {
        const handle = document.createElement('span'); handle.className = `clip-handle ${side}`;
        handle.setAttribute('aria-label', `Edit clip ${side === 'left' ? 'start' : 'end'}`);
        handle.title = `Edit clip ${side === 'left' ? 'start' : 'end'} (drag)`;
        handle.addEventListener('pointerdown', e => editClip(e, clip, side, block)); block.append(handle);
      }
      block.addEventListener('pointerdown', e => { if (e.target === block) editClip(e, clip, 'move', block); });
      block.addEventListener('dblclick', e => {
        if (e.target !== block) return;
        e.stopPropagation();
        editName(label, clip.name || 'Clip', name => { remember('rename clip'); clip.name = name; renderTracks(); saveProject(); status(`Clip renamed: ${name}.`); });
      });
      lane.append(block);
    }
    if (track.pending) {
      const block = document.createElement('div'); block.className = 'clip recording-clip'; block.style.left = `${track.pending.start * pxPerSecond}px`;
      const label = document.createElement('span'); label.className = 'clip-label'; label.textContent = 'Recording…'; block.append(label);
      lane.append(block); recordingPreview = { track, element: block, segments: [], peaks: [], chunk: 0, offset: 0, sample: 0, drawn: 0, scale: pxPerSecond };
    }
    row.append(lane); $('tracks').append(row);
  }
}
let recordingPreview = null;
const PREVIEW_SEGMENT = 1024;
function updateRecordingPreview() {
  const preview = recordingPreview;
  if (!recording) { recordingPreview = null; return; }
  requestAnimationFrame(updateRecordingPreview);
  if (!preview?.element.isConnected || !preview.track.pending) return;
  const { chunks, sampleRate, length = 0 } = preview.track.pending, perPixel = sampleRate / preview.scale, peaks = preview.peaks;
  preview.element.style.width = `${Math.max(2, length / sampleRate * pxPerSecond)}px`;
  for (; preview.chunk < chunks.length; preview.chunk++, preview.offset = 0) {
    const data = chunks[preview.chunk];
    for (; preview.offset < data.length; preview.offset++, preview.sample++) {
      const column = Math.floor(preview.sample / perPixel), value = Math.abs(data[preview.offset]);
      if (!(peaks[column] >= value)) peaks[column] = value;
    }
  }
  const ratio = window.devicePixelRatio || 1, height = 44, middle = height * ratio / 2;
  for (let x = Math.max(0, preview.drawn - 1); x < peaks.length; x++) {
    const index = Math.floor(x / PREVIEW_SEGMENT);
    let canvas = preview.segments[index];
    if (!canvas) {
      canvas = document.createElement('canvas'); canvas.className = 'clip-wave';
      canvas.width = PREVIEW_SEGMENT * ratio; canvas.height = height * ratio;
      canvas.style.width = `${PREVIEW_SEGMENT}px`; canvas.style.left = `${index * PREVIEW_SEGMENT}px`;
      preview.element.prepend(canvas); preview.segments[index] = canvas;
    }
    const g = canvas.getContext('2d'), bar = Math.max(ratio / 2, Math.min(1, (peaks[x] || 0) * 1.6) * middle * .85);
    g.fillStyle = 'rgba(255,235,240,.8)'; g.clearRect((x % PREVIEW_SEGMENT) * ratio, 0, ratio, height * ratio); g.fillRect((x % PREVIEW_SEGMENT) * ratio, middle - bar, ratio, bar * 2);
  }
  preview.drawn = peaks.length;
}
function getContext() { return context ??= new AudioContext(); }
function stopPlayback() { for (const { node, gain, level } of playingSources) { try { node.stop(); } catch {} node.disconnect(); gain.disconnect(); level.disconnect(); } playingSources = []; }
const validVolume = value => Number.isFinite(value) && value >= 0 && value <= 2;
const TRACK_COLORS = [['Violet', '#8b7bff'], ['Blue', '#4f8cff'], ['Cyan', '#3cc8e6'], ['Green', '#3ee0a1'], ['Yellow', '#ffc857'], ['Orange', '#ff9454'], ['Red', '#ff5f7e'], ['Pink', '#e879f9']];
const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const trackColor = track => validColor(track.color) ? track.color : TRACK_COLORS[(track.id - 1) % TRACK_COLORS.length][1];
function applyVolume(track) { for (const source of playingSources) if (source.track === track) source.level.gain.setTargetAtTime(track.volume, context.currentTime, .02); }
function syncPlayback() {
  stopPlayback();
  if (!isPlaying() || recording || !context) return;
  const now = playPosition();
  for (const track of tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      const elapsed = Math.max(0, now - clip.start);
      const duration = clipDuration(clip);
      if (duration <= 0 || elapsed >= duration) continue;
      const offset = (clip.trimStart || 0) + elapsed;
      const startTime = context.currentTime + Math.max(0, clip.start - now);
      const fade = Math.min(FADE_SECONDS, duration / 2);
      const node = context.createBufferSource(), gain = context.createGain(), level = context.createGain();
      level.gain.value = track.volume ?? 1;
      node.buffer = clip.buffer; node.connect(gain); gain.connect(level); level.connect(context.destination);
      gain.gain.setValueAtTime(fadeGain(elapsed, duration, fade), startTime);
      if (elapsed < fade) gain.gain.linearRampToValueAtTime(1, startTime + fade - elapsed);
      if (elapsed < duration - fade) gain.gain.setValueAtTime(1, startTime + duration - fade - elapsed);
      gain.gain.linearRampToValueAtTime(0, startTime + duration - elapsed);
      node.start(startTime, offset, duration - elapsed);
      playingSources.push({ node, gain, level, track });
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
let monitoring = false, monitorNode = null;
try { monitoring = localStorage.getItem('audiorec-monitor') === 'on'; } catch {}
function updateMonitor() {
  if (monitoring && source && !monitorNode) { monitorNode = context.createGain(); source.connect(monitorNode); monitorNode.connect(context.destination); }
  if ((!monitoring || !source) && monitorNode) { try { source?.disconnect(monitorNode); } catch {} monitorNode.disconnect(); monitorNode = null; }
  $('monitor').setAttribute('aria-pressed', String(monitoring));
  $('monitor').title = monitoring ? 'Stop hearing the microphone' : 'Monitor: hear the microphone, use headphones to avoid feedback';
}
const micProcessing = () => ({ echoCancellation: !monitoring, noiseSuppression: !monitoring, autoGainControl: !monitoring });
async function toggleMonitor() {
  monitoring = !monitoring;
  try { localStorage.setItem('audiorec-monitor', monitoring ? 'on' : 'off'); } catch {}
  if (stream && recording) { for (const track of stream.getAudioTracks()) track.applyConstraints(micProcessing()).catch(() => {}); }
  else if (stream) { stopMonitoring(); try { await startMonitoring(); } catch (error) { stopMonitoring(); status(`Microphone unavailable: ${error.message}`); } }
  if (monitoring && !stream && !recording) {
    if (!navigator.mediaDevices?.getUserMedia) { status('Microphone only available on localhost or HTTPS.'); }
    else try { await startMonitoring(); } catch (error) { stopMonitoring(); status(`Microphone unavailable: ${error.message}`); }
  }
  updateMonitor();
  status(monitoring ? 'Monitor on: you hear the microphone.' : 'Monitor off.');
}
function stopMonitoring() {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  monitorNode?.disconnect(); monitorNode = null;
  source?.disconnect();
  stream?.getTracks().forEach(t => t.stop());
  stream = null; source = null; analyser = null;
  $('mic-level').value = 0; meterLevel = 0; clipUntil = 0; showInputLevel(0);
  $('mic-state').textContent = 'Inactive';
  updateMicButton();
}
let micStarting = null;
function keepMicOn() {
  if (recording || stream || !navigator.mediaDevices?.getUserMedia) return micStarting;
  return micStarting ??= startMonitoring()
    .catch(error => { stopMonitoring(); status(`Microphone unavailable: ${error.message}`); })
    .finally(() => { micStarting = null; });
}
async function startMonitoring() {
  const audio = getContext(); await audio.resume();
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { ...micProcessing(), ...($('input-device').value ? { deviceId: { exact: $('input-device').value } } : {}) } });
  try {
    const input = audio.createMediaStreamSource(mic);
    const meter = audio.createAnalyser(); meter.fftSize = 2048;
    input.connect(meter);
    stream = mic; source = input; analyser = meter; updateMonitor();
    const samples = new Float32Array(meter.fftSize);
    const update = () => {
      if (!analyser) return;
      meter.getFloatTimeDomainData(samples);
      let sum = 0, peak = 0;
      for (const sample of samples) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      const rms = Math.sqrt(sum / samples.length);
      $('mic-level').value = Math.min(100, Math.round(rms * 300)); showInputLevel(peak);
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
  if (tracks.some(t => t.pending?.chunks.length)) remember('recording');
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
  keepMicOn();
}
async function toggleRecording() {
  if (recording) { finishRecording(); return; }
  if (!tracks.some(t => t.armed)) { status('Enable REC on at least one track.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { status('Microphone only available on localhost or HTTPS.'); return; }
  $('record').disabled = true;
  try {
    const audio = getContext(); await audio.resume();
    if (!stream) { await micStarting; if (!stream) await startMonitoring(); }
    stopPlayback();
    if (!isPlaying()) await play();
    const start = playPosition();
    processor = audio.createScriptProcessor(4096, 1, 1);
    silentGain = audio.createGain(); silentGain.gain.value = 0;
    for (const track of tracks) if (track.armed) track.pending = { start, sampleRate: audio.sampleRate, chunks: [] };
    processor.onaudioprocess = event => {
      const chunk = event.inputBuffer.getChannelData(0);
      for (const track of tracks) if (track.pending) { track.pending.chunks.push(new Float32Array(chunk)); track.pending.length = (track.pending.length || 0) + chunk.length; }
    };
    source.connect(processor); processor.connect(silentGain); silentGain.connect(audio.destination);
    recording = true; updateRecordButton(); stopPlayback();
    $('input-device').disabled = true; $('test-mic').disabled = true; renderTracks(); requestAnimationFrame(updateRecordingPreview); status('Recording…');
  } catch (error) {
    for (const track of tracks) delete track.pending;
    status(`Recording not started: ${error.message}`);
  } finally { $('record').disabled = false; }
}
let projectHandle = null;
const PROJECT_TYPES = [{ description: 'Audiorec project', accept: { 'application/octet-stream': ['.audiorec'] } }];
let projectName = null;
function showProjectName(name) {
  projectName = name || null;
  $('project-name').textContent = name ? name.replace(/\.audiorec$/i, '') : 'Untitled project';
  $('project-name').title = name || 'Not saved to a file yet';
}
function rememberProjectFile(handle) {
  projectHandle = handle; showProjectName(handle?.name);
  database().then(db => { db.transaction('project', 'readwrite').objectStore('project').put(handle, 'fileHandle'); }).catch(() => {});
}
function projectBlob() {
    const data = projectData();
    const manifest = {
      version: 4, nextId: data.nextId, length: data.timelineLength, videoMuted: data.videoMuted,
      video: data.videoFile ? { name: data.videoFile.name, type: data.videoFile.type, size: data.videoFile.size } : null,
      tracks: data.tracks.map(track => ({ id: track.id, name: track.name, armed: track.armed, muted: track.muted, volume: track.volume, color: track.color,
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
    const suggested = `${(projectName || 'project').replace(/\.audiorec$/i, '')}.audiorec`;
    if (!window.showSaveFilePicker) {
      const name = await askName('Save project', suggested.replace(/\.audiorec$/i, ''), 'Download');
      if (name === null) return;
      const fileName = `${name.replace(/[\/:*?"<>|]/g, '-')}.audiorec`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      showProjectName(fileName); saveProject();
      status(`Project downloaded as ${fileName} (this browser cannot overwrite files).`);
      return;
    }
    let handle = projectHandle;
    if (handle && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') handle = null;
    handle ??= await window.showSaveFilePicker({ suggestedName: suggested, types: PROJECT_TYPES });
    const writable = await handle.createWritable();
    await writable.write(blob); await writable.close();
    rememberProjectFile(handle); saveProject();
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
    if (![1, 2, 3, 4].includes(manifest.version) || !Array.isArray(manifest.tracks)) throw new Error('unsupported version');
    if (manifest.version >= 4 && !validLength(manifest.length)) throw new Error('invalid length');
    let position = 12 + jsonLength;
    const videoSize = manifest.video?.size || 0;
    if (!Number.isSafeInteger(videoSize) || videoSize < 0 || videoSize > bytes.byteLength - position) throw new Error('invalid video');
    const importedVideo = manifest.video ? new File([bytes.slice(position, position + videoSize)], manifest.video.name, { type: manifest.video.type }) : null;
    position += videoSize;
    const audio = getContext();
    const importedTracks = manifest.tracks.map(track => {
      if (!Array.isArray(track.clips) || !Number.isSafeInteger(track.id)) throw new Error('invalid track');
      if ((manifest.version >= 2 && !validVolume(track.volume)) || (manifest.version >= 3 && !validColor(track.color))) throw new Error('invalid track');
      return { id: track.id, name: track.name || `Track ${track.id}`, armed: !!track.armed, muted: !!track.muted, volume: manifest.version >= 2 ? track.volume : 1, color: manifest.version >= 3 ? track.color : undefined,
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
    if (!await ask('Open project?', 'The current project will be replaced.', 'Open project', false)) return;
    stopOvertime(); cursor = null; video.pause(); stopPlayback();
    if (videoURL) URL.revokeObjectURL(videoURL);
    selectedVideo = importedVideo;
    videoURL = importedVideo ? URL.createObjectURL(importedVideo) : null;
    video.removeAttribute('src'); if (videoURL) video.src = videoURL; else video.load();
    showVideoName(importedVideo?.name);
    video.muted = !!manifest.videoMuted;
    tracks.splice(0, tracks.length, ...importedTracks); nextId = manifest.nextId; timelineLength = manifest.version >= 4 ? manifest.length : null; clearHistory();
    rememberProjectFile(handle); showProjectName(handle?.name || file.name);
    renderTracks(); await saveProject(); status(`Project opened: ${file.name}.`);
  } catch (error) { status(`Could not open project: ${error.message}`); }
}
async function newProject() {
  if (recording) { status('Stop recording before starting a new project.'); return; }
  const hasContent = selectedVideo || tracks.some(t => t.clips.length);
  const message = hasContent ? 'The current video and recordings will be cleared. Use “Save project” first to keep a copy.' : '';
  if (!await ask('Start a new project?', message, 'New project', !!hasContent)) return;
  stopOvertime(); cursor = null; video.pause(); stopPlayback();
  if (videoURL) URL.revokeObjectURL(videoURL);
  selectedVideo = null; videoURL = null;
  rememberProjectFile(null);
  video.removeAttribute('src'); video.load();
  $('video-file').value = '';
  showVideoName(null);
  video.muted = false;
  nextId = 1; timelineLength = null; clearHistory();
  tracks.splice(0, tracks.length, { id: nextId, name: `Track ${nextId++}`, armed: true, muted: false, clips: [] });
  renderTracks(); await saveProject(); status('New project started.');
}
function exportWav() {
  if (recording) finishRecording();
  const clips = tracks.filter(t => !t.muted).flatMap(t => t.clips);
  if (!clips.length) { status('No unmuted recordings to export.'); return; }
  const rate = context.sampleRate;
  const length = projectLength() ? Math.max(1, Math.round(projectLength() * rate)) : Math.max(1, ...clips.map(c => Math.ceil((c.start + clipDuration(c)) * rate)));
  if (length * 2 + 44 > 0xffffffff) { status('Recording too long for a single WAV.'); return; }
  const mix = new Float32Array(length);
  for (const track of tracks) for (const clip of track.muted ? [] : track.clips) {
    const data = clip.buffer.getChannelData(0), start = Math.round(clip.start * rate), volume = track.volume ?? 1;
    const trim = Math.round((clip.trimStart || 0) * rate), count = Math.round(clipDuration(clip) * rate);
    const fadeSamples = Math.min(Math.round(FADE_SECONDS * rate), (count - 1) / 2);
    for (let i = 0; i < count && trim + i < data.length && start + i < length; i++) {
      const gain = fadeSamples > 0 ? Math.min(1, i / fadeSamples, (count - 1 - i) / fadeSamples) : 0;
      mix[start + i] += data[trim + i] * gain * volume;
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
  const fileName = `${(projectName || 'project').replace(/\.audiorec$/i, '').replace(/[\/:*?"<>|]/g, '-')}-audio.wav`;
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000); status(`WAV exported as ${fileName}.`);
}
$('video-file').onchange = event => {
  const file = event.target.files[0]; if (!file) return;
  stopOvertime(); cursor = null;
  if (recording) finishRecording(); stopPlayback();
  if (videoURL) URL.revokeObjectURL(videoURL);
  selectedVideo = file;
  videoURL = URL.createObjectURL(file); video.src = videoURL;
  saveProject();
  showVideoName(file.name); status('Video loaded. Press Play or Record.');
};
function showVideoName(name) {
  $('video-name').textContent = name || 'Choose video';
  $('video-picker').classList.toggle('primary', !name); $('video-mute').hidden = !name;
  $('video-picker').title = name ? `${name}: click to choose another video` : 'Choose video';
}
showVideoName(null);
function updateVideoMute() {
  const button = $('video-mute');
  setIconButton(button, video.muted ? 'mute' : 'volume', `Video audio ${video.muted ? 'off' : 'on'}`, `${video.muted ? 'Unmute' : 'Mute'} video audio`);
  button.setAttribute('aria-pressed', String(video.muted));
}
$('video-mute').onclick = () => { video.muted = !video.muted; };
video.addEventListener('volumechange', () => { updateVideoMute(); if (!restoring) saveProject(); });
updateVideoMute();
for (const id of ['project-menu', 'tracks-menu']) $(id).addEventListener('click', event => { if (event.target.closest('button')) $(id).hidePopover(); });
$('name-cancel').onclick = () => $('name-dialog').close('cancel');
$('add-track').onclick = addTrack;
$('import-audio').onclick = () => $('import-file').click();
$('import-file').onchange = event => { const files = [...event.target.files]; event.target.value = ''; importAudio(files); };
const dropRow = event => [...$('tracks').children].findIndex(row => { const box = row.getBoundingClientRect(); return event.clientY >= box.top && event.clientY < box.bottom; });
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
$('timeline-scroll').addEventListener('dragover', event => {
  if (!hasFiles(event) || recording) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  const index = dropRow(event);
  [...$('tracks').children].forEach((row, i) => row.classList.toggle('drop-target', i === index));
});
$('timeline-scroll').addEventListener('dragleave', event => { if (!$('timeline-scroll').contains(event.relatedTarget)) [...$('tracks').children].forEach(row => row.classList.remove('drop-target')); });
$('timeline-scroll').addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  [...$('tracks').children].forEach(row => row.classList.remove('drop-target'));
  const index = dropRow(event), files = [...event.dataTransfer.files].filter(file => file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm|aif|aiff)$/i.test(file.name));
  if (index < 0 || !files.length) { status('Could not import: drop audio files on a track.'); return; }
  importAudio(files, tracks[index], (event.clientX - $('timeline').getBoundingClientRect().left) / pxPerSecond);
});
$('undo').onclick = undo;
$('redo').onclick = redo;
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
function anchorPopover(tip, button) {
  const anchor = button.getBoundingClientRect();
  const left = Math.min(Math.max(12, anchor.right - tip.offsetWidth), window.innerWidth - tip.offsetWidth - 12);
  const below = anchor.bottom + 8, above = anchor.top - tip.offsetHeight - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${below + tip.offsetHeight > window.innerHeight - 12 && above > 12 ? above : below}px`;
}
for (const tip of document.querySelectorAll('.tip, #project-menu, #tracks-menu')) tip.addEventListener('toggle', event => {
  const button = document.querySelector(`[popovertarget="${tip.id}"]`);
  button.classList.toggle('open', event.newState === 'open');
  if (event.newState === 'open') anchorPopover(tip, button);
});
$('open-settings').onclick = () => $('device-dialog').showModal();
$('input-meter').onclick = () => { context?.resume(); keepMicOn(); };
$('monitor').onclick = toggleMonitor;
updateMonitor();
$('output-device').onchange = setOutput;
$('input-device').onchange = () => { if (!recording) { stopMonitoring(); keepMicOn(); } };
$('test-mic').onclick = async () => {
  if (recording || stream) return;
  if (!navigator.mediaDevices?.getUserMedia) { status('Microphone only available on localhost or HTTPS.'); return; }
  context?.resume(); $('test-mic').disabled = true;
  try { await keepMicOn(); } finally { $('test-mic').disabled = false; }
};
// The input meter is always on; an AudioContext created before any click starts suspended.
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { if (context?.state === 'suspended') context.resume(); }, true);
document.addEventListener('pointerup', event => {
  const control = event.target instanceof Element && event.target.closest('button, input[type="range"]');
  if (control && !control.closest('dialog')) control.blur();
});
document.addEventListener('keydown', async event => {
  const editing = event.target instanceof Element && event.target.closest('input:not([type="range"]), select, textarea, [contenteditable]');
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
    if (editing || document.querySelector('dialog[open]')) return;
    event.preventDefault(); if (key === 'y' || event.shiftKey) redo(); else undo(); return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedClips.size && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); deleteSelectedClips(); return; }
  if (key === 'w' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.video-frame').requestFullscreen(); }
    catch (error) { status(`Could not toggle full screen: ${error.message}`); }
    return;
  }
  if (event.key === 'Escape' && selectedClips.size && !editing && !document.querySelector('dialog[open], :popover-open')) { selectedClips.clear(); updateSelection(); return; }
  const zoom = { '+': 1, '=': 1, '-': -1, '_': -1 }[event.key];
  if (zoom !== undefined && !event.altKey && !event.ctrlKey && !event.metaKey && !document.querySelector('dialog[open]') && !(event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable]'))) {
    event.preventDefault(); zoomBy(zoom); return;
  }
  const isSpace = event.code === 'Space';
  const isRecord = event.key === '*' || event.code === 'NumpadMultiply';
  if ((!isSpace && !isRecord) || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (document.querySelector('dialog[open]')) return;
  const target = event.target;
  if (target instanceof Element && target.closest('button, input, select, textarea, a, [contenteditable="true"], [role="button"]')) return;
  if (isRecord) {
    if ($('record').disabled) return;
    event.preventDefault();
    await toggleRecording();
    return;
  }
  if (target === video) return;
  event.preventDefault();
  if (!isPlaying()) {
    try { await play(); } catch (error) { status(`Playback not started: ${error.message}`); }
  } else pause();
});
$('ruler').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  const ruler = $('ruler'), scroller = $('timeline-scroll'), pointer = event.pointerId, wasPlaying = isPlaying(), EDGE = 48;
  let x = event.clientX, edgeFrame = null, edgeStart = 0, last = 0;
  const seek = () => {
    const box = scroller.getBoundingClientRect();
    const seconds = (Math.max(box.left, Math.min(box.right - 1, x)) - ruler.getBoundingClientRect().left) / pxPerSecond;
    seekTo(seconds);
  };
  const edge = () => { const box = scroller.getBoundingClientRect(); return x < box.left + EDGE ? -1 : x > box.right - EDGE ? 1 : 0; };
  const autoscroll = now => {
    const direction = edge();
    if (!direction || !scrubbing) { edgeFrame = null; return; }
    edgeStart ||= now;
    const elapsed = (now - edgeStart) / 1000, delta = last ? Math.min(.05, (now - last) / 1000) : 1 / 60; last = now;
    scroller.scrollLeft += direction * Math.min(3000, 80 * (1 + 2 * elapsed) ** 2) * delta;
    seek(); edgeFrame = requestAnimationFrame(autoscroll);
  };
  scrubbing = true; stopTimelineScroll();
  if (wasPlaying) pause();
  ruler.setPointerCapture(pointer); ruler.classList.add('scrubbing');
  seek();
  const move = e => {
    if (e.pointerId !== pointer) return;
    x = e.clientX; seek();
    if (edge() && edgeFrame === null) { edgeStart = 0; last = 0; edgeFrame = requestAnimationFrame(autoscroll); }
  };
  const done = async e => {
    if (e.pointerId !== pointer) return;
    if (edgeFrame !== null) cancelAnimationFrame(edgeFrame);
    edgeFrame = null;
    ruler.removeEventListener('pointermove', move); ruler.removeEventListener('pointerup', done); ruler.removeEventListener('pointercancel', done);
    ruler.classList.remove('scrubbing');
    scrubbing = false;
    if (wasPlaying) {
      try { await play(); } catch (error) { status(`Playback not started: ${error.message}`); }
    }
  };
  ruler.addEventListener('pointermove', move); ruler.addEventListener('pointerup', done); ruler.addEventListener('pointercancel', done);
});
let wheelZoom = 0;
$('timeline-scroll').addEventListener('wheel', event => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  wheelZoom += event.deltaY;
  if (Math.abs(wheelZoom) < 40) return;
  zoomBy(wheelZoom < 0 ? 1 : -1); wheelZoom = 0;
}, { passive: false });
$('zoom').oninput = rescale;
$('timeline-length').addEventListener('change', event => setTimelineLength(event.target.value));
$('timeline-length').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); event.target.blur(); }
  if (event.key === 'Escape') { event.preventDefault(); event.target.value = timelineLength === null ? '' : formatTime(timelineLength); event.target.blur(); }
});
$('timeline-length').addEventListener('blur', updateLengthField);
function setVideoHeight(height) {
  const app = document.querySelector('.app');
  if (height === null) { app.style.removeProperty('--video-height'); try { localStorage.removeItem('audiorec-video-height'); } catch {} return; }
  const available = $('video-panel').offsetHeight + $('tracks-panel').offsetHeight;
  height = Math.round(Math.max(140, Math.min(available - 180, height)));
  app.style.setProperty('--video-height', `${height}px`);
  try { localStorage.setItem('audiorec-video-height', height); } catch {}
}
$('splitter').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  const splitter = $('splitter'), pointer = event.pointerId, y = event.clientY, height = $('video-panel').offsetHeight;
  splitter.setPointerCapture(pointer); splitter.classList.add('dragging');
  const move = e => { if (e.pointerId === pointer) setVideoHeight(height + e.clientY - y); };
  const done = e => {
    if (e.pointerId !== pointer) return;
    splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', done); splitter.removeEventListener('pointercancel', done);
    splitter.classList.remove('dragging'); renderTracks();
  };
  splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', done); splitter.addEventListener('pointercancel', done);
});
$('splitter').addEventListener('dblclick', () => { setVideoHeight(null); renderTracks(); });
$('splitter').addEventListener('keydown', event => {
  const step = { ArrowUp: -20, ArrowDown: 20 }[event.key];
  if (!step) return;
  event.preventDefault(); event.stopPropagation(); setVideoHeight($('video-panel').offsetHeight + step);
});
try { const saved = +localStorage.getItem('audiorec-video-height'); if (saved) setVideoHeight(saved); } catch {}
window.addEventListener('resize', () => { const height = document.querySelector('.app').style.getPropertyValue('--video-height'); if (height) setVideoHeight(parseInt(height, 10)); rescale(); });
video.addEventListener('loadedmetadata', () => { rescale(); detectFps(); });
let ticksFrame = null;
$('track-headers').addEventListener('wheel', event => { if (event.ctrlKey || event.metaKey) return; event.preventDefault(); $('timeline-scroll').scrollTop += event.deltaY; }, { passive: false });
$('timeline-scroll').addEventListener('scroll', () => {
  $('track-headers').scrollTop = $('timeline-scroll').scrollTop; ticksFrame ??= requestAnimationFrame(() => { ticksFrame = null; renderTicks(); }); });
video.addEventListener('play', async () => { overPlaying = false; cursor = null; if (context) await context.resume(); syncPlayback(); if (playheadFrame === null) animatePlayhead(); });
video.addEventListener('pause', () => { if (video.ended && timelineEnd() > video.duration + .01) return; if (recording) finishRecording(); stopPlayback(); stopPlayhead(); });
video.addEventListener('seeking', () => { if (cursor !== null && video.currentTime < video.duration - .01) cursor = null; if (recording) finishRecording(); stopPlayback(); });
video.addEventListener('timeupdate', updatePlayhead);
video.addEventListener('seeked', () => { syncPlayback(); updatePlayhead(); });
video.addEventListener('ended', () => {
  if (timelineEnd() > video.duration + .01) { cursor = video.duration; startOvertime(); return; }
  if (recording) finishRecording(); stopPlayback(); stopPlayhead();
});
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
for (const id of ['video-file', 'add-track', 'import-audio', 'record', 'export', 'new-project', 'save-project', 'open-project', 'open-project-button']) $(id).disabled = true;
restoreProject(); listDevices(); keepMicOn();
