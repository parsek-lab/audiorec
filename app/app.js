I18N.translatePage();
const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
function setIconButton(button, name, text, tooltip) {
  button.replaceChildren();
  button.insertAdjacentHTML('afterbegin', icon(name));
  button.append(document.createTextNode(text));
  button.title = tooltip;
}
function updateRecordButton() {
  updateClipActions();
  setIconButton($('record'), recording ? 'stop' : 'record', recording ? tr('Stop recording') : tr('Record'), recording ? tr('Stop recording (*)') : tr('Record (*)'));
  $('record').classList.toggle('active', recording);
  document.body.classList.toggle('is-recording', recording);
}
function updateMicButton() {
  setIconButton($('test-mic'), stream ? 'stop' : 'record', stream ? tr('Stop test') : tr('Test microphone'), stream ? tr('Stop microphone test') : tr('Test microphone'));
  $('test-mic').setAttribute('aria-pressed', String(!!stream));
  $('input-meter').setAttribute('aria-pressed', String(!!stream));
  $('input-meter').title = stream ? (recording ? tr('Input level') : tr('Input level: click to stop listening')) : tr('Input level: click to listen to the microphone');
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
let context, stream, source, analyser, meterFrame, recorder = null, recording = false, nextId = 1, videoURL;
let playingSources = [], playbackRevision = 0, gluing = false;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600], FRAME_STEPS = [1, 2, 3, 5, 6, 10, 12, 15];
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
let fps = 25;
let pxPerSecond = 80;
let playheadFrame = null, scrubbing = false;
let viewReady = false, viewTimer = null; // timeline view persistence, see restoreView
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
  syncPlayback(); if (playheadFrame === null) animatePlayhead(); updatePlayButton();
}
function stopOvertime() {
  if (!overPlaying) return;
  cursor = openEnded() ? playPosition() : Math.min(playPosition(), timelineEnd()); overPlaying = false;
  if (recording) finishRecording();
  stopPlayback(); stopPlayhead(); updatePlayButton();
}
async function play() { if (cursor !== null || !videoLength()) startOvertime(); else await video.play(); }
function pause() { if (overPlaying) stopOvertime(); else video.pause(); }
async function togglePlay() {
  if (!isPlaying()) {
    const range = loopRange(); if (range && playPosition() >= range.end) seekTo(range.start);
    try { await play(); } catch (error) { status(tr('Playback not started: {message}', { message: error.message })); }
  } else pause();
}
function updatePlayButton() {
  const playing = isPlaying(), button = $('play');
  button.innerHTML = icon(playing ? 'pause' : 'play');
  button.setAttribute('aria-pressed', String(playing));
  button.setAttribute('aria-label', playing ? tr('Pause') : tr('Play')); button.title = playing ? tr('Pause (Space)') : tr('Play (Space)');
  startOutputMeters();
}
function seekTo(seconds) {
  const duration = video.duration, time = Math.max(0, Math.min(timelineEnd(), seconds));
  if (time < duration) { cursor = null; video.currentTime = time; }
  else { cursor = time; if (video.currentTime < duration - .01) video.currentTime = Math.max(0, duration - .001); }
  updatePlayhead();
}
function updatePlayhead(scroll = 'smooth') {
  saveView();
  updateClipActions();
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
// Loop: while the toggle is on (remembered in this browser), playback that reaches the export end restarts from the
// export start. Playback started before the start runs into the loop; recording never loops.
let looping = false;
try { looping = localStorage.getItem('audiorec-loop') === 'on'; } catch {}
const loopRange = () => { const start = exportIn, end = exportOutTime(); return looping && !recording && end - start > .05 ? { start, end } : null; };
async function restartLoop() {
  const range = loopRange(); if (!range) return;
  pause(); seekTo(range.start); try { await play(); } catch (error) { status(tr('Playback not started: {message}', { message: error.message })); }
}
function updateLoopButton() {
  const button = $('loop'); button.setAttribute('aria-pressed', String(looping)); $('timeline').classList.toggle('looping', looping);
  button.title = looping ? tr('Loop on: playback repeats between the export markers') : tr('Loop playback between the export markers');
}
function animatePlayhead() {
  const range = loopRange(); if (range && isPlaying() && playPosition() >= range.end) { playheadFrame = null; restartLoop(); return; }
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
// Read each clip's samples through one cached array: browsers with fingerprinting protection (Brave Shields) alter the
// buffer on every getChannelData call, so repeated calls from the meters made playback fade within seconds.
const channels = new WeakMap();
const channelData = (buffer, c = 0) => { let list = channels.get(buffer); if (!list) channels.set(buffer, list = []); return list[c] ??= buffer.getChannelData(c); };
const channel = buffer => channelData(buffer);
const clipChannels = buffer => Array.from({ length: buffer.numberOfChannels }, (_, c) => channelData(buffer, c));
// The project runs at 48 kHz and clips are mono or stereo: other rates are resampled and more channels are folded to
// stereo with Web Audio's speaker down-mix (5.1 keeps its centre and surrounds in the mix).
const PROJECT_RATE = 48000;
async function adaptAudio(buffer) {
  const count = Math.min(2, buffer.numberOfChannels);
  if (buffer.sampleRate === PROJECT_RATE && buffer.numberOfChannels === count) return buffer;
  const offline = new OfflineAudioContext(count, Math.max(1, Math.round(buffer.duration * PROJECT_RATE)), PROJECT_RATE), source = offline.createBufferSource();
  source.buffer = buffer; source.connect(offline.destination); source.start(); return offline.startRendering();
}
async function adaptClips(list) { for (const track of list) for (const clip of track.clips) clip.buffer = await adaptAudio(clip.buffer); }
// A clip's samples as stored in IndexedDB and in .audiorec files: one Float32Array per channel.
const bufferFrom = (audio, planes, rate) => { const buffer = audio.createBuffer(planes.length, planes[0].length, rate); planes.forEach((data, c) => buffer.copyToChannel(data, c)); return buffer; };
const clipDuration = clip => Math.max(0, clip.buffer.duration - (clip.trimStart || 0) - (clip.trimEnd || 0));
// Clip edges fade in and out over 1.5 ms with a raised cosine (sin²): no slope jump at either end, so it splatters less
// than the former 5 ms linear ramp (about -77 dB against -73 dB above 2 kHz for a cut at a peak) at under a third of the
// length. Shorter fades bring the click back. Playback, export and clip downloads all use fadeGain.
const FADE_SECONDS = .0015;
// Fades of a clip on its track. Where the next clip starts before this one ends and runs past it, the whole overlap is
// an equal-power crossfade (sin out, sin in: constant loudness for unrelated takes); other edges get the short guard.
// A clip lying entirely inside another keeps the guard fades and plays over it; muted clips do not count.
function clipFades(track, clip) {
  const duration = clipDuration(clip), end = clip.start + duration, guard = Math.min(FADE_SECONDS, duration / 2);
  const fades = { duration, in: Math.max(guard, clip.fadeIn || 0), out: Math.max(guard, clip.fadeOut || 0), inPower: false, outPower: false };
  for (const other of track.clips) {
    if (other === clip || other.muted) continue;
    const otherEnd = other.start + clipDuration(other);
    if (other.start < clip.start && otherEnd > clip.start && otherEnd < end && otherEnd - clip.start > fades.in) Object.assign(fades, { in: otherEnd - clip.start, inPower: true });
    if (other.start > clip.start && other.start < end && otherEnd > end && end - other.start > fades.out) Object.assign(fades, { out: end - other.start, outPower: true });
  }
  return fitFades(fades);
}
// Fade-in and fade-out longer than the clip together are shortened in proportion.
function fitFades(fades) { const total = fades.in + fades.out; if (total > fades.duration && total > 0) { fades.in *= fades.duration / total; fades.out *= fades.duration / total; } return fades; }
// Gain at a clip position: fade-in times fade-out. Guard edges use sin² (no slope jump), crossfades sin (equal power).
function fadeGain(position, fades) {
  const shape = (x, power) => { const s = Math.sin(Math.PI / 2 * Math.max(0, Math.min(1, x))); return power ? s : s * s; };
  return (fades.in > 0 ? shape(position / fades.in, fades.inPower) : 1) * (fades.out > 0 ? shape((fades.duration - position) / fades.out, fades.outPower) : 1);
}
// Fades for a clip that starts playing at clip position elapsed. Value curves must not overlap other events, so each
// curve starts where nothing else is scheduled, and fades that meet (short clips, long crossfades) become one curve.
function scheduleFades(param, startTime, elapsed, fades) {
  const duration = fades.duration, curve = (from, to) => { if (to <= from) return; const steps = Math.min(4096, Math.max(32, Math.ceil((to - from) / .002))); param.setValueCurveAtTime(Float32Array.from({ length: steps + 1 }, (_, i) => fadeGain(from + (to - from) * i / steps, fades)), startTime + from - elapsed, to - from); };
  // The first rendered frame can still read the param's intrinsic value (1) before a curve starting on it: set the
  // starting gain from time 0 so a clip never opens with one full-volume sample.
  const fadeOut = Math.max(elapsed, duration - fades.out); param.setValueAtTime(fadeGain(elapsed, fades), 0);
  if (elapsed >= fadeOut || fades.in >= fadeOut) { curve(elapsed, duration); return; }
  if (elapsed < fades.in) curve(elapsed, fades.in); else param.setValueAtTime(1, startTime);
  curve(fadeOut, duration);
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
  return { nextId, projectName, timelineLength, exportIn, exportOut, videoFile: selectedVideo, videoMuted: video.muted, videoVolume: videoGain,
    tracks: tracks.map(t => ({ id: t.id, name: t.name || tr('Track {n}', { n: t.id }), armed: t.armed, muted: t.muted, visible: t.visible !== false, volume: t.volume ?? 1, color: trackColor(t), effects: copyEffects(t),
      pan: t.pan ?? 0, clips: t.clips.map(c => ({ name: c.name || tr('Clip'), start: c.start, trimStart: c.trimStart || 0, trimEnd: c.trimEnd || 0, muted: !!c.muted, gain: c.gain ?? 1, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
        sampleRate: c.buffer.sampleRate, samples: new Float32Array(channel(c.buffer)), ...(c.buffer.numberOfChannels > 1 && { samplesRight: new Float32Array(channelData(c.buffer, 1)) }) })) })) };
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
  }).catch(error => { status(tr('Local save failed: {message}', { message: error.message })); });
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
          const buffer = bufferFrom(audio, c.samplesRight?.length === c.samples.length ? [c.samples, c.samplesRight] : [c.samples], c.sampleRate);
          return { name: c.name || tr('Clip'), start: c.start, trimStart: c.trimStart, trimEnd: c.trimEnd, muted: !!c.muted, gain: validVolume(c.gain) ? c.gain : 1, fadeIn: validFade(c.fadeIn) ? c.fadeIn : 0, fadeOut: validFade(c.fadeOut) ? c.fadeOut : 0, buffer };
        });
        tracks.push({ id: saved.id, name: saved.name || tr('Track {n}', { n: saved.id }), armed: saved.armed, muted: saved.muted, visible: saved.visible !== false, volume: validVolume(saved.volume) ? saved.volume : 1, pan: validPan(saved.pan) ? saved.pan : 0, color: validColor(saved.color) ? saved.color : undefined, effects: validEffects(saved.effects) ? copyEffects(saved) : validEQ(saved.eq) ? copyEffects({ eq: saved.eq }) : [], clips });
      }
      await adaptClips(tracks);
      nextId = data.nextId; timelineLength = validLength(data.timelineLength ?? null) ? data.timelineLength ?? null : null;
      restoreMarkers(data);
      showProjectName(typeof data.projectName === 'string' ? data.projectName : projectHandle?.name);
      selectedVideo = data.videoFile || null;
      if (selectedVideo) {
        videoURL = URL.createObjectURL(selectedVideo); video.src = videoURL;
        showVideoName(selectedVideo.name);
      }
      video.muted = !!data.videoMuted; setVideoGain(validVolume(data.videoVolume) ? data.videoVolume : 1);
      status(tr('Project restored from the browser.'));
    } else tracks.push({ id: nextId, name: tr('Track {n}', { n: nextId++ }), armed: true, muted: false, visible: true, clips: [] });
  } catch (error) {
    tracks.length = 0;
    tracks.push({ id: nextId, name: tr('Track {n}', { n: nextId++ }), armed: true, muted: false, visible: true, clips: [] });
    status(tr('Local storage unavailable: {message}', { message: error.message }));
  } finally {
    restoring = false; clearHistory(); renderTracks();
    for (const id of ['video-file', 'add-track', 'import-audio', 'clip-import', 'track-visibility', 'record', 'export', 'new-project', 'save-project', 'open-project', 'open-project-button']) $(id).disabled = false;
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
  input.placeholder = Number.isFinite(video.duration) ? formatTime(video.duration) : tr('Auto');
}
function setTimelineLength(text) {
  const value = text.trim() ? parseLength(text) : null;
  if (!validLength(value)) { status(tr('Invalid length: use mm:ss:ff, mm:ss or seconds.')); updateLengthField(); return; }
  if (value === timelineLength) { updateLengthField(); return; }
  remember(tr('change length')); timelineLength = value;
  renderTracks(); saveProject(); status(value === null ? tr('Timeline length follows the video.') : tr('Timeline length: {time}.', { time: formatTime(value) }));
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
  renderMarkers();
  const frame = pxPerSecond / fps, nominal = Math.round(fps);
  const frameStep = FRAME_STEPS.find(n => n < nominal && nominal % n === 0 && n * frame >= 120);
  const step = frameStep ? frameStep / fps : TICK_STEPS.find(s => s * pxPerSecond >= 120) ?? TICK_STEPS.at(-1);
  $('timeline').style.setProperty('--grid', `${frame >= 12 ? frame : step * pxPerSecond / 2}px`);
  renderTicks();
}
// Export markers: In and Out handles on the ruler delimit the export range. exportOut null = follows the timeline length.
let exportIn = 0, exportOut = null;
const markBand = document.createElement('div'), markIn = document.createElement('div'), markOut = document.createElement('div');
markBand.className = 'mark-band'; markIn.className = 'mark-handle mark-in'; markOut.className = 'mark-handle mark-out';
markIn.title = tr('Export start: drag to move, double-click to reset (I)'); markOut.title = tr('Export end: drag to move, double-click to reset (O)');
const defaultOut = () => projectLength() || clipsEnd();
const exportOutTime = () => exportOut ?? defaultOut();
const validMark = value => Number.isFinite(value) && value >= 0 && value <= 86400;
function restoreMarkers(data) {
  exportIn = validMark(data.exportIn) ? data.exportIn : 0;
  exportOut = validMark(data.exportOut) && data.exportOut > exportIn ? data.exportOut : null;
}
function renderMarkers() {
  const start = exportIn, end = exportOutTime(), shown = end > start;
  markIn.style.left = $('mark-in-line').style.left = markBand.style.left = `${start * pxPerSecond}px`;
  markOut.style.left = $('mark-out-line').style.left = `${end * pxPerSecond}px`;
  markBand.style.width = `${Math.max(0, end - start) * pxPerSecond}px`;
  markOut.hidden = $('mark-out-line').hidden = markBand.hidden = !shown;
  markIn.dataset.time = formatTime(start); markOut.dataset.time = formatTime(end);
}
function placeMarkers(start, end, label) {
  const out = Math.abs(end - defaultOut()) < 1e-6 ? null : end;
  if (start === exportIn && out === exportOut) return;
  remember(label); exportIn = start; exportOut = out;
  renderMarkers(); saveProject();
}
function markAtPlayhead(which) {
  const time = Math.round(playPosition() * fps) / fps;
  if (which === 'in') {
    const end = time < exportOutTime() ? exportOutTime() : defaultOut();
    if (time >= end) { status(tr('The export start must come before the end.')); return; }
    placeMarkers(time, end, tr('set export start'));
  } else {
    const start = time > exportIn ? exportIn : 0;
    if (time <= start) { status(tr('The export end must come after the start.')); return; }
    placeMarkers(start, time, tr('set export end'));
  }
  status(which === 'in' ? tr('Export start: {time}.', { time: formatTime(time) }) : tr('Export end: {time}.', { time: formatTime(time) }));
}
function dragMarker(event, which) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const handle = which === 'in' ? markIn : markOut, pointer = event.pointerId, before = snapshot(), frame = 1 / fps;
  const edges = tracks.flatMap(t => t.clips.flatMap(c => [c.start, c.start + clipDuration(c)]));
  handle.setPointerCapture(pointer); handle.classList.add('dragging');
  const move = e => {
    if (e.pointerId !== pointer) return;
    const raw = (e.clientX - $('ruler').getBoundingClientRect().left) / pxPerSecond;
    const snap = [0, playPosition(), defaultOut(), ...edges].find(t => Math.abs(t - raw) * pxPerSecond < 8);
    const time = Math.min(Math.max(timelineEnd(), clipsEnd()), Math.max(0, snap ?? Math.round(raw * fps) / fps));
    if (which === 'in') exportIn = Math.min(time, exportOutTime() - frame);
    else { const end = Math.max(time, exportIn + frame); exportOut = Math.abs(end - defaultOut()) < 1e-6 ? null : end; }
    renderMarkers();
  };
  const done = e => {
    if (e.pointerId !== pointer) return;
    handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', done); handle.removeEventListener('pointercancel', done);
    handle.classList.remove('dragging');
    if (before.markers[0] !== exportIn || before.markers[1] !== exportOut) { remember(which === 'in' ? tr('move export start') : tr('move export end'), before); saveProject(); }
  };
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', done); handle.addEventListener('pointercancel', done);
}
markIn.addEventListener('pointerdown', event => dragMarker(event, 'in'));
markOut.addEventListener('pointerdown', event => dragMarker(event, 'out'));
markIn.addEventListener('dblclick', () => placeMarkers(0, exportOutTime(), tr('reset export start')));
markOut.addEventListener('dblclick', () => placeMarkers(exportIn, Math.max(defaultOut(), exportIn + 1 / fps), tr('reset export end')));
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
  ruler.replaceChildren(markBand, ...ticks.map(([s, label]) => {
    const tick = document.createElement('span'); tick.className = 'tick'; tick.style.left = `${s * pxPerSecond}px`; tick.textContent = label; return tick;
  }), markIn, markOut);
}
const rescale = () => { renderTracks(); updatePlayhead('instant'); };
const zoomBy = steps => { $('zoom').value = +$('zoom').value + steps * 50; rescale(); };
const DRAG_DELAY = 200, DRAG_DISTANCE = 4;
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
  // A press only selects: the clip stays put until the button has been held for DRAG_DELAY and the pointer has moved a
  // few pixels, so a slightly shaky click does not nudge it.
  let offset = 0, moved = false;
  const pressed = performance.now(), y = event.clientY;
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
    if (!moved && (performance.now() - pressed < DRAG_DELAY || Math.hypot(e.clientX - x, e.clientY - y) < DRAG_DISTANCE)) return;
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
    const count = items.length, named = count === 1 ? clip.name || tr('Clip') : trn('{count} clip', '{count} clips', count);
    if (copying) {
      const copies = items.map(item => ({ ...item.clip, start: item.clip.start, index: item.index + offset, source: item }));
      for (const item of items) item.clip.start = item.start;
      if (e.type === 'pointerup' && (offset || copies.some(c => c.start !== c.source.start))) {
        remember(trn('duplicate clip', 'duplicate {count} clips', count), before);
        selectedClips.clear();
        for (const { index, source, ...copy } of copies) { tracks[index].clips.push(copy); selectedClips.add(copy); }
        renderTracks(); syncPlayback(); saveProject(); status(tr('{clips} duplicated.', { clips: named }));
      } else renderTracks();
    } else if (offset && e.type === 'pointerup') {
      const label = items.every(i => i.index === items[0].index) ? tracks[items[0].index + offset].name : offset > 0 ? trn('{count} track down', '{count} tracks down', offset) : trn('{count} track up', '{count} tracks up', -offset);
      remember(trn('move clip to {target}', 'move {count} clips to {target}', count, { target: label }), before);
      for (const item of items) { const from = tracks[item.index].clips; from.splice(from.indexOf(item.clip), 1); }
      for (const item of items) tracks[item.index + offset].clips.push(item.clip);
      renderTracks(); syncPlayback(); saveProject(); status(tr('{clips} moved to {target}.', { clips: named, target: label }));
    } else if (items.some(i => i.clip.start !== i.start) || (clip.trimStart || 0) !== original.trimStart || (clip.trimEnd || 0) !== original.trimEnd) {
      remember(mode === 'move' ? trn('move clip', 'move {count} clips', count) : tr('trim clip'), before);
      renderTracks(); syncPlayback(); saveProject();
    } else if (!moved && !event.shiftKey && wasSelected && selectedClips.size > 1) selectClip(clip, false);
  };
  element.addEventListener('pointermove', move); element.addEventListener('pointerup', done); element.addEventListener('pointercancel', done);
}

// Matched against the English source of a message (I18N.sourceOf), so it keeps working in every language.
const STATUS_ERROR = /^(Invalid length|Could not|Local save failed|Local storage unavailable|Microphone|Devices unavailable|Playback not started|Recording not started|Audio output:|Enable REC|Stop recording before|No unmuted|Recording too long)/;
let statusTimer = null;
const status = text => {
  const box = $('status');
  box.textContent = text; box.dataset.kind = STATUS_ERROR.test(I18N.sourceOf(text)) ? 'error' : 'info';
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
// The rename in progress; a clip rename ends (and saves) when that clip is deselected.
let activeEdit = null;
function editName(element, value, commit) {
  if (element.isContentEditable) return;
  try { element.contentEditable = 'plaintext-only'; } catch { element.contentEditable = 'true'; }
  element.spellcheck = false; element.classList.add('editing'); element.focus();
  getSelection().selectAllChildren(element);
  const off = new AbortController();
  const finish = save => {
    off.abort(); if (activeEdit?.element === element) activeEdit = null;
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
  return activeEdit = { element, finish };
}
const undoStack = [], redoStack = [], selectedClips = new Set(), clipElements = new Map();
const snapshot = () => ({ nextId, length: timelineLength, markers: [exportIn, exportOut], tracks: tracks.map(({ pending, ...t }) => ({ ...t, effects: copyEffects(t), clips: t.clips.map(c => ({ ...c })) })) });
function updateHistoryButtons() {
  $('undo').disabled = !undoStack.length; $('undo').title = undoStack.length ? tr('Undo {action} (Ctrl+Z)', { action: undoStack.at(-1).label }) : tr('Undo (Ctrl+Z)');
  $('redo').disabled = !redoStack.length; $('redo').title = redoStack.length ? tr('Redo {action} (Ctrl+Shift+Z)', { action: redoStack.at(-1).label }) : tr('Redo (Ctrl+Shift+Z)');
}
function remember(label, state = snapshot()) {
  undoStack.push({ label, state }); if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0; updateHistoryButtons();
}
function clearHistory() { undoStack.length = 0; redoStack.length = 0; selectedClips.clear(); updateHistoryButtons(); }
function travel(from, to, verb) {
  if (recording) { status(verb === 'Undo' ? tr('Stop recording before undoing.') : tr('Stop recording before redoing.')); return; }
  if (!from.length) return;
  if ($('utility-dialog').open) $('utility-dialog').close();
  if ($('compressor-dialog').open) $('compressor-dialog').close();
  if ($('eq-dialog').open) $('eq-dialog').close();
  if ($('fx-dialog').open) $('fx-dialog').close();
  const { label, state } = from.pop();
  to.push({ label, state: snapshot() });
  tracks.splice(0, tracks.length, ...state.tracks.map(t => ({ ...t, effects: copyEffects(t), clips: t.clips.map(c => ({ ...c })) }))); nextId = state.nextId; timelineLength = state.length ?? null;
  [exportIn, exportOut] = state.markers ?? [0, null];
  selectedClips.clear(); updateHistoryButtons();
  renderTracks(); syncPlayback(); saveProject(); status(verb === 'Undo' ? tr('Undo: {action}.', { action: label }) : tr('Redo: {action}.', { action: label }));
}
const undo = () => travel(undoStack, redoStack, 'Undo'), redo = () => travel(redoStack, undoStack, 'Redo');
function updateSelection() {
  for (const [clip, element] of clipElements) element.classList.toggle('selected', selectedClips.has(clip));
  for (const item of $('clip-items').children) item.classList.toggle('selected', selectedClips.has(item.clip));
  updateClipActions(); saveView();
  if (activeEdit?.clip && !selectedClips.has(activeEdit.clip)) activeEdit.finish(true);
}
const clipTitle = clip => tr('{name} · {start} s · {length} s · Select (click, Shift+click to add) · Rename (double-click)', { name: clip.name || tr('Clip'), start: clip.start.toFixed(2), length: clipDuration(clip).toFixed(2) });
// Updates only the clip's label, tooltip and the list, without rebuilding the timeline: a rename can end in the middle of
// a press on another clip (it ends when its clip is deselected), and rebuilding would drop that press.
function renameClip(clip, name) {
  remember(tr('rename clip')); clip.name = name;
  const block = clipElements.get(clip);
  if (block) { block.title = clipTitle(clip); const label = block.querySelector('.clip-label'); if (label) label.textContent = name; }
  renderClipList(); saveProject(); status(tr('Clip renamed: {name}.', { name }));
}
function renderClipList() {
  const clips = tracks.flatMap(track => track.clips.map(clip => ({ clip, track }))).sort((a, b) => a.clip.start - b.clip.start || tracks.indexOf(a.track) - tracks.indexOf(b.track));
  $('clip-count').textContent = clips.length; $('clip-empty').hidden = clips.length > 0; $('clip-zip').disabled = !clips.length;
  $('clip-items').replaceChildren(...clips.map(({ clip, track }) => {
    const item = document.createElement('li'); item.clip = clip;
    item.className = `clip-item${track.muted || clip.muted ? ' muted-clip' : ''}${selectedClips.has(clip) ? ' selected' : ''}`;
    item.style.setProperty('--track-color', trackColor(track));
    item.title = tr('{name}: go to its start and select it (Shift+click to add to the selection) · Rename (double-click)', { name: clip.name || tr('Clip') });
    const name = document.createElement('span'); name.className = 'clip-item-name'; name.textContent = clip.name || tr('Clip'); if (track.muted || clip.muted) name.dataset.state = tr('muted');
    const time = document.createElement('span'); time.className = 'clip-item-time'; time.textContent = formatTime(clip.start);
    const meta = document.createElement('span'); meta.className = 'clip-item-meta'; meta.textContent = `${track.name} · ${clipDuration(clip).toFixed(1)} s`;
    const download = document.createElement('button'); download.type = 'button'; download.className = 'clip-download ghost';
    download.innerHTML = icon('download'); download.title = tr('Download {name} as WAV', { name: clip.name || tr('Clip') });
    download.onclick = event => { event.stopPropagation(); downloadBlob(new Blob([clipWav(clip)], { type: 'audio/wav' }), `${safeFileName(clip.name || tr('Clip'))}.wav`); };
    download.ondblclick = event => event.stopPropagation();
    item.append(name, time, download, meta);
    item.onclick = event => { if (name.isContentEditable) return; selectClip(clip, event.shiftKey); if (!event.shiftKey && !recording) seekTo(clip.start); };
    item.ondblclick = () => { const edit = editName(name, clip.name || tr('Clip'), value => renameClip(clip, value)); if (edit) edit.clip = clip; };
    return item;
  }));
}
function selectClip(clip, toggle) {
  if (!toggle) selectedClips.clear();
  if (toggle && selectedClips.has(clip)) selectedClips.delete(clip); else selectedClips.add(clip);
  updateSelection();
  if (selectedClips.has(clip)) revealClipItem(clip);
}
// Scroll the clip list (only the list, never the page) so the clip's row is fully visible.
function revealClipItem(clip) {
  const list = $('clip-items'), item = [...list.children].find(row => row.clip === clip);
  if (!item || $('clip-list').classList.contains('collapsed')) return;
  const top = item.offsetTop - list.offsetTop, bottom = top + item.offsetHeight, margin = 6;
  if (top - margin < list.scrollTop) list.scrollTo({ top: top - margin, behavior: 'smooth' });
  else if (bottom + margin > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom + margin - list.clientHeight, behavior: 'smooth' });
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
  status(tr('Importing {files}…', { files: files.length === 1 ? files[0].name : trn('{count} file', '{count} files', files.length) }));
  for (const file of files) {
    try {
      const decoded = await audio.decodeAudioData(await file.arrayBuffer()), buffer = await adaptAudio(decoded);
      clips.push({ name: file.name.replace(/\.[^.]+$/, '') || tr('Clip'), start: Math.max(0, start), trimStart: 0, trimEnd: 0, buffer }); start += decoded.duration;
    } catch { failed.push(file.name); }
  }
  if (!tracks.includes(track) || recording) return;
  if (clips.length) {
    remember(trn('import clip', 'import {count} clips', clips.length));
    track.clips.push(...clips); selectedClips.clear(); clips.forEach(clip => selectedClips.add(clip));
    renderTracks(); syncPlayback(); saveProject();
  }
  const imported = clips.length ? tr('{clips} imported on {track}.', { clips: clips.length === 1 ? clips[0].name : trn('{count} clip', '{count} clips', clips.length), track: track.name }) : '';
  status(!failed.length ? imported : imported ? tr('Could not import {files}: unsupported audio. {imported}', { files: failed.join(', '), imported }) : tr('Could not import {files}: unsupported audio.', { files: failed.join(', ') }));
}
// Clip editing buttons: cut the selected clips under the playhead in two, delete the selected clips.
const CUT_MARGIN = .01;
const clipsToCut = () => {
  const time = playPosition();
  return tracks.flatMap(track => track.clips.filter(clip => selectedClips.has(clip) && time > clip.start + CUT_MARGIN && time < clip.start + clipDuration(clip) - CUT_MARGIN).map(clip => ({ clip, track })));
};
function updateClipActions() {
  $('cut-clip').disabled = recording || !clipsToCut().length; $('glue-clips').disabled = recording || gluing || !glueChains().length;
  $('delete-clips').disabled = recording || !selectedClips.size;
  const allMuted = selectedClips.size > 0 && [...selectedClips].every(clip => clip.muted), mute = $('mute-clips');
  mute.disabled = recording || !selectedClips.size;
  if (mute.getAttribute('aria-pressed') !== String(allMuted)) { mute.setAttribute('aria-pressed', String(allMuted)); mute.title = allMuted ? tr('Unmute the selected clips (M)') : tr('Mute the selected clips (M)'); }
}
// Mute or unmute the selected clips: mutes them all unless every one is already muted.
function toggleClipMute() {
  const clips = [...selectedClips];
  if (recording || !clips.length) return;
  const mute = !clips.every(clip => clip.muted), named = clips.length === 1 ? clips[0].name || tr('Clip') : trn('{count} clip', '{count} clips', clips.length);
  remember(mute ? trn('mute clip', 'mute {count} clips', clips.length) : trn('unmute clip', 'unmute {count} clips', clips.length));
  for (const clip of clips) clip.muted = mute;
  renderTracks(); syncPlayback(); saveProject(); status(mute ? tr('{clips} muted.', { clips: named }) : tr('{clips} unmuted.', { clips: named }));
}
$('mute-clips').onclick = toggleClipMute;
// Each half gets its own buffer with only its samples, so the project does not store the audio twice.
function cutClips() {
  const cuts = clipsToCut();
  if (recording || !cuts.length) return;
  remember(trn('cut clip', 'cut {count} clips', cuts.length));
  const time = playPosition(), audio = getContext(), pieces = [];
  const slice = (planes, rate, from, to) => bufferFrom(audio, planes.map(data => data.subarray(from, to)), rate);
  for (const { clip, track } of cuts) {
    const planes = clipChannels(clip.buffer), data = planes[0], rate = clip.buffer.sampleRate, at = Math.round(((clip.trimStart || 0) + time - clip.start) * rate);
    const left = { ...clip, buffer: slice(planes, rate, 0, at), trimEnd: 0, fadeOut: 0 };
    const right = { ...clip, name: nextNameLike(clip.name || tr('Clip')), start: clip.start + at / rate - (clip.trimStart || 0), buffer: slice(planes, rate, at, data.length), trimStart: 0, fadeIn: 0 };
    track.clips.splice(track.clips.indexOf(clip), 1, left, right);
    selectedClips.delete(clip); pieces.push(left, right);
  }
  for (const piece of pieces) selectedClips.add(piece);
  renderTracks(); syncPlayback(); saveProject();
  status(trn('Clip cut at {time}.', '{count} clips cut at {time}.', cuts.length, { time: formatTime(time) }));
}
$('loop').onclick = () => { looping = !looping; try { localStorage.setItem('audiorec-loop', looping ? 'on' : 'off'); } catch {} updateLoopButton(); status(looping ? tr('Loop on.') : tr('Loop off.')); };
updateLoopButton();
$('cut-clip').onclick = cutClips; $('glue-clips').onclick = glueClips;
// Glue: selected, unmuted clips of one track that overlap or touch form a chain; each chain of two or more becomes one
// clip. It is rendered offline exactly as it plays (clip gains, the crossfades between its members, inner fades), so it
// sounds the same; the first clip's fade-in, the last one's fade-out and the track settings stay live.
function glueChains() {
  const chains = [];
  for (const track of tracks) {
    const picked = track.clips.filter(clip => selectedClips.has(clip) && !clip.muted).sort((a, b) => a.start - b.start);
    let chain = [];
    for (const clip of picked) {
      const end = Math.max(...chain.map(c => c.start + clipDuration(c)));
      if (chain.length && clip.start > end + 1e-6) { if (chain.length > 1) chains.push({ track, clips: chain }); chain = []; }
      chain.push(clip);
    }
    if (chain.length > 1) chains.push({ track, clips: chain });
  }
  return chains;
}
async function glueClips() {
  const chains = glueChains();
  if (recording || gluing || !chains.length) return;
  gluing = true; updateClipActions(); status(tr('Gluing…'));
  try {
    const glued = [];
    for (const { track, clips } of chains) {
      const start = Math.min(...clips.map(c => c.start)), end = Math.max(...clips.map(c => c.start + clipDuration(c))), rate = Math.max(...clips.map(c => c.buffer.sampleRate));
      const first = clips.find(c => c.start === start), last = clips.findLast(c => c.start + clipDuration(c) === end);
      const offline = new OfflineAudioContext(Math.max(...clips.map(c => c.buffer.numberOfChannels)), Math.max(1, Math.round((end - start) * rate)), rate);
      for (const clip of clips) {
        const fades = clipFades({ clips }, clip), node = offline.createBufferSource(), gain = offline.createGain();
        if (clip === first) fades.in = 0; if (clip === last) fades.out = 0;
        node.buffer = clip.buffer; node.connect(gain); gain.connect(offline.destination);
        scheduleFades(gain.gain, clip.start - start, 0, fades);
        const level = clip.gain ?? 1; if (level !== 1) { const scale = offline.createGain(); scale.gain.value = level; gain.disconnect(); gain.connect(scale); scale.connect(offline.destination); }
        node.start(clip.start - start, clip.trimStart || 0, clipDuration(clip));
      }
      const buffer = await offline.startRendering();
      glued.push({ track, clips, clip: { name: first.name || tr('Clip'), start, trimStart: 0, trimEnd: 0, gain: 1, fadeIn: first.fadeIn || 0, fadeOut: last.fadeOut || 0, buffer } });
    }
    if (recording) return;
    const count = glued.reduce((sum, g) => sum + g.clips.length, 0);
    remember(trn('glue clip', 'glue {count} clips', count));
    for (const { track, clips, clip } of glued) {
      const index = Math.min(...clips.map(c => track.clips.indexOf(c)).filter(i => i >= 0));
      track.clips = track.clips.filter(c => !clips.includes(c)); track.clips.splice(index, 0, clip);
      for (const c of clips) selectedClips.delete(c); selectedClips.add(clip);
    }
    renderTracks(); syncPlayback(); saveProject(); status(trn('{count} clip glued.', '{count} clips glued.', count));
  } finally { gluing = false; updateClipActions(); }
}
$('delete-clips').onclick = () => deleteSelectedClips();
function deleteSelectedClips() {
  const count = tracks.reduce((sum, t) => sum + t.clips.filter(c => selectedClips.has(c)).length, 0);
  if (recording || !count) return;
  remember(trn('remove clip', 'remove {count} clips', count));
  for (const track of tracks) track.clips = track.clips.filter(c => !selectedClips.has(c));
  selectedClips.clear();
  renderTracks(); syncPlayback(); saveProject(); status(trn('{count} clip removed.', '{count} clips removed.', count));
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
  const name = await askName(tr('New track'), tr('Track {n}', { n: nextId }), tr('Add track'));
  if (name === null || recording) return;
  remember(tr('add track'));
  const track = { id: nextId++, name, armed: true, muted: false, visible: true, clips: [] };
  tracks.push(track); armTrack(track);
  renderTracks(); saveProject(); status(tr('Track added: {name}.', { name }));
}
// Waveform colors are theme tokens (--wave, --wave-video, --wave-rec in style.css), read when a canvas is drawn.
const themeColor = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function drawWaveform(clip) {
  const width = Math.ceil(clip.buffer.duration * pxPerSecond), height = 44;
  if (width < 1) return null;
  const canvas = document.createElement('canvas'), ratio = window.devicePixelRatio || 1;
  canvas.className = 'clip-wave'; canvas.width = Math.min(16000, Math.ceil(width * ratio)); canvas.height = Math.ceil(height * ratio);
  canvas.style.width = `${width}px`; canvas.style.left = `${-(clip.trimStart || 0) * pxPerSecond}px`;
  const g = canvas.getContext('2d'), planes = clipChannels(clip.buffer), step = planes[0].length / canvas.width, middle = canvas.height / 2;
  g.fillStyle = themeColor('--wave');
  for (let x = 0; x < canvas.width; x++) {
    let peak = 0;
    for (const data of planes) for (let i = Math.floor(x * step), end = Math.min(data.length, Math.floor((x + 1) * step)); i < end; i++) peak = Math.max(peak, Math.abs(data[i]));
    const bar = Math.max(ratio / 2, Math.min(1, peak * 1.6) * middle * .85);
    g.fillRect(x, middle - bar, 1, bar * 2);
  }
  return canvas;
}
// Read-only row with the video's own audio: peaks decoded once per file, drawn in segments around the visible area.
let videoAudio = null, videoWave = { scale: 0, segments: new Map() };
const PEAK_RATE = 200, VIDEO_SEGMENT = 2048, VIDEO_AUDIO_NOTES = { loading: () => tr('Reading the video audio…'), none: () => tr('No readable audio in this video'), large: () => tr('Video too large to draw its audio') };
async function readVideoAudio(file) {
  if (videoAudio?.file === file && file) return;
  const entry = videoAudio = file ? { file, state: 'loading' } : null;
  videoWave.scale = 0; renderVideoAudio();
  if (!entry) return;
  try {
    if (file.size > 1.5e9) entry.state = 'large';
    else {
      const decoded = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await file.arrayBuffer());
      const peaks = new Float32Array(Math.ceil(decoded.duration * PEAK_RATE)), per = decoded.sampleRate / PEAK_RATE;
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        const data = decoded.getChannelData(c);
        for (let i = 0; i < peaks.length; i++) {
          let peak = peaks[i];
          for (let j = Math.floor(i * per), end = Math.min(data.length, Math.floor((i + 1) * per)); j < end; j++) { const v = Math.abs(data[j]); if (v > peak) peak = v; }
          peaks[i] = peak;
        }
      }
      Object.assign(entry, { state: peaks.some(p => p > 0) ? 'ready' : 'none', peaks });
    }
  } catch { entry.state = 'none'; }
  if (videoAudio === entry) { videoWave.scale = 0; renderVideoAudio(); }
}
function renderVideoAudio() {
  $('video-audio-head').hidden = $('video-audio-row').hidden = !videoAudio;
  if (!videoAudio) return;
  $('video-audio-lane').style.width = $('timeline').style.width;
  $('video-audio-note').textContent = VIDEO_AUDIO_NOTES[videoAudio.state]?.() || '';
  drawVideoWave();
}
function drawVideoWave() {
  const lane = $('video-audio-lane');
  if (videoWave.scale !== pxPerSecond || videoAudio?.state !== 'ready') { for (const canvas of videoWave.segments.values()) canvas.remove(); videoWave = { scale: pxPerSecond, segments: new Map() }; }
  if (videoAudio?.state !== 'ready') return;
  const { peaks } = videoAudio, scroller = $('timeline-scroll'), total = peaks.length / PEAK_RATE * pxPerSecond;
  const first = Math.max(0, Math.floor((scroller.scrollLeft - scroller.clientWidth) / VIDEO_SEGMENT));
  const last = Math.min(Math.ceil(total / VIDEO_SEGMENT) - 1, Math.floor((scroller.scrollLeft + 2 * scroller.clientWidth) / VIDEO_SEGMENT));
  for (const [index, canvas] of videoWave.segments) if (index < first - 2 || index > last + 2) { canvas.remove(); videoWave.segments.delete(index); }
  const ratio = window.devicePixelRatio || 1, height = lane.clientHeight || 60;
  const fill = themeColor('--wave-video');
  for (let index = first; index <= last; index++) {
    if (videoWave.segments.has(index)) continue;
    const left = index * VIDEO_SEGMENT, width = Math.min(VIDEO_SEGMENT, total - left);
    const canvas = document.createElement('canvas'); canvas.className = 'clip-wave video-wave';
    canvas.width = Math.ceil(width * ratio); canvas.height = Math.ceil(height * ratio);
    canvas.style.left = `${left}px`; canvas.style.width = `${width}px`;
    const g = canvas.getContext('2d'), middle = canvas.height / 2, perPixel = PEAK_RATE / pxPerSecond / ratio;
    g.fillStyle = fill;
    for (let x = 0; x < canvas.width; x++) {
      const from = (left * ratio + x) * perPixel, to = Math.max(Math.floor(from) + 1, Math.floor(from + perPixel));
      let peak = 0;
      for (let i = Math.floor(from); i < to && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
      const bar = Math.max(ratio / 2, Math.min(1, peak * 1.4) * middle * .85);
      g.fillRect(x, middle - bar, 1, bar * 2);
    }
    videoWave.segments.set(index, canvas); lane.append(canvas);
  }
}
// Output meters read the samples under the playhead (clips per track, decoded peaks for the video), so no extra audio nodes are needed.
const outputMeters = new Map(), meterLevels = new WeakMap();
let outputMeterFrame = null;
function showOutputLevel(element, peak) {
  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const level = Math.max(Math.max(0, Math.min(100, (db + 60) / 60 * 100)), (meterLevels.get(element) || 0) * .88);
  meterLevels.set(element, level < .5 ? 0 : level);
  element.style[element.id === 'master-meter' ? 'width' : 'height'] = `${level < .5 ? 0 : level}%`;
  if (peak >= .99) element.parentElement.dataset.clipUntil = performance.now() + 1000;
  element.parentElement.classList.toggle('clipping', performance.now() < (+element.parentElement.dataset.clipUntil || 0));
}
const hidden = isHidden;
const trackPeak = (track, time) => {
  if (track.muted || isHidden(track)) return 0;
  let peak = 0;
  for (const clip of track.clips) {
    const offset = time - clip.start;
    if (clip.muted || offset < 0 || offset >= clipDuration(clip)) continue;
    const rate = clip.buffer.sampleRate, from = Math.floor((offset + (clip.trimStart || 0)) * rate);
    for (const data of clipChannels(clip.buffer)) for (let i = from, end = Math.min(data.length, from + Math.round(rate * .05)); i < end; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
  }
  return peak * (track.volume ?? 1);
}
function videoPeak(time) {
  const peaks = videoAudio?.peaks;
  if (!peaks || video.muted || time >= videoLength()) return 0;
  let peak = 0;
  for (let i = Math.floor(time * PEAK_RATE), end = Math.min(peaks.length, i + PEAK_RATE / 20); i < end; i++) if (peaks[i] > peak) peak = peaks[i];
  return peak * videoGain;
}
function masterPeak(time) {
  let peak = 0;
  const clips = tracks.filter(t => !t.muted && !isHidden(t)).flatMap(t => t.clips.map(clip => ({ clip, gain: t.volume ?? 1 }))).filter(({ clip }) => !clip.muted && time >= clip.start && time < clip.start + clipDuration(clip));
  for (let k = 0; k < 400; k++) {
    const at = time + k * .05 / 400;
    let left = 0, right = 0;
    for (const { clip, gain } of clips) {
      const planes = clipChannels(clip.buffer), i = Math.floor((at - clip.start + (clip.trimStart || 0)) * clip.buffer.sampleRate);
      if (i < planes[0].length) { left += planes[0][i] * gain; right += planes.at(-1)[i] * gain; }
    }
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  return peak + videoPeak(time);
}
function updateOutputMeters() {
  const playing = isPlaying() && !recording, time = playPosition();
  const meters = [...outputMeters].map(([track, element]) => [element, playing ? trackPeak(track, time) : 0]);
  meters.push([$('video-audio-meter'), playing && !$('video-audio-head').hidden ? videoPeak(time) : 0], [$('master-meter'), playing ? masterPeak(time) : 0]);
  for (const [element, peak] of meters) showOutputLevel(element, peak);
  outputMeterFrame = playing || meters.some(([element]) => meterLevels.get(element) > 0) ? requestAnimationFrame(updateOutputMeters) : null;
}
const startOutputMeters = () => { outputMeterFrame ??= requestAnimationFrame(updateOutputMeters); };
function renderTracks() {
  const armed = tracks.filter(t => t.armed && !isHidden(t));
  if (tracks.length && armed.length !== 1) armTrack(armed[0] ?? tracks.find(t => !isHidden(t)) ?? tracks[0]);
  renderTimeline();
  $('tracks').replaceChildren(); $('track-heads').replaceChildren(); clipElements.clear(); outputMeters.clear();
  const present = new Set(tracks.flatMap(t => t.clips));
  for (const clip of selectedClips) if (!present.has(clip)) selectedClips.delete(clip);
  const laneWidth = Math.ceil(parseInt($('timeline').style.width, 10));
  for (const track of tracks) {
    if (isHidden(track)) continue;
    const row = document.createElement('div'); row.className = 'lane-row'; row.style.setProperty('--track-color', trackColor(track));
    const title = document.createElement('span'); title.className = 'track-name'; title.textContent = track.name;
    title.title = tr('Rename track (double-click)');
    title.ondblclick = () => editName(title, track.name, name => { remember(tr('rename track')); track.name = name; renderTracks(); saveProject(); status(tr('Track renamed: {name}.', { name })); });
    const rec = document.createElement('button'); rec.type = 'button'; setIconButton(rec, 'record', '', track.armed ? tr('{track} records', { track: track.name }) : tr('Record on {track}', { track: track.name })); rec.setAttribute('aria-pressed', String(track.armed)); rec.disabled = recording;
    rec.setAttribute('aria-label', tr('Record on track {n}', { n: track.id }));
    rec.onclick = () => { if (track.armed) return; remember(tr('move REC')); armTrack(track); renderTracks(); saveProject(); };
    const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'muted'; setIconButton(mute, track.muted ? 'mute' : 'volume', '', tr('Toggle mute on {track}', { track: track.name })); mute.setAttribute('aria-pressed', String(track.muted));
    mute.setAttribute('aria-label', tr('Mute track {n}', { n: track.id }));
    mute.onclick = () => { remember(track.muted ? tr('unmute track') : tr('mute track')); track.muted = !track.muted; renderTracks(); syncPlayback(); saveProject(); };
    const menu = document.createElement('div'); menu.className = 'menu'; menu.id = `track-menu-${track.id}`; menu.popover = 'auto';
    const more = document.createElement('button'); more.type = 'button'; more.className = 'icon-button ghost track-more'; more.innerHTML = icon('more');
    more.title = tr('More actions for {track}', { track: track.name }); more.setAttribute('aria-label', tr('More actions for track {n}', { n: track.id })); more.popoverTargetElement = menu;
    menu.addEventListener('toggle', event => { more.classList.toggle('open', event.newState === 'open'); if (event.newState === 'open') anchorPopover(menu, more); });
    const remove = document.createElement('button'); remove.type = 'button'; setIconButton(remove, 'trash', tr('Remove track'), tr('Remove {track}', { track: track.name }));
    remove.className = 'menu-item danger-item'; remove.disabled = recording;
    remove.onclick = async () => {
      menu.hidePopover();
      if (track.clips.length && !await ask(tr('Remove {track}?', { track: track.name }), tr('The track and all its recordings will be deleted.'), tr('Remove track'))) return;
      const index = tracks.indexOf(track);
      if (index < 0) return;
      remember(tr('remove track'));
      tracks.splice(index, 1);
      renderTracks(); syncPlayback(); saveProject(); status(tr('{track} removed.', { track: track.name }));
    };
    const swatches = document.createElement('div'); swatches.className = 'swatches'; swatches.setAttribute('role', 'group'); swatches.setAttribute('aria-label', tr('Track color'));
    // Group related shades in the palette without changing default track colors.
    for (const [label, color] of [8, 0, 13, 7, 1, 2, 9, 3, 10, 4, 11, 5, 14, 12, 6, 15].map(index => TRACK_COLORS[index])) {
      const swatch = document.createElement('button'); swatch.type = 'button'; swatch.className = 'swatch'; swatch.style.setProperty('--swatch', color);
      swatch.title = label; swatch.setAttribute('aria-label', label); swatch.setAttribute('aria-pressed', String(trackColor(track) === color));
      swatch.onclick = () => { menu.hidePopover(); if (trackColor(track) === color) return; remember(tr('change color')); track.color = color; renderTracks(); saveProject(); };
      swatches.append(swatch);
    }
    const colorLabel = document.createElement('span'); colorLabel.className = 'menu-label'; colorLabel.textContent = tr('Color');
    const separator = document.createElement('div'); separator.className = 'menu-separator'; separator.setAttribute('role', 'separator');
    menu.append(colorLabel, swatches, separator, remove);
    const fx = document.createElement('button'); fx.type = 'button'; fx.className = 'ghost track-fx'; fx.dataset.track = track.id;
    fx.title = tr('Effects: {track}', { track: track.name }); fx.setAttribute('aria-label', fx.title); fx.setAttribute('aria-haspopup', 'dialog'); fx.setAttribute('aria-controls', 'fx-dialog'); fx.setAttribute('aria-expanded', 'false');
    fx.onclick = () => {
      openTrackEQ(track);
      fx.setAttribute('aria-expanded', 'true'); $('fx-dialog').showModal();
      $('fx-dialog').addEventListener('close', () => fx.setAttribute('aria-expanded', 'false'), { once: true });
    };
    const top = document.createElement('div'); top.className = 'track-head-top'; top.append(title, fx, more, menu); updateFxButton(track, fx);
    const volume = document.createElement('button'); volume.type = 'button'; volume.className = 'volume-handle'; volume.setAttribute('aria-haspopup', 'true');
    showVolumeHandle(volume, track.volume ?? 1, tr('Volume of {track}', { track: track.name }));
    const pan = document.createElement('button'); pan.type = 'button'; pan.className = 'pan-handle'; pan.setAttribute('aria-haspopup', 'true'); showPanHandle(pan, track);
    let adjusting = false, panning = false;
    const target = {
      title: track.name, get: () => track.volume ?? 1,
      set: gain => { if (!adjusting) { remember(tr('change volume')); adjusting = true; } track.volume = gain; applyVolume(track); showVolumeHandle(volume, gain, tr('Volume of {track}', { track: track.name })); },
      commit: () => { adjusting = false; saveProject(); },
      getPan: () => track.pan ?? 0,
      setPan: value => { if (!panning) { remember(tr('change pan')); panning = true; } track.pan = value; applyPan(track); showPanHandle(pan, track); },
      commitPan: () => { panning = false; saveProject(); },
    };
    volume.onclick = () => openVolume(volume, target); pan.onclick = () => openVolume(volume, target, 'pan');
    const bottom = document.createElement('div'); bottom.className = 'track-head-bottom'; bottom.append(rec, mute);
    const meter = document.createElement('span'); meter.className = 'out-meter'; meter.title = tr('Output level');
    const meterFill = document.createElement('span'); meterFill.className = 'out-meter-fill'; meter.append(meterFill); outputMeters.set(track, meterFill);
    const levels = document.createElement('div'); levels.className = 'track-levels'; levels.append(volume, pan);
    const mix = document.createElement('div'); mix.className = 'track-mix'; mix.append(levels, meter);
    const head = document.createElement('div'); head.className = 'track-head'; head.style.setProperty('--track-color', trackColor(track)); head.append(top, bottom, mix); $('track-heads').append(head);
    const lane = document.createElement('div'); lane.className = 'clip-lane'; lane.style.width = `${laneWidth}px`;
    lane.addEventListener('pointerdown', e => { if (e.target === lane && e.button === 0) selectArea(e, lane); });
    for (const clip of track.clips) {
      const block = document.createElement('div'); block.className = `clip${track.muted || clip.muted ? ' muted-clip' : ''}${selectedClips.has(clip) ? ' selected' : ''}`;
      clipElements.set(clip, block);
      block.style.left = `${clip.start * pxPerSecond}px`;
      block.style.width = `${Math.max(8, clipDuration(clip) * pxPerSecond)}px`;
      block.title = clipTitle(clip);
      const wave = drawWaveform(clip);
      if (wave) block.append(wave);
      const label = document.createElement('span'); label.className = 'clip-label'; label.textContent = clip.name || tr('Clip'); block.append(label);
      if ((clip.gain ?? 1) !== 1) { const badge = document.createElement('span'); badge.className = 'clip-gain'; badge.textContent = `${formatDb(clip.gain)} dB`; label.append(badge); }
      // Fades longer than the click guard (set in the clip dialog or made by an overlap) are drawn as shaded corners.
      const fades = clipFades(track, clip);
      for (const side of ['in', 'out']) if (fades[side] > FADE_SECONDS * 1.01 && fades[side] * pxPerSecond >= 3) { const shade = document.createElement('span'); shade.className = `clip-fade ${side}`; shade.style.width = `${fades[side] * pxPerSecond}px`; block.append(shade); }
      if (track.muted || clip.muted) label.dataset.state = tr('muted');
      for (const side of ['left', 'right']) {
        const handle = document.createElement('span'); handle.className = `clip-handle ${side}`;
        handle.setAttribute('aria-label', side === 'left' ? tr('Edit clip start') : tr('Edit clip end'));
        handle.title = side === 'left' ? tr('Edit clip start (drag)') : tr('Edit clip end (drag)');
        handle.addEventListener('pointerdown', e => editClip(e, clip, side, block)); block.append(handle);
      }
      block.addEventListener('pointerdown', e => { if (e.target === block) editClip(e, clip, 'move', block); });
      block.addEventListener('dblclick', e => { if (e.target !== block) return; e.stopPropagation(); openClipDialog(clip); });
      lane.append(block);
    }
    if (track.pending) {
      const block = document.createElement('div'); block.className = 'clip recording-clip'; block.style.left = `${track.pending.start * pxPerSecond}px`;
      const label = document.createElement('span'); label.className = 'clip-label'; label.textContent = tr('Recording…'); block.append(label);
      lane.append(block); recordingPreview = { track, element: block, segments: [], peaks: [], chunk: 0, offset: 0, sample: 0, drawn: 0, scale: pxPerSecond };
    }
    row.append(lane); $('tracks').append(row);
  }
  renderVideoAudio(); renderClipList();
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
  const ratio = window.devicePixelRatio || 1, height = 44, middle = height * ratio / 2, fill = themeColor('--wave-rec');
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
    g.fillStyle = fill; g.clearRect((x % PREVIEW_SEGMENT) * ratio, 0, ratio, height * ratio); g.fillRect((x % PREVIEW_SEGMENT) * ratio, middle - bar, ratio, bar * 2);
  }
  preview.drawn = peaks.length;
}
function getContext() { return context ??= new AudioContext({ sampleRate: PROJECT_RATE }); }
function stopPlayback() { playbackRevision++; for (const { node, gain, level, eqChain } of playingSources) { try { node.stop(); } catch {} node.disconnect(); gain.disconnect(); level.disconnect(); disposeEffectChain(eqChain); } playingSources = []; }
// Volume faders run from -inf to +10 dB on a quadratic curve (0 dB sits at about 62% of the travel); gains are stored linear.
const MAX_DB = 10, MIN_DB = -60, MAX_GAIN = 10 ** (MAX_DB / 20);
const validVolume = value => Number.isFinite(value) && value >= 0 && value <= MAX_GAIN + 1e-9;
const validPan = value => Number.isFinite(value) && value >= -1 && value <= 1;
const validFade = value => Number.isFinite(value) && value >= 0 && value <= 3600;
function sliderToGain(position) {
  if (position <= 0) return 0;
  const db = MAX_DB - (MAX_DB - MIN_DB) * (1 - position / 1000) ** 2;
  return Math.abs(db) < .06 ? 1 : 10 ** (db / 20);
}
const gainToSlider = gain => gain <= 0 ? 0 : Math.round(1000 * (1 - Math.sqrt(Math.max(0, Math.min(1, (MAX_DB - 20 * Math.log10(gain)) / (MAX_DB - MIN_DB))))));
function showVolumeHandle(button, gain, label) {
  const db = formatDb(gain);
  button.textContent = db; button.title = tr('{label}: {db} dB (click to change)', { label, db }); button.setAttribute('aria-label', tr('{label}: {db} dB', { label, db }));
}
// One shared popover slider edits whichever volume handle was clicked.
let volumeTarget = null;
// Tracks add pan to the same popover; focus lands on the typed value, ready to overwrite.
function openVolume(button, target, focus = 'volume') {
  const popover = $('volume-popover');
  if (volumeTarget?.button === button && popover.matches(':popover-open') && volumeTarget.focus === focus) { popover.hidePopover(); return; }
  volumeTarget = { ...target, button, focus };
  $('volume-title').textContent = target.title; $('pan-control').hidden = !target.getPan;
  $('volume-slider').value = gainToSlider(target.get()); showVolumeLevel(); if (target.getPan) showPanLevel();
  if (!popover.matches(':popover-open')) popover.showPopover();
  anchorPopover(popover, button); const field = $(focus === 'pan' ? 'pan-value' : 'volume-level'); field.focus(); field.select();
}
function showVolumeLevel() {
  const db = formatDb(volumeTarget?.get() ?? 1);
  if (document.activeElement !== $('volume-level')) $('volume-level').value = db;
  $('volume-slider').setAttribute('aria-valuetext', `${db} dB`);
}
function showPanLevel() {
  const value = volumeTarget.getPan(), text = formatPan(value);
  $('pan-slider').value = Math.round(value * 100); $('pan-slider').setAttribute('aria-valuetext', text);
  if (document.activeElement !== $('pan-value')) $('pan-value').value = text;
}
// Typed levels: dB with an optional sign, comma or point, "-inf" / "-∞" for silence; pan as L/R (or the
// interface's letters) plus 0-100, a signed number, or C for the centre. Invalid text restores the current value.
function parseDb(text) {
  const value = text.trim().replace(',', '.').replace(/\s*db$/i, '');
  if (/^-?(inf|∞)/i.test(value)) return 0;
  const db = Number(value); return value && Number.isFinite(db) ? Math.min(MAX_GAIN, 10 ** (db / 20)) : null;
}
function parsePan(text) {
  const value = text.trim().toUpperCase(), left = [tr('L{n}', { n: '' }), 'L'].map(s => s.toUpperCase()), right = [tr('R{n}', { n: '' }), 'R'].map(s => s.toUpperCase());
  if (!value || value === tr('C').toUpperCase() || value === 'C') return 0;
  const side = left.find(s => s && value.startsWith(s)) ? -1 : right.find(s => s && value.startsWith(s)) ? 1 : 0, number = Number(value.replace(/^[^\d+\-.]+/, '').replace(',', '.') || 0);
  return Number.isFinite(number) ? Math.max(-1, Math.min(1, (side ? side * Math.abs(number) : number) / 100)) : null;
}
const formatPan = value => { const n = Math.round(Math.abs(value) * 100); return !n ? tr('C') : value < 0 ? tr('L{n}', { n }) : tr('R{n}', { n }); };
function showPanHandle(button, track) {
  const text = formatPan(track.pan ?? 0);
  button.textContent = text; button.title = tr('Pan of {track}: {pan} (click to change)', { track: track.name, pan: text }); button.setAttribute('aria-label', tr('Pan of {track}: {pan}', { track: track.name, pan: text }));
}
$('volume-slider').oninput = event => { volumeTarget?.set(sliderToGain(+event.target.value)); showVolumeLevel(); };
$('volume-slider').onchange = () => volumeTarget?.commit();
$('volume-slider').ondblclick = event => { event.target.value = gainToSlider(1); event.target.oninput(event); volumeTarget?.commit(); };
$('volume-level').onchange = () => { const gain = parseDb($('volume-level').value); if (gain !== null && volumeTarget) { volumeTarget.set(gain); volumeTarget.commit(); $('volume-slider').value = gainToSlider(gain); } $('volume-level').blur(); showVolumeLevel(); };
$('pan-slider').oninput = event => { volumeTarget?.setPan(+event.target.value / 100); showPanLevel(); };
$('pan-slider').onchange = () => volumeTarget?.commitPan();
$('pan-slider').ondblclick = event => { event.target.value = 0; event.target.oninput(event); volumeTarget?.commitPan(); };
$('pan-value').onchange = () => { const pan = parsePan($('pan-value').value); if (pan !== null && volumeTarget?.setPan) { volumeTarget.setPan(pan); volumeTarget.commitPan(); } $('pan-value').blur(); showPanLevel(); };
for (const id of ['volume-level', 'pan-value']) $(id).addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $(id).dispatchEvent(new Event('change')); } });
// Clip settings: name, gain (the track fader and typed dB) and fade in / out in ms. One undo step per opening.
let clipEdit = null;
function openClipDialog(clip) {
  const fadeMax = Math.max(1, Math.round(clipDuration(clip) * 1000)); clipEdit = { clip, changed: false };
  $('clip-name').value = clip.name || tr('Clip'); $('clip-gain-slider').value = gainToSlider(clip.gain ?? 1); $('clip-gain-value').value = formatDb(clip.gain ?? 1);
  for (const side of ['in', 'out']) { const value = Math.round(((side === 'in' ? clip.fadeIn : clip.fadeOut) || 0) * 1000); $(`clip-fade-${side}-slider`).max = fadeMax; $(`clip-fade-${side}-slider`).value = value; $(`clip-fade-${side}`).max = fadeMax; $(`clip-fade-${side}`).value = value; }
  $('clip-dialog').showModal(); $('clip-name').select();
}
function editClipSetting(action, rebuild = false) {
  if (!clipEdit) return;
  if (!clipEdit.changed) { remember(tr('edit clip')); clipEdit.changed = true; }
  action(clipEdit.clip); renderTracks(); if (rebuild) syncPlayback();
}
function setClipGain(gain) {
  editClipSetting(clip => { clip.gain = gain; for (const source of playingSources) if (source.clip === clip) source.level.gain.setTargetAtTime((source.track.volume ?? 1) * gain, context.currentTime, .02); });
  $('clip-gain-slider').value = gainToSlider(gain); if (document.activeElement !== $('clip-gain-value')) $('clip-gain-value').value = formatDb(gain);
}
$('clip-name').onchange = () => { const name = $('clip-name').value.trim(); if (name && name !== clipEdit?.clip.name) { editClipSetting(clip => { clip.name = name; }); renderClipList(); } };
$('clip-name').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('clip-dialog').close(); } });
$('clip-gain-slider').oninput = event => setClipGain(sliderToGain(+event.target.value));
$('clip-gain-slider').ondblclick = () => setClipGain(1);
$('clip-gain-value').onchange = () => { const gain = parseDb($('clip-gain-value').value); if (gain !== null) setClipGain(gain); $('clip-gain-value').value = formatDb(clipEdit?.clip.gain ?? 1); };
for (const side of ['in', 'out']) {
  const key = side === 'in' ? 'fadeIn' : 'fadeOut', slider = $(`clip-fade-${side}-slider`), field = $(`clip-fade-${side}`);
  const apply = (ms, rebuild) => { const value = Math.max(0, Math.min(+slider.max, Math.round(ms) || 0)); slider.value = field.value = value; editClipSetting(clip => { clip[key] = value / 1000; }, rebuild); };
  slider.oninput = () => apply(+slider.value, false); slider.onchange = () => apply(+slider.value, true); field.onchange = () => apply(+field.value, true);
}
$('clip-dialog').addEventListener('close', () => { if ($('clip-name').value.trim() && document.activeElement === $('clip-name')) $('clip-name').dispatchEvent(new Event('change')); if (clipEdit?.changed) { syncPlayback(); saveProject(); status(tr('Clip updated: {name}.', { name: clipEdit.clip.name || tr('Clip') })); } clipEdit = null; });
$('volume-popover').addEventListener('toggle', event => { volumeTarget?.button.classList.toggle('open', event.newState === 'open'); });
function formatDb(gain) {
  if (gain <= 0) return '-∞';
  const db = 20 * Math.log10(gain);
  return Math.abs(db) < .05 ? '0.0' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}
const TRACK_COLORS = [[tr('Violet'), '#8b7bff'], [tr('Blue'), '#4f8cff'], [tr('Cyan'), '#3cc8e6'], [tr('Green'), '#3ee0a1'], [tr('Yellow'), '#ffc857'], [tr('Orange'), '#ff9454'], [tr('Red'), '#ff5f7e'], [tr('Pink'), '#e879f9'], [tr('Indigo'), '#6366f1'], [tr('Teal'), '#14b8a6'], [tr('Lime'), '#a3e635'], [tr('Gold'), '#eab308'], [tr('Coral'), '#fb7185'], [tr('Lavender'), '#c4b5fd'], [tr('Brown'), '#b88762'], [tr('Slate'), '#94a3b8']];
const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const trackColor = track => validColor(track.color) ? track.color : TRACK_COLORS[(track.id - 1) % 8][1];
// Per-track visibility: hiding takes the track out of the timeline and the mix, and it stays out of both exports;
// unlike Mute it is a presentation choice and does not touch the track volume or its stored audio.
function isHidden(track) { return track.visible === false; }
function setTrackVisible(track, visible) {
  if (visible === !isHidden(track)) return;
  remember(visible ? tr('show track') : tr('hide track'));
  track.visible = visible;
  renderTracks(); syncPlayback(); saveProject();
  status(visible ? tr('{track} shown.', { track: track.name }) : tr('{track} hidden.', { track: track.name }));
}
function renderVisibilityList() {
  const switchFor = track => {
    const row = document.createElement('label'); row.className = 'visibility-row'; row.style.setProperty('--track-color', trackColor(track));
    const dot = document.createElement('span'); dot.className = 'visibility-dot'; dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'visibility-name'; name.textContent = track.name;
    const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'visibility-switch'; input.checked = !isHidden(track);
    input.setAttribute('aria-label', tr('Visible: {track}', { track: track.name }));
    // Toggles in place: only the row's own class changes, so the dialog keeps its scroll position and focus.
    input.onchange = () => { row.classList.toggle('hidden-track', !input.checked); setTrackVisible(track, input.checked); };
    row.append(dot, name, input); row.classList.toggle('hidden-track', isHidden(track));
    return row;
  };
  $('visibility-list').replaceChildren(...tracks.map(switchFor));
}
function openVisibility() { renderVisibilityList(); $('visibility-dialog').showModal(); }
function applyVolume(track) { for (const source of playingSources) if (source.track === track) source.level.gain.setTargetAtTime((track.volume ?? 1) * (source.clip.gain ?? 1), context.currentTime, .02); }
function applyPan(track) { for (const chain of new Set(playingSources.filter(s => s.track === track).map(s => s.eqChain))) chain?.pan?.set(track.pan ?? 0, true); }
// Track pan, after the effects: the signal is made stereo (mono copied to both sides) and each side scaled by a
// constant-power law normalised to unity at the centre, so pan 0 leaves the mix (and mono exports) exactly as before.
const panGains = pan => [Math.SQRT2 * Math.cos((pan + 1) * Math.PI / 4), Math.SQRT2 * Math.sin((pan + 1) * Math.PI / 4)];
function connectPan(audio, track, destination) {
  const input = new GainNode(audio, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' }), split = audio.createChannelSplitter(2), merge = audio.createChannelMerger(2), left = audio.createGain(), right = audio.createGain();
  input.connect(split); split.connect(left, 0); split.connect(right, 1); left.connect(merge, 0, 0); right.connect(merge, 0, 1); merge.connect(destination);
  const set = (pan, smooth) => panGains(pan).forEach((value, i) => { const param = (i ? right : left).gain; if (smooth) param.setTargetAtTime(value, audio.currentTime, .02); else param.value = value; });
  set(track.pan ?? 0); return { input, nodes: [input, split, left, right, merge], set };
}
async function syncPlayback() {
  stopPlayback();
  if (!isPlaying() || recording || !context) return;
  const revision = playbackRevision;
  try { await prepareTrackEffects(context, tracks); } catch (error) { if (revision === playbackRevision) { status(`Effects unavailable: ${error.message}`); pause(); } return; }
  if (revision !== playbackRevision || !isPlaying() || recording) return;
  const now = playPosition();
  for (const track of tracks) {
    if (track.muted || isHidden(track)) continue;
    // Tracks with latency (pitch shifter) are fed ahead of the playhead so their output lands on time.
    let eqChain = null; const at = now + trackLatency(track, context.sampleRate);
    for (const clip of track.clips) {
      const elapsed = Math.max(0, at - clip.start);
      const duration = clipDuration(clip);
      if (clip.muted || duration <= 0 || elapsed >= duration) continue;
      const offset = (clip.trimStart || 0) + elapsed;
      const startTime = context.currentTime + Math.max(0, clip.start - at);
      const node = context.createBufferSource(), gain = context.createGain(), level = context.createGain();
      level.gain.value = (track.volume ?? 1) * (clip.gain ?? 1);
      if (!eqChain) {
        const input = context.createGain(), pan = connectPan(context, track, context.destination); eqChain = connectTrackEQ(context, track, input, pan.input, true);
        eqChain.input = input; eqChain.pan = pan; eqChain.nodes.unshift(input); eqChain.nodes.push(...pan.nodes);
      }
      node.buffer = clip.buffer; node.connect(gain); gain.connect(level); level.connect(eqChain.input);
      scheduleFades(gain.gain, startTime, elapsed, clipFades(track, clip));
      node.start(startTime, offset, duration - elapsed);
      playingSources.push({ node, gain, level, track, clip, eqChain });
    }
  }
}
async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [kind, selectId] of [['audioinput', 'input-device'], ['audiooutput', 'output-device']]) {
      const select = $(selectId), previous = select.value;
      select.replaceChildren(new Option(tr('Default'), ''));
      devices.filter(d => d.kind === kind).forEach((d, i) => select.add(new Option(d.label || (kind === 'audioinput' ? tr('Microphone {n}', { n: i + 1 }) : tr('Output {n}', { n: i + 1 })), d.deviceId)));
      if ([...select.options].some(o => o.value === previous)) select.value = previous;
    }
  } catch (error) { status(tr('Devices unavailable: {message}', { message: error.message })); }
}
async function setOutput() {
  const id = $('output-device').value || 'default';
  try {
    if (!video.setSinkId || !getContext().setSinkId) throw new Error(tr('output selection not supported by this browser'));
    await video.setSinkId(id); await context.setSinkId(id);
    status(tr('Audio output updated.'));
  } catch (error) { status(tr('Audio output: {message}', { message: error.message })); }
}
let monitoring = false, monitorNode = null;
try { monitoring = localStorage.getItem('audiorec-monitor') === 'on'; } catch {}
function updateMonitor() {
  if (monitoring && source && !monitorNode) { monitorNode = context.createGain(); source.connect(monitorNode); monitorNode.connect(context.destination); }
  if ((!monitoring || !source) && monitorNode) { try { source?.disconnect(monitorNode); } catch {} monitorNode.disconnect(); monitorNode = null; }
  $('monitor').setAttribute('aria-pressed', String(monitoring));
  $('monitor').title = monitoring ? tr('Stop hearing the microphone') : tr('Monitor: hear the microphone, use headphones to avoid feedback');
}
// Enhanced audio = the browser's echo cancellation, noise suppression and auto gain. Off by default (raw microphone);
// always off while monitoring, where it made the monitored voice duck and drop out.
let enhancedAudio = false;
try { enhancedAudio = localStorage.getItem('audiorec-enhanced') === 'on'; } catch {}
const micProcessing = () => { const on = enhancedAudio && !monitoring; return { echoCancellation: on, noiseSuppression: on, autoGainControl: on }; };
async function applyMicProcessing() {
  if (stream && recording) { for (const track of stream.getAudioTracks()) track.applyConstraints(micProcessing()).catch(() => {}); }
  else if (stream) { stopMonitoring(); try { await startMonitoring(); } catch (error) { stopMonitoring(); status(tr('Microphone unavailable: {message}', { message: error.message })); } }
}
function updateEnhancedButton() {
  const button = $('enhanced-audio');
  button.setAttribute('aria-pressed', String(enhancedAudio));
  button.title = enhancedAudio ? tr('Turn off enhanced audio: record the raw microphone') : tr('Turn on enhanced audio: echo cancellation, noise suppression and automatic gain');
  $('enhanced-state').textContent = !enhancedAudio ? tr('Off: raw microphone') : monitoring ? tr('On, paused while Monitor is on') : tr('On');
}
async function toggleEnhancedAudio() {
  enhancedAudio = !enhancedAudio;
  try { localStorage.setItem('audiorec-enhanced', enhancedAudio ? 'on' : 'off'); } catch {}
  updateEnhancedButton(); await applyMicProcessing();
  status(enhancedAudio ? tr('Enhanced audio on.') : tr('Enhanced audio off: recording the raw microphone.'));
}
async function toggleMonitor() {
  monitoring = !monitoring;
  try { localStorage.setItem('audiorec-monitor', monitoring ? 'on' : 'off'); } catch {}
  updateEnhancedButton(); await applyMicProcessing();
  if (monitoring && !stream && !recording) {
    if (!navigator.mediaDevices?.getUserMedia) { status(tr('Microphone only available on localhost or HTTPS.')); }
    else try { await startMonitoring(); } catch (error) { stopMonitoring(); status(tr('Microphone unavailable: {message}', { message: error.message })); }
  }
  updateMonitor();
  status(monitoring ? tr('Monitor on: you hear the microphone.') : tr('Monitor off.'));
}
function stopMonitoring() {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  monitorNode?.disconnect(); monitorNode = null;
  source?.disconnect();
  stream?.getTracks().forEach(t => t.stop());
  stream = null; source = null; analyser = null;
  $('mic-level').value = 0; meterLevel = 0; clipUntil = 0; showInputLevel(0);
  $('mic-state').textContent = tr('Inactive');
  updateMicButton();
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
    $('mic-state').textContent = tr('Listening');
    updateMicButton();
    await listDevices();
  } catch (error) { mic.getTracks().forEach(t => t.stop()); throw error; }
}
// Name for a piece cut from a clip: the source name with the next free progressive number ("Intro" -> "Intro 2",
// "Voce 3" -> the next free "Voce N").
function nextNameLike(name) {
  const base = name.replace(/\s+\d+$/, '') || name;
  const used = tracks.flatMap(t => t.clips).map(({ name: other = '' }) => other === base ? 1 : other.startsWith(`${base} `) && /^\d+$/.test(other.slice(base.length + 1)) ? Number(other.slice(base.length + 1)) : 0);
  return `${base} ${Math.max(1, ...used) + 1}`;
}
function nextClipName(track) {
  const prefix = `${track.name} `;
  const used = tracks.flatMap(t => t.clips).map(({ name = '' }) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)) ? Number(name.slice(prefix.length)) : 0);
  return `${track.name} ${Math.max(0, ...used) + 1}`;
}
// Recording capture. Chromium reads the microphone track itself (MediaStreamTrackProcessor) in a worker: on the device's
// own clock, before Web Audio, whose input FIFO dropped pieces when microphone and output are separate devices, and off the
// main thread, which made the old ScriptProcessor lose whole 4096-sample blocks. Frames lost upstream show up as a
// timestamp jump of whole frames and are filled with silence, so the take keeps its length and stays in sync. Other
// browsers tap the Web Audio graph with an AudioWorklet. Both hand mono Float32Array chunks to deliverRecording().
const CAPTURE_WORKER_SOURCE = `
let reader=null,previousEnd=null;
onmessage=event=>{if(event.data==='stop'){reader?.cancel().catch(()=>{});return;}reader=event.data.readable.getReader();pump();};
async function pump(){for(;;){let result;try{result=await reader.read();}catch{return;}if(result.done)return;const frame=result.value;try{handle(frame);}finally{frame.close();}}}
function plane(frame,index){
  const format=frame.format,planar=format.endsWith('-planar'),kind=format.slice(0,3),Type=kind==='f32'?Float32Array:kind==='s32'?Int32Array:kind==='s16'?Int16Array:Uint8Array;
  const scale=kind==='f32'?1:kind==='s32'?2147483648:kind==='s16'?32768:128,bias=kind==='u8'||format.startsWith('u8')?128:0,n=frame.numberOfFrames,stride=planar?1:frame.numberOfChannels,offset=planar?0:index;
  const data=new Type(frame.allocationSize({planeIndex:planar?index:0})/Type.BYTES_PER_ELEMENT);frame.copyTo(data,{planeIndex:planar?index:0});
  const out=new Float32Array(n);for(let i=0;i<n;i++)out[i]=(data[i*stride+offset]-bias)/scale;return out;
}
function handle(frame){
  const rate=frame.sampleRate,n=frame.numberOfFrames,channels=frame.numberOfChannels,chunks=[];let gap=0;
  // Timestamp jitter stays well under half a frame; only whole missing frames count as a gap.
  if(previousEnd!==null){const frames=Math.round((frame.timestamp-previousEnd)/1e6*rate/n);if(frames>0){gap=frames*n;chunks.push(new Float32Array(gap));}}
  previousEnd=frame.timestamp+n/rate*1e6;
  const mono=new Float32Array(n);for(let c=0;c<channels;c++){const data=plane(frame,c);for(let i=0;i<n;i++)mono[i]+=data[i]/channels;}
  chunks.push(mono);postMessage({rate,gap,chunks},chunks.map(chunk=>chunk.buffer));
}
`;
const RECORDER_PROCESSOR_SOURCE = `
class AudiorecRecorder extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(1024);this.used=0;this.running=true;this.port.onmessage=e=>{if(e.data==='stop'){this.flush();this.running=false;}};}
  flush(){if(!this.used)return;const chunk=this.buffer.slice(0,this.used);this.used=0;this.port.postMessage({rate:sampleRate,gap:0,chunks:[chunk]},[chunk.buffer]);}
  process(inputs){
    if(!this.running)return false;
    const input=inputs[0],n=input[0]?.length??128;
    for(let i=0;i<n;i++){let v=0;for(const channel of input)v+=channel[i];this.buffer[this.used++]=input.length?v/input.length:0;if(this.used===this.buffer.length)this.flush();}
    return true;
  }
}
registerProcessor('audiorec-recorder-v1',AudiorecRecorder);
`;
const recorderModules = new WeakMap();
function deliverRecording(capture, { rate, gap, chunks }) {
  if (!recording || recorder !== capture) return;
  if (gap) { capture.gaps++; capture.gapSamples += gap; capture.rate = rate; }
  for (const track of tracks) if (track.pending) { const pending = track.pending; pending.sampleRate ??= rate; for (const chunk of chunks) { pending.chunks.push(chunk); pending.length = (pending.length || 0) + chunk.length; } }
}
async function startRecorder(audio) {
  const capture = { kind: '', gaps: 0, gapSamples: 0, rate: 0, stop() {} }, [micTrack] = stream.getAudioTracks();
  if (typeof MediaStreamTrackProcessor === 'function' && typeof Worker === 'function') {
    try {
      const reader = new MediaStreamTrackProcessor({ track: micTrack, maxBufferSize: 200 });
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKER_SOURCE], { type: 'text/javascript' })), worker = new Worker(url); URL.revokeObjectURL(url);
      worker.onmessage = event => deliverRecording(capture, event.data);
      worker.postMessage({ readable: reader.readable }, [reader.readable]);
      return Object.assign(capture, { kind: 'track', stop() { worker.onmessage = null; worker.postMessage('stop'); worker.terminate(); } });
    } catch {}
  }
  if (!recorderModules.has(audio)) {
    const url = URL.createObjectURL(new Blob([RECORDER_PROCESSOR_SOURCE], { type: 'text/javascript' }));
    recorderModules.set(audio, audio.audioWorklet.addModule(url).catch(error => { recorderModules.delete(audio); throw error; }).finally(() => URL.revokeObjectURL(url)));
  }
  await recorderModules.get(audio);
  const node = new AudioWorkletNode(audio, 'audiorec-recorder-v1', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'max' }), silent = audio.createGain(), input = source;
  silent.gain.value = 0; node.port.onmessage = event => deliverRecording(capture, event.data);
  input.connect(node); node.connect(silent); silent.connect(audio.destination);
  return Object.assign(capture, { kind: 'worklet', stop() { node.port.postMessage('stop'); node.port.onmessage = null; try { input.disconnect(node); } catch {} node.disconnect(); silent.disconnect(); } });
}
function finishRecording() {
  if (!recording) return;
  recording = false;
  const capture = recorder; recorder = null; capture?.stop();
  stopMonitoring();
  if (tracks.some(t => t.pending?.chunks.length)) remember(tr('recording'));
  for (const track of tracks) {
    if (!track.pending) continue;
    const { chunks, start, sampleRate } = track.pending;
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (length) {
      const buffer = context.createBuffer(1, length, sampleRate);
      const data = channel(buffer); let position = 0;
      for (const chunk of chunks) { data.set(chunk, position); position += chunk.length; }
      const clip = { name: nextClipName(track), start, buffer }; track.clips.push(clip);
      if (buffer.sampleRate !== PROJECT_RATE) adaptAudio(buffer).then(adapted => { clip.buffer = adapted; renderTracks(); saveProject(); });
    }
    delete track.pending;
  }
  updateRecordButton();
  $('input-device').disabled = false; $('test-mic').disabled = false; renderTracks(); status(tr('Recording complete. Saving locally…'));
  const gaps = capture?.gaps || 0, saved = gaps ? trn('Recording saved. The microphone input had {count} gap ({ms} ms), filled with silence to keep the timing.', 'Recording saved. The microphone input had {count} gaps ({ms} ms in total), filled with silence to keep the timing.', gaps, { ms: Math.round(capture.gapSamples / capture.rate * 1000) }) : tr('Recording saved in the browser. Press Play to listen back.');
  saveProject().then(() => { if ($('status').textContent === tr('Recording complete. Saving locally…')) status(saved); });
  if (monitoring) startMonitoring().catch(() => {});
}
const MIC_SETTLE_MS = 400;
async function toggleRecording() {
  if (recording) { finishRecording(); return; }
  if (!tracks.some(t => t.armed)) { status(tr('Enable REC on at least one track.')); return; }
  if (!navigator.mediaDevices?.getUserMedia) { status(tr('Microphone only available on localhost or HTTPS.')); return; }
  $('record').disabled = true;
  try {
    const audio = getContext(); await audio.resume();
    // A microphone opened just now ramps up over its first ~150 ms (measured on a steady tone): let it settle first.
    if (!stream) { await startMonitoring(); status(tr('Preparing the microphone…')); await new Promise(resolve => setTimeout(resolve, MIC_SETTLE_MS)); }
    stopPlayback();
    if (!isPlaying()) await play();
    const capture = await startRecorder(audio), start = playPosition();
    // The clip takes the capture's sample rate (set by the first chunk); playback resamples if it differs.
    for (const track of tracks) if (track.armed) track.pending = { start, sampleRate: null, chunks: [] };
    recorder = capture; recording = true; updateRecordButton(); stopPlayback();
    $('input-device').disabled = true; $('test-mic').disabled = true; renderTracks(); requestAnimationFrame(updateRecordingPreview); status(tr('Recording…'));
  } catch (error) {
    recorder?.stop(); recorder = null; stopMonitoring();
    for (const track of tracks) delete track.pending;
    status(tr('Recording not started: {message}', { message: error.message }));
  } finally { $('record').disabled = false; }
}
let projectHandle = null;
const PROJECT_TYPES = [{ description: tr('Audiorec project'), accept: { 'application/octet-stream': ['.audiorec'] } }];
let projectName = null;
function showProjectName(name) {
  projectName = name || null;
  $('project-name').textContent = name ? name.replace(/\.audiorec$/i, '') : tr('Untitled project');
  $('project-name').title = name || tr('Not saved to a file yet');
}
function rememberProjectFile(handle) {
  projectHandle = handle; showProjectName(handle?.name);
  database().then(db => { db.transaction('project', 'readwrite').objectStore('project').put(handle, 'fileHandle'); }).catch(() => {});
}
function projectBlob() {
    const data = projectData();
    const manifest = {
      version: 13, nextId: data.nextId, length: data.timelineLength, exportIn: data.exportIn, exportOut: data.exportOut, videoMuted: data.videoMuted, videoVolume: data.videoVolume,
      video: data.videoFile ? { name: data.videoFile.name, type: data.videoFile.type, size: data.videoFile.size } : null,
      tracks: data.tracks.map(track => ({ id: track.id, name: track.name, armed: track.armed, muted: track.muted, visible: !!track.visible, volume: track.volume, pan: track.pan, color: track.color, effects: track.effects,
        clips: track.clips.map(clip => ({ name: clip.name, start: clip.start, trimStart: clip.trimStart, trimEnd: clip.trimEnd, muted: clip.muted, gain: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut,
          sampleRate: clip.sampleRate, sampleCount: clip.samples.length, channels: clip.samplesRight ? 2 : 1 })) }))
    };
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const header = new ArrayBuffer(12), view = new DataView(header);
    for (let i = 0; i < 8; i++) view.setUint8(i, 'AUDIOREC'.charCodeAt(i));
    view.setUint32(8, json.length, true);
    const parts = [header, json];
    if (data.videoFile) parts.push(data.videoFile);
    for (const track of data.tracks) for (const clip of track.clips) parts.push(clip.samples, ...(clip.samplesRight ? [clip.samplesRight] : []));
    return new Blob(parts, { type: 'application/octet-stream' });
}
async function saveProjectFile() {
  try {
    const blob = projectBlob();
    const suggested = `${(projectName || 'project').replace(/\.audiorec$/i, '')}.audiorec`;
    // Without the File System Access API, download straight away: the browser's own Save As window (when enabled) names
    // the file. An in-app name prompt confirmed with Enter left the Windows pointer hidden over that window.
    if (!window.showSaveFilePicker) {
      const fileName = suggested.replace(/[\/:*?"<>|]/g, '-');
      downloadBlob(blob, fileName);
      showProjectName(fileName); saveProject();
      status(tr('Project downloaded as {file} (this browser cannot overwrite files).', { file: fileName }));
      return;
    }
    let handle = projectHandle;
    if (handle && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') handle = null;
    handle ??= await window.showSaveFilePicker({ suggestedName: suggested, types: PROJECT_TYPES });
    const writable = await handle.createWritable();
    await writable.write(blob); await writable.close();
    rememberProjectFile(handle); saveProject();
    status(tr('Project saved to {file}.', { file: handle.name }));
  } catch (error) {
    if (error.name !== 'AbortError') status(tr('Could not save project: {message}', { message: error.message }));
  }
}
async function openProject(file, handle = null) {
  if (recording) { status(tr('Stop recording before opening a project.')); return; }
  try {
    const bytes = await file.arrayBuffer(), view = new DataView(bytes);
    if (bytes.byteLength < 12 || new TextDecoder().decode(new Uint8Array(bytes, 0, 8)) !== 'AUDIOREC') throw new Error(tr('unrecognized format'));
    const jsonLength = view.getUint32(8, true);
    if (jsonLength > bytes.byteLength - 12) throw new Error(tr('incomplete file'));
    const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 12, jsonLength)));
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].includes(manifest.version) || !Array.isArray(manifest.tracks)) throw new Error(tr('unsupported version'));
    if (manifest.version >= 4 && !validLength(manifest.length)) throw new Error(tr('invalid length'));
    let position = 12 + jsonLength;
    const videoSize = manifest.video?.size || 0;
    if (!Number.isSafeInteger(videoSize) || videoSize < 0 || videoSize > bytes.byteLength - position) throw new Error(tr('invalid video'));
    const importedVideo = manifest.video ? new File([bytes.slice(position, position + videoSize)], manifest.video.name, { type: manifest.video.type }) : null;
    position += videoSize;
    const audio = getContext();
    const importedTracks = manifest.tracks.map(track => {
      if (!Array.isArray(track.clips) || !Number.isSafeInteger(track.id)) throw new Error(tr('invalid track'));
      if ((manifest.version >= 2 && !validVolume(track.volume)) || (manifest.version >= 3 && !validColor(track.color)) || (manifest.version >= 5 && typeof track.visible !== 'boolean')) throw new Error(tr('invalid track'));
      if ((manifest.version === 6 && !validEQ(track.eq)) || (manifest.version >= 7 && !validEffects(track.effects)) || (manifest.version >= 12 && !validPan(track.pan))) throw new Error(tr('invalid track'));
      return { effects: manifest.version >= 7 ? copyEffects(track) : manifest.version === 6 ? copyEffects({ eq: track.eq }) : [], id: track.id, name: track.name || tr('Track {n}', { n: track.id }), armed: !!track.armed, muted: !!track.muted, visible: manifest.version >= 5 ? track.visible : true, volume: manifest.version >= 2 ? track.volume : 1, pan: manifest.version >= 12 ? track.pan : 0, color: manifest.version >= 3 ? track.color : undefined,
        clips: track.clips.map(clip => {
          const { sampleCount, sampleRate } = clip, count = manifest.version >= 13 ? clip.channels : 1;
          if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || !Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 192000 || (count !== 1 && count !== 2) || sampleCount * 4 * count > bytes.byteLength - position) throw new Error(tr('invalid audio'));
          const planes = Array.from({ length: count }, () => { const samples = new Float32Array(sampleCount); for (let i = 0; i < sampleCount; i++) samples[i] = view.getFloat32(position + i * 4, true); position += sampleCount * 4; return samples; });
          const buffer = bufferFrom(audio, planes, sampleRate);
          if (!Number.isFinite(clip.start) || clip.start < 0 || !Number.isFinite(clip.trimStart) || clip.trimStart < 0 || !Number.isFinite(clip.trimEnd) || clip.trimEnd < 0 || clip.trimStart + clip.trimEnd >= buffer.duration) throw new Error(tr('invalid clip'));
          if (manifest.version >= 12 && (!validVolume(clip.gain) || !validFade(clip.fadeIn) || !validFade(clip.fadeOut))) throw new Error(tr('invalid clip'));
          const settings = manifest.version >= 12 ? { gain: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut } : { gain: 1, fadeIn: 0, fadeOut: 0 };
          return { name: clip.name || tr('Clip'), start: clip.start, trimStart: clip.trimStart, trimEnd: clip.trimEnd, muted: !!clip.muted, ...settings, buffer };
        }) };
    });
    if (position !== bytes.byteLength || !Number.isSafeInteger(manifest.nextId) || manifest.nextId <= Math.max(0, ...importedTracks.map(t => t.id))) throw new Error(tr('invalid project file'));
    if (!await ask(tr('Open project?'), tr('The current project will be replaced.'), tr('Open project'), false)) return;
    stopOvertime(); cursor = null; video.pause(); stopPlayback(); stopMonitoring();
    if (videoURL) URL.revokeObjectURL(videoURL);
    selectedVideo = importedVideo;
    videoURL = importedVideo ? URL.createObjectURL(importedVideo) : null;
    video.removeAttribute('src'); if (videoURL) video.src = videoURL; else video.load();
    showVideoName(importedVideo?.name);
    video.muted = !!manifest.videoMuted; setVideoGain(validVolume(manifest.videoVolume) ? manifest.videoVolume : 1);
    await adaptClips(importedTracks);
    tracks.splice(0, tracks.length, ...importedTracks); nextId = manifest.nextId; timelineLength = manifest.version >= 4 ? manifest.length : null; restoreMarkers(manifest); clearHistory();
    rememberProjectFile(handle); showProjectName(handle?.name || file.name);
    renderTracks(); await saveProject(); status(tr('Project opened: {file}.', { file: file.name }));
  } catch (error) { status(tr('Could not open project: {message}', { message: error.message })); }
}
async function newProject() {
  if (recording) { status(tr('Stop recording before starting a new project.')); return; }
  const hasContent = selectedVideo || tracks.some(t => t.clips.length);
  const message = hasContent ? tr('The current video and recordings will be cleared. Use “Save project” first to keep a copy.') : '';
  if (!await ask(tr('Start a new project?'), message, tr('New project'), !!hasContent)) return;
  stopOvertime(); cursor = null; video.pause(); stopPlayback(); stopMonitoring();
  if (videoURL) URL.revokeObjectURL(videoURL);
  selectedVideo = null; videoURL = null;
  rememberProjectFile(null);
  video.removeAttribute('src'); video.load();
  $('video-file').value = '';
  showVideoName(null);
  video.muted = false; setVideoGain(1);
  nextId = 1; timelineLength = null; exportIn = 0; exportOut = null; clearHistory();
  tracks.splice(0, tracks.length, { id: nextId, name: tr('Track {n}', { n: nextId++ }), armed: true, muted: false, visible: true, clips: [] });
  renderTracks(); await saveProject(); status(tr('New project started.'));
}
// Export: audio only (WAV) or video + audio (MP4 with the original video packets copied and the new mix as soundtrack),
// over a chosen range. The mix is rendered offline with the same clip scheduling and fades as syncPlayback.
const MEDIABUNNY = 'https://cdn.jsdelivr.net/npm/mediabunny@1.59.1/dist/bundles/mediabunny.min.mjs';
const canExportVideo = 'AudioEncoder' in window && 'EncodedAudioChunk' in window;
let exporting = null, decodedVideoAudio = null;
const exportVideoAudio = { audio: false, video: true };
const exportKind = () => document.querySelector('input[name="export-kind"]:checked').value;
const videoDuration = () => selectedVideo && Number.isFinite(video.duration) ? video.duration : 0;
const exportBaseName = () => (projectName || 'project').replace(/\.audiorec$/i, '').replace(/[\/:*?"<>|]/g, '-');
const exportFileName = kind => `${exportBaseName()}${kind === 'video' ? '.mp4' : '-audio.wav'}`;
function defaultExportEnd(kind) {
  const end = projectLength() || clipsEnd();
  return kind === 'video' ? Math.min(end || videoDuration(), videoDuration()) : end;
}
function readExportRange() {
  const start = $('export-start').value.trim() ? parseLength($('export-start').value) : 0, end = parseLength($('export-end').value);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: tr('Start and end: use mm:ss:ff, mm:ss or seconds.') };
  if (end <= start) return { error: tr('The end must come after the start.') };
  if (exportKind() === 'video' && end > videoDuration() + .001) return { error: tr('The video ends at {time}.', { time: formatTime(videoDuration()) }) };
  return { start, end };
}
function setExportRange(start, end) { $('export-start').value = formatTime(start); $('export-end').value = formatTime(end); updateExportDialog(); }
function updateExportDialog() {
  const kind = exportKind(), check = $('export-video-audio'), range = readExportRange();
  check.disabled = !!exporting || !selectedVideo || videoAudio?.state === 'none';
  check.checked = !check.disabled && exportVideoAudio[kind];
  $('export-summary').textContent = range.error || tr('{length} long · {file}', { length: formatTime(range.end - range.start), file: exportFileName(kind) });
  $('export-summary').classList.toggle('error', !!range.error);
  $('export-ok').disabled = !!range.error || !!exporting;
  $('export-selection').disabled = !!exporting || !selectedClips.size;
}
function openExport() {
  if (recording) finishRecording();
  const hasVideo = videoDuration() > 0, videoRadio = $('export-kind-video');
  videoRadio.disabled = !hasVideo || !canExportVideo;
  $('export-video-hint').textContent = !hasVideo ? tr('Choose a video first') : !canExportVideo ? tr('Not supported in this browser') : tr('MP4: original picture, new soundtrack');
  if (videoRadio.disabled && videoRadio.checked) document.querySelector('input[name="export-kind"][value="audio"]').checked = true;
  $('export-progress').hidden = true;
  setMarkerRange();
  $('export-dialog').showModal();
}
for (const radio of document.querySelectorAll('input[name="export-kind"]')) radio.onchange = () => {
  if (exportKind() === 'video' && parseLength($('export-end').value) > videoDuration()) $('export-end').value = formatTime(defaultExportEnd('video'));
  updateExportDialog();
};
$('export-video-audio').onchange = event => { exportVideoAudio[exportKind()] = event.target.checked; };
for (const id of ['export-start', 'export-end']) $(id).addEventListener('input', updateExportDialog);
$('export-start-playhead').onclick = () => { $('export-start').value = formatTime(playPosition()); updateExportDialog(); };
$('export-end-playhead').onclick = () => { $('export-end').value = formatTime(playPosition()); updateExportDialog(); };
function setMarkerRange() { const end = exportOutTime(); setExportRange(exportIn, exportKind() === 'video' ? Math.min(end, videoDuration()) : end); }
$('export-markers').onclick = setMarkerRange;
$('export-whole').onclick = () => setExportRange(0, defaultExportEnd(exportKind()));
$('export-selection').onclick = () => {
  const clips = [...selectedClips];
  if (clips.length) setExportRange(Math.min(...clips.map(c => c.start)), Math.max(...clips.map(c => c.start + clipDuration(c))));
};
$('export-cancel').onclick = $('export-close').onclick = () => $('export-dialog').close();
$('export-dialog').addEventListener('close', () => { if (exporting) { exporting.canceled = true; exporting.conversion?.cancel(); } });
$('export-dialog').querySelector('form').onsubmit = event => { event.preventDefault(); runExport(); };
async function decodeVideoAudio(rate) {
  if (decodedVideoAudio?.file === selectedVideo && decodedVideoAudio.rate === rate) return decodedVideoAudio.buffer;
  if (selectedVideo.size > 1.5e9) throw new Error(tr('the video is too large to read its audio'));
  let buffer;
  try { buffer = await new OfflineAudioContext(2, 1, rate).decodeAudioData(await selectedVideo.arrayBuffer()); }
  catch { throw new Error(tr('the video audio could not be read')); }
  decodedVideoAudio = { file: selectedVideo, rate, buffer };
  return buffer;
}
async function renderMix(start, end, rate, channels, videoBuffer) {
  // Pre-roll for track latency: the first preroll samples are rendered only to fill the effects, then dropped.
  const audible = tracks.filter(t => !t.muted && !isHidden(t)), preroll = Math.ceil(Math.max(0, ...audible.map(t => trackLatency(t, rate))) * rate), lead = preroll / rate;
  const length = Math.max(1, Math.round((end - start) * rate));
  if ((length + preroll) * channels * 4 > 2e9) throw new Error(tr('the range is too long to export at once'));
  const offline = new OfflineAudioContext(channels, length + preroll, rate);
  await prepareTrackEffects(offline, tracks);
  if (videoBuffer && start < videoBuffer.duration) {
    const node = offline.createBufferSource(), level = offline.createGain();
    node.buffer = videoBuffer; level.gain.value = videoGain;
    node.connect(level); level.connect(offline.destination); node.start(lead, start);
  }
  for (const track of tracks) {
    if (track.muted || isHidden(track)) continue;
    // Offline time 0 is lead before the export start; latency-compensated tracks read further ahead.
    let eqInput = null; const from = start - lead + trackLatency(track, rate);
    for (const clip of track.clips) {
      const duration = clipDuration(clip), elapsed = Math.max(0, from - clip.start);
      if (clip.muted || duration <= 0 || elapsed >= duration || clip.start >= end - start + from) continue;
      const startTime = Math.max(0, clip.start - from);
      const node = offline.createBufferSource(), gain = offline.createGain(), level = offline.createGain();
      level.gain.value = (track.volume ?? 1) * (clip.gain ?? 1);
      if (!eqInput) { eqInput = offline.createGain(); connectTrackEQ(offline, track, eqInput, connectPan(offline, track, offline.destination).input); }
      node.buffer = clip.buffer; node.connect(gain); gain.connect(level); level.connect(eqInput);
      scheduleFades(gain.gain, startTime, elapsed, clipFades(track, clip));
      node.start(startTime, (clip.trimStart || 0) + elapsed, duration - elapsed);
    }
  }
  const rendered = await offline.startRendering(); if (!preroll) return rendered;
  const mix = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: rate });
  for (let c = 0; c < channels; c++) mix.copyToChannel(rendered.getChannelData(c).subarray(preroll, preroll + length), c);
  return mix;
}
const wavBlob = buffer => new Blob([wavBytes(Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)), buffer.sampleRate)], { type: 'audio/wav' });
function wavBytes(data, rate) {
  const channels = data.length, length = data[0].length, size = length * channels * 2;
  if (size + 44 > 0xffffffff) throw new Error(tr('the range is too long for a single WAV'));
  const bytes = new ArrayBuffer(44 + size), view = new DataView(bytes);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + size, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, size, true);
  for (let i = 0, at = 44; i < length; i++) for (let c = 0; c < channels; c++, at += 2) { const sample = Math.max(-1, Math.min(1, data[c][i])); view.setInt16(at, sample < 0 ? sample * 32768 : sample * 32767, true); }
  return new Uint8Array(bytes);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const safeFileName = name => name.replace(/[\\/:*?"<>|]/g, '-').trim() || tr('Clip');
// One clip as it plays: trimmed, with the playback fades, without the track volume.
function clipWav(clip) {
  const rate = clip.buffer.sampleRate, from = Math.round((clip.trimStart || 0) * rate);
  const planes = clipChannels(clip.buffer).map(data => data.slice(from, Math.min(data.length, from + Math.round(clipDuration(clip) * rate)))), samples = planes[0];
  const fade = Math.min(FADE_SECONDS * rate, (samples.length - 1) / 2);
  // A downloaded clip stands alone: its own gain and fades, no crossfades with its neighbours.
  const fades = fitFades({ duration: samples.length - 1, in: Math.max(fade, (clip.fadeIn || 0) * rate), out: Math.max(fade, (clip.fadeOut || 0) * rate) }), gain = clip.gain ?? 1;
  for (const plane of planes) for (let i = 0; i < plane.length; i++) plane[i] *= fadeGain(i, fades) * gain;
  return wavBytes(planes, rate);
}
// Minimal ZIP writer (stored, no compression: WAV barely compresses) for downloading every clip at once.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipBlob(files) {
  const now = new Date(), time = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1, date = (now.getFullYear() - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = new TextEncoder().encode(name), crc = crc32(data);
    const header = (size, fields) => { const view = new DataView(new ArrayBuffer(size)); for (const [at, bits, value] of fields) view[`setUint${bits}`](at, value, true); return view; };
    const common = [[10, 16, time], [12, 16, date], [14, 32, crc], [18, 32, data.length], [22, 32, data.length], [26, 16, nameBytes.length]];
    parts.push(header(30, [[0, 32, 0x04034b50], [4, 16, 20], [6, 16, 0x800], ...common]), nameBytes, data);
    central.push(header(46, [[0, 32, 0x02014b50], [4, 16, 20], [6, 16, 20], [8, 16, 0x800], ...common.map(([at, bits, value]) => [at + 2, bits, value]), [42, 32, offset]]), nameBytes);
    offset += 30 + nameBytes.length + data.length;
    if (offset > 0xffffffff) throw new Error(tr('the clips are too large for one ZIP'));
  }
  const size = central.reduce((total, part) => total + part.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
function downloadAllClips() {
  const clips = [...$('clip-items').children].map(item => item.clip), used = new Set();
  if (!clips.length) return;
  try {
    const files = clips.map(clip => {
      const base = safeFileName(clip.name || tr('Clip'));
      let name = `${base}.wav`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).wav`;
      used.add(name.toLowerCase());
      return { name, data: clipWav(clip) };
    });
    const zipName = `${exportBaseName()}-clips.zip`;
    downloadBlob(zipBlob(files), zipName); status(trn('{count} clip downloaded as {file}.', '{count} clips downloaded as {file}.', files.length, { file: zipName }));
  } catch (error) { status(tr('Download failed: {message}', { message: error.message })); }
}
$('clip-zip').onclick = downloadAllClips;
function showClipList(open) {
  $('clip-list').classList.toggle('collapsed', !open);
  $('clip-list-toggle').setAttribute('aria-expanded', String(open));
  $('clip-list-toggle').title = open ? tr('Hide the clip list') : tr('Show the clip list');
  try { localStorage.setItem('audiorec-clip-list', open ? 'shown' : 'hidden'); } catch {}
}
$('clip-list-toggle').onclick = () => showClipList($('clip-list').classList.contains('collapsed'));
try { if (localStorage.getItem('audiorec-clip-list') === 'hidden') showClipList(false); } catch {}
async function muxVideo(mix, { start, end }, job) {
  const mb = await import(MEDIABUNNY);
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(selectedVideo) });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const conversion = job.conversion = await mb.Conversion.init({ input, output, composable: true, tracks: 'primary', audio: { discard: true }, trim: { start, end }, showWarnings: false });
  if (!conversion.utilizedTracks.some(track => track.isVideoTrack())) throw new Error(tr('the video track cannot be written to an MP4'));
  const [codec] = await mb.getEncodableAudioCodecs(['aac', 'opus'], { numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate });
  if (!codec) throw new Error(tr('this browser cannot encode the audio'));
  const audio = new mb.AudioBufferSource({ codec, bitrate: mb.QUALITY_HIGH });
  output.addAudioTrack(audio);
  conversion.onProgress = progress => { $('export-progress').value = progress; };
  await output.start();
  await Promise.all([conversion.execute(), audio.add(mix).then(() => audio.close())]);
  if (job.canceled) throw new Error('canceled');
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
async function runExport() {
  const range = readExportRange(), kind = exportKind();
  if (range.error || exporting) return;
  const withVideoAudio = $('export-video-audio').checked;
  if (kind === 'audio' && !withVideoAudio && !tracks.some(t => !t.muted && !isHidden(t) && t.clips.some(c => !c.muted))) { status(tr('No audible recordings to export.')); return; }
  const job = exporting = { canceled: false }, progress = $('export-progress'), name = exportFileName(kind);
  for (const element of $('export-dialog').querySelectorAll('input, .export-range button')) element.disabled = true;
  progress.hidden = false; progress.removeAttribute('value');
  $('export-summary').textContent = withVideoAudio ? tr('Reading the video audio…') : tr('Mixing…');
  $('export-ok').disabled = true;
  try {
    const rate = PROJECT_RATE;
    const videoBuffer = withVideoAudio ? await decodeVideoAudio(rate) : null;
    if (job.canceled) return;
    $('export-summary').textContent = tr('Mixing…');
    const audible = tracks.filter(t => !t.muted && !isHidden(t)), stereo = kind === 'video' || videoBuffer?.numberOfChannels > 1 || audible.some(t => (t.pan ?? 0) !== 0 || t.clips.some(c => !c.muted && c.buffer.numberOfChannels > 1));
    const mix = await renderMix(range.start, range.end, rate, stereo ? 2 : 1, videoBuffer);
    if (job.canceled) return;
    if (kind === 'video') { $('export-summary').textContent = tr('Writing the video…'); progress.value = 0; }
    const blob = kind === 'video' ? await muxVideo(mix, range, job) : wavBlob(mix);
    if (job.canceled) return;
    downloadBlob(blob, name);
    status(tr('Exported {file} ({start} – {end}).', { file: name, start: formatTime(range.start), end: formatTime(range.end) }));
    exporting = null; $('export-dialog').close();
    placeMarkers(range.start, range.end, tr('set export range'));
  } catch (error) {
    if (!job.canceled) status(tr('Export failed: {message}', { message: error.message }));
  } finally {
    if (exporting === job) exporting = null;
    for (const element of $('export-dialog').querySelectorAll('input')) element.disabled = false;
    for (const element of $('export-dialog').querySelectorAll('.export-range button')) element.disabled = false;
    if ($('export-dialog').open) { progress.hidden = true; openExportControls(); }
  }
}
function openExportControls() { $('export-kind-video').disabled = videoDuration() <= 0 || !canExportVideo; updateExportDialog(); }
function loadVideo(file) {
  if (!file) return;
  stopOvertime(); cursor = null;
  if (recording) finishRecording(); stopPlayback();
  if (videoURL) URL.revokeObjectURL(videoURL);
  selectedVideo = file;
  videoURL = URL.createObjectURL(file); video.src = videoURL;
  saveProject();
  showVideoName(file.name); status(tr('Video loaded. Press Play or Record.'));
}
$('video-file').onchange = event => loadVideo(event.target.files[0]);
function showVideoName(name) {
  $('video-name').textContent = name || tr('Choose video');
  $('video-picker').classList.toggle('primary', !name);
  $('video-picker').title = name ? tr('{file}: click to choose another video', { file: name }) : tr('Choose video');
  readVideoAudio(name ? selectedVideo : null);
}
showVideoName(null);
function updateVideoMute() {
  const rowMute = $('video-audio-mute');
  setIconButton(rowMute, video.muted ? 'mute' : 'volume', tr('Mute'), video.muted ? tr('Unmute video audio') : tr('Mute video audio'));
  rowMute.setAttribute('aria-pressed', String(video.muted));
  showVolumeHandle($('video-audio-volume'), videoGain, tr('Video volume'));
}
// Up to 0 dB the element's own volume is enough; boosting routes the video through a GainNode (permanent for this page).
let videoGain = 1, videoGainNode = null;
function setVideoGain(gain) {
  videoGain = gain;
  if (gain > 1 && !videoGainNode) {
    const audio = getContext(); videoGainNode = audio.createGain();
    audio.createMediaElementSource(video).connect(videoGainNode).connect(audio.destination);
  }
  if (videoGainNode) { videoGainNode.gain.value = gain; video.volume = 1; } else video.volume = gain;
  updateVideoMute();
}
$('video-audio-volume').onclick = () => openVolume($('video-audio-volume'), { title: tr('Video audio'), get: () => videoGain, set: setVideoGain, commit: () => saveProject() });
$('video-audio-mute').onclick = () => { video.muted = !video.muted; };
video.addEventListener('volumechange', () => { updateVideoMute(); if (!restoring) saveProject(); });
updateVideoMute();
for (const id of ['project-menu']) $(id).addEventListener('click', event => { if (event.target.closest('button')) $(id).hidePopover(); });
$('name-cancel').onclick = () => $('name-dialog').close('cancel');
$('track-visibility').onclick = openVisibility;
$('visibility-close').onclick = () => $('visibility-dialog').close();
$('add-track').onclick = addTrack;
$('import-audio').onclick = $('clip-import').onclick = () => $('import-file').click();
$('import-file').onchange = event => { const files = [...event.target.files]; event.target.value = ''; importAudio(files); };
const dropRow = event => [...$('tracks').children].findIndex(row => { const box = row.getBoundingClientRect(); return event.clientY >= box.top && event.clientY < box.bottom; });
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
const isAudioFile = file => file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm|aif|aiff)$/i.test(file.name);
const isVideoFile = file => file.type.startsWith('video/');
function clearFileDrag() {
  $('file-drop').hidden = true;
  [...$('tracks').children].forEach(row => row.classList.remove('drop-target'));
}
window.addEventListener('dragenter', event => { if (hasFiles(event) && !restoring) $('file-drop').hidden = false; });
window.addEventListener('dragover', event => {
  event.preventDefault();
  if (!hasFiles(event)) return;
  event.dataTransfer.dropEffect = restoring ? 'none' : 'copy';
  $('file-drop').hidden = restoring;
  const index = !restoring && !recording && $('timeline-scroll').contains(event.target) ? dropRow(event) : -1;
  [...$('tracks').children].forEach((row, i) => row.classList.toggle('drop-target', i === index));
});
window.addEventListener('dragleave', event => { if (!event.relatedTarget || !document.documentElement.contains(event.relatedTarget)) clearFileDrag(); });
window.addEventListener('drop', event => {
  event.preventDefault();
  const index = $('timeline-scroll').contains(event.target) ? dropRow(event) : -1;
  clearFileDrag();
  if (!hasFiles(event) || restoring) return;
  const files = [...event.dataTransfer.files], file = files.find(f => isAudioFile(f) || isVideoFile(f));
  if (!file) { status(tr('Could not import: unsupported audio or video file.')); return; }
  if (recording) { status(tr('Stop recording before importing files.')); return; }
  const ignored = files.length - 1;
  if (isVideoFile(file) && !isAudioFile(file)) {
    loadVideo(file);
    if (ignored) status(tr('{file} selected; {count} other files ignored.', { file: file.name, count: ignored }));
  } else importAudio([file], index >= 0 ? tracks[index] : undefined, index >= 0 ? (event.clientX - $('timeline').getBoundingClientRect().left) / pxPerSecond : playPosition()).then(() => {
    if (ignored) status(tr('{file} selected; {count} other files ignored.', { file: file.name, count: ignored }));
  });
});
$('undo').onclick = undo;
$('redo').onclick = redo;
$('record').onclick = toggleRecording;
$('export').onclick = openExport;
$('new-project').onclick = newProject;
$('save-project').onclick = saveProjectFile;
$('open-project-button').onclick = async () => {
  if (!window.showOpenFilePicker) { $('open-project').click(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({ types: PROJECT_TYPES });
    await openProject(await handle.getFile(), handle);
  } catch (error) { if (error.name !== 'AbortError') status(tr('Could not open project: {message}', { message: error.message })); }
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
// Help is a modal dialog opened from the main menu, one tab per topic; close with the X, Esc or a click outside.
// Tabs follow the WAI-ARIA pattern: only the selected tab is in the Tab order, arrows / Home / End move between tabs.
const helpTabs = [...document.querySelectorAll('#help-dialog [role="tab"]')];
function showHelpTab(tab, focus) {
  for (const other of helpTabs) { const selected = other === tab; other.setAttribute('aria-selected', selected); other.tabIndex = selected ? 0 : -1; $(other.getAttribute('aria-controls')).hidden = !selected; }
  if (focus) tab.focus();
}
for (const tab of helpTabs) {
  tab.onclick = () => showHelpTab(tab);
  tab.onkeydown = event => {
    const index = helpTabs.indexOf(tab), next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: helpTabs.length - 1 }[event.key];
    if (next === undefined) return; event.preventDefault(); showHelpTab(helpTabs.at(next % helpTabs.length), true);
  };
}
// Help > Keyboard shortcuts, the single list of every shortcut: [keys, action]. In keys, ' / ' separates alternatives
// and '+' combinations; click, drag, wheel and double-click are mouse actions, everything else a key.
function renderShortcuts() {
  const mouse = { click: tr('click'), drag: tr('drag'), wheel: tr('wheel'), 'double-click': tr('double-click') };
  const groups = [
    [tr('Playback and recording'), [['Space', tr('Play / pause')], ['*', tr('Start / stop recording')], ['F', tr('Video full screen')], ['V', tr('Show / hide the video and clips panel')], ['H', tr('Open Help on the keyboard shortcuts')], ['+ / -', tr('Move the playhead 1 second')], ['Ctrl++ / Ctrl+-', tr('Move the playhead 10 seconds')], ['Shift++ / Shift+-', tr('Move the playhead 1 frame')], [',', tr('Move the playhead to the export start')], ['.', tr('Move the playhead to the export end')]]],
    [tr('Export range'), [['I', tr('Set the export start at the playhead')], ['O', tr('Set the export end at the playhead')], ['double-click', tr('Reset an export marker')]]],
    [tr('Clips'), [['← / →', tr('Move the selected clips 1 second')], ['Ctrl+← / Ctrl+→', tr('Move the selected clips 10 seconds')], ['Shift+← / Shift+→', tr('Move the selected clips 1 frame')], ['C', tr('Cut the selected clips at the playhead')], ['G', tr('Glue the selected overlapping clips')], ['M', tr('Mute / unmute the selected clips')], ['Del / Backspace', tr('Delete the selected clips')], ['Esc', tr('Clear the selection')], ['Shift+click', tr('Add a clip to the selection')], ['Alt+drag', tr('Duplicate the selected clips')], ['double-click', tr('Rename a track; open the settings of a clip')]]],
    [tr('Undo'), [['Ctrl+Z', tr('Undo')], ['Ctrl+Shift+Z / Ctrl+Y', tr('Redo')]]],
    [tr('View'), [['Q', tr('Zoom to the whole timeline')], ['W', tr('Zoom out')], ['E', tr('Zoom in')], ['Ctrl+wheel', tr('Zoom over the timeline')], ['↑ / ↓', tr('Resize the video panel (splitter focused)')]]],
    [tr('Effects'), [['Alt+↑ / Alt+↓', tr('Move the focused effect up / down')], ['↑ / ↓', tr('Change the focused knob (Shift: fine)')], ['Home / End', tr('Knob minimum / maximum')], ['double-click', tr('Reset a knob')]]],
  ];
  const keys = text => { const cell = document.createElement('td'); cell.className = 'shortcut-keys'; text.split(' / ').forEach((option, i) => {
    if (i) cell.append(' / ');
    option.split(/\+(?=.)/).forEach((part, j) => { if (j) cell.append('+'); if (mouse[part]) cell.append(mouse[part]); else { const kbd = document.createElement('kbd'); kbd.textContent = part; cell.append(kbd); } });
  }); return cell; };
  $('help-keys').replaceChildren(...groups.map(([title, rows]) => {
    const table = document.createElement('table'), caption = document.createElement('caption'); table.className = 'shortcuts'; caption.textContent = title; table.append(caption);
    for (const [combo, action] of rows) { const row = document.createElement('tr'), what = document.createElement('td'); what.textContent = action; row.append(keys(combo), what); table.append(row); }
    return table;
  }));
}
renderShortcuts();
$('open-help').onclick = () => { $('help-dialog').showModal(); helpTabs.find(tab => tab.getAttribute('aria-selected') === 'true').focus(); };
for (const tip of document.querySelectorAll('dialog.tip')) {
  tip.querySelector('.tip-close').onclick = () => tip.close();
}
for (const tip of document.querySelectorAll('#project-menu, #language-menu, #theme-menu')) tip.addEventListener('toggle', event => {
  const button = document.querySelector(`[popovertarget="${tip.id}"]`);
  button.classList.toggle('open', event.newState === 'open');
  if (event.newState === 'open') anchorPopover(tip, button);
});
$('open-settings').onclick = () => $('device-dialog').showModal();
// Dedicated header menu; native popover handles Escape and outside clicks.
$('language-options').replaceChildren(...I18N.languages().map(([code, name]) => {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'menu-item';
  button.textContent = name; button.lang = code; button.dataset.language = code;
  if (code === I18N.language) button.setAttribute('aria-current', 'true');
  button.onclick = () => I18N.setLanguage(code);
  return button;
}));
// The toggle shows the current language by its own name; tooltip and accessible name keep the word "Language".
const languageLabel = I18N.languages().find(([code]) => code === I18N.language)?.[1] || 'English';
$('language-button').lastElementChild.textContent = languageLabel; $('language-button').title = $('language-button').ariaLabel = `${tr('Language')}: ${languageLabel}`;
// Theme menu: the saved mode (theme.js) is separate from the scheme it resolves to; System shows what the device asks for.
const THEME_NAMES = { system: () => tr('System'), dark: () => tr('Dark'), light: () => tr('Light'), accessible: () => tr('Accessible') };
function renderThemeMenu() {
  $('theme-options').replaceChildren(...THEME.MODES.map(mode => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'menu-item theme-option'; button.dataset.themeOption = mode;
    const name = document.createElement('span'); name.textContent = THEME_NAMES[mode](); button.append(name);
    const hint = mode === 'system' ? tr('Now: {theme}', { theme: THEME_NAMES[THEME.scheme]() }) : mode === 'accessible' ? tr('High contrast, clear focus, labeled states') : '';
    if (hint) { const note = document.createElement('span'); note.className = 'theme-option-hint'; note.textContent = hint; button.append(note); }
    if (mode === THEME.mode) button.setAttribute('aria-current', 'true');
    button.onclick = () => { $('theme-menu').hidePopover(); THEME.setMode(mode); status(tr('Theme: {theme}.', { theme: THEME_NAMES[mode]() })); };
    return button;
  }));
}
renderThemeMenu();
// A new scheme redraws the canvases (waveforms) with its colors; tracks and project data are not touched.
THEME.onChange((scheme, mode, changed) => { renderThemeMenu(); if (changed) { videoWave.scale = 0; renderTracks(); } });
$('input-meter').onclick = () => { if (!recording) $('test-mic').click(); };
$('monitor').onclick = toggleMonitor;
$('enhanced-audio').onclick = toggleEnhancedAudio;
updateEnhancedButton();
$('play').onclick = togglePlay;
for (const type of ['play', 'pause', 'ended']) video.addEventListener(type, updatePlayButton);
updateMonitor();
$('output-device').onchange = setOutput;
$('input-device').onchange = () => { if (!recording && stream) stopMonitoring(); };
$('test-mic').onclick = async () => {
  if (recording) return;
  if (stream) { stopMonitoring(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { status(tr('Microphone only available on localhost or HTTPS.')); return; }
  $('test-mic').disabled = true;
  try { await startMonitoring(); } catch (error) { stopMonitoring(); status(tr('Microphone unavailable: {message}', { message: error.message })); }
  finally { $('test-mic').disabled = false; }
};
document.addEventListener('pointerup', event => {
  const control = event.target instanceof Element && event.target.closest('button, input[type="range"]');
  if (control && !control.closest('dialog')) control.blur();
});
// Physical keys for + and -: from the keyboard layout where the browser exposes it, otherwise learned from a press that
// types them, so Shift still seeks when it changes the character (on Italian keyboards Shift + + types *).
const seekCodes = { 1: new Set(['NumpadAdd']), [-1]: new Set(['NumpadSubtract']) };
navigator.keyboard?.getLayoutMap?.().then(map => { for (const [code, char] of map) { if (char === '+' || char === '=') seekCodes[1].add(code); else if (char === '-') seekCodes[-1].add(code); } }).catch(() => {});
function seekDirection(event) {
  const typed = event.key === '+' ? 1 : event.key === '-' ? -1 : 0;
  if (typed && !event.code.startsWith('Numpad')) seekCodes[typed].add(event.code);
  return seekCodes[1].has(event.code) ? 1 : seekCodes[-1].has(event.code) ? -1 : typed;
}
// Moves the selected clips by seconds, keeping their spacing and stopping at 0. A held key is one undo step.
function nudgeClips(seconds, repeat) {
  const clips = [...selectedClips], shift = Math.max(-Math.min(...clips.map(c => c.start)), seconds);
  if (!shift) return;
  if (!repeat) remember(trn('move clip', 'move {count} clips', clips.length));
  for (const clip of clips) clip.start += shift;
  renderTracks(); syncPlayback(); saveProject();
}
document.addEventListener('keydown', async event => {
  const editing = event.target instanceof Element && event.target.closest('input:not([type="range"]), select, textarea, [contenteditable]');
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
    if (editing || document.querySelector('dialog[open]')) return;
    event.preventDefault(); if (key === 'y' || event.shiftKey) redo(); else undo(); return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedClips.size && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); deleteSelectedClips(); return; }
  if (key === 'f' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.video-frame').requestFullscreen(); }
    catch (error) { status(tr('Could not toggle full screen: {message}', { message: error.message })); }
    return;
  }
  if ((key === 'i' || key === 'o') && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) {
    event.preventDefault(); markAtPlayhead(key === 'i' ? 'in' : 'out'); return;
  }
  // + and - move the playhead, the arrows move the selected clips: 1 s, Ctrl 10 s, Shift one video frame. Controls that
  // use the arrows themselves (fields, knobs, tabs, the splitter, effect rows) keep them; recording is never interrupted.
  const free = !event.altKey && !event.metaKey && !recording && !editing && !document.querySelector('dialog[open], :popover-open');
  const seek = free ? seekDirection(event) : 0;
  if (seek) {
    event.preventDefault(); const position = playPosition();
    seekTo(event.shiftKey ? (Math.round(position * fps) + seek) / fps : position + seek * (event.ctrlKey ? 10 : 1)); return;
  }
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && free && selectedClips.size && !(event.target instanceof Element && event.target.closest('[role="slider"], [role="tab"], [role="separator"], .fx-item'))) {
    event.preventDefault(); nudgeClips((event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 / fps : event.ctrlKey ? 10 : 1), event.repeat); return;
  }
  // Q fits the whole timeline, W zooms out, E zooms in.
  if ((key === 'q' || key === 'w' || key === 'e') && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) {
    event.preventDefault(); if (key === 'q') { $('zoom').value = $('zoom').min; rescale(); } else zoomBy(key === 'e' ? 1 : -1); return;
  }
  if ((event.key === ',' || event.key === '.') && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) {
    event.preventDefault(); seekTo(event.key === ',' ? exportIn : exportOutTime()); return;
  }
  if (key === 'm' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); toggleClipMute(); return; }
  if (key === 'h' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); $('help-dialog').showModal(); showHelpTab($('help-tab-keys'), true); return; }
  if (key === 'v' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); $('video-panel-toggle').click(); return; }
  if (key === 'g' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); glueClips(); return; }
  if (key === 'c' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); cutClips(); return; }
  if (event.key === 'Escape' && selectedClips.size && !editing && !document.querySelector('dialog[open], :popover-open')) { selectedClips.clear(); updateSelection(); return; }
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
  togglePlay();
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
      try { await play(); } catch (error) { status(tr('Playback not started: {message}', { message: error.message })); }
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
function showVideoPanel(open) {
  const button = $('video-panel-toggle');
  if (!open && ($('video-panel').contains(document.activeElement) || document.activeElement === $('splitter'))) button.focus();
  $('video-panel').hidden = $('splitter').hidden = !open;
  document.querySelector('.app').classList.toggle('video-hidden', !open);
  button.setAttribute('aria-pressed', String(open)); button.setAttribute('aria-expanded', String(open));
  button.title = open ? tr('Hide video and clips panel (V)') : tr('Show video and clips panel (V)'); button.setAttribute('aria-label', button.title);
  try { localStorage.setItem('audiorec-video-panel', open ? 'shown' : 'hidden'); } catch {}
  const height = document.querySelector('.app').style.getPropertyValue('--video-height');
  if (open && height) setVideoHeight(parseInt(height, 10));
  if (!restoring) rescale();
}
$('video-panel-toggle').onclick = () => showVideoPanel($('video-panel').hidden);
function setVideoHeight(height) {
  const app = document.querySelector('.app');
  if ($('video-panel').hidden) return;
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
try { if (localStorage.getItem('audiorec-video-panel') === 'hidden') showVideoPanel(false); } catch {}
window.addEventListener('resize', () => { const height = document.querySelector('.app').style.getPropertyValue('--video-height'); if (height) setVideoHeight(parseInt(height, 10)); rescale(); });
video.addEventListener('loadedmetadata', () => { rescale(); detectFps(); });
let ticksFrame = null;
$('track-headers').addEventListener('wheel', event => { if (event.ctrlKey || event.metaKey) return; event.preventDefault(); $('timeline-scroll').scrollTop += event.deltaY; }, { passive: false });
$('timeline-scroll').addEventListener('scroll', () => {
  saveView(); $('track-headers').scrollTop = $('timeline-scroll').scrollTop; ticksFrame ??= requestAnimationFrame(() => { ticksFrame = null; renderTicks(); drawVideoWave(); }); });
video.addEventListener('play', async () => { overPlaying = false; cursor = null; if (context) await context.resume(); syncPlayback(); if (playheadFrame === null) animatePlayhead(); });
video.addEventListener('pause', () => { if (video.ended && timelineEnd() > video.duration + .01) return; if (recording) finishRecording(); stopPlayback(); stopPlayhead(); });
video.addEventListener('seeking', () => { if (cursor !== null && video.currentTime < video.duration - .01) cursor = null; if (recording) finishRecording(); stopPlayback(); });
video.addEventListener('timeupdate', updatePlayhead);
video.addEventListener('seeked', () => { syncPlayback(); updatePlayhead(); });
video.addEventListener('ended', () => {
  if (loopRange()) { restartLoop(); return; }
  if (timelineEnd() > video.duration + .01) { cursor = video.duration; startOvertime(); return; }
  if (recording) finishRecording(); stopPlayback(); stopPlayhead();
});
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
for (const id of ['video-file', 'add-track', 'import-audio', 'clip-import', 'track-visibility', 'record', 'export', 'new-project', 'save-project', 'open-project', 'open-project-button']) $(id).disabled = true;
// An AudioContext created before any click starts suspended (e.g. when restoring a boosted video volume).
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { if (context?.state === 'suspended') context.resume(); }, true);
// Custom tooltips: every title attribute (static or set later by code) moves to data-tooltip, so the native tooltip never
// shows, and is displayed in a styled top-layer popover on hover or keyboard focus.
const tooltip = document.createElement('div'); tooltip.className = 'tooltip'; tooltip.popover = 'manual'; tooltip.setAttribute('role', 'tooltip');
document.body.append(tooltip);
let tooltipTarget = null, tooltipTimer = null, tooltipHiddenAt = 0;
function fillTooltip(text) {
  const [, main, key] = /^(.*?)\s*\(([^()]+)\)$/s.exec(text) || [, text];
  tooltip.replaceChildren(main);
  if (key) { const hint = document.createElement('span'); hint.className = 'tooltip-key'; hint.textContent = key; tooltip.append(hint); }
}
function adoptTitle(element) {
  const text = element.getAttribute('title'); element.removeAttribute('title');
  if (!text) { delete element.dataset.tooltip; return; }
  element.dataset.tooltip = text;
  if ('tooltipLabel' in element.dataset || (!element.hasAttribute('aria-label') && !element.textContent.trim())) { element.setAttribute('aria-label', text); element.dataset.tooltipLabel = ''; }
  if (element === tooltipTarget && tooltip.matches(':popover-open')) fillTooltip(text);
}
function adoptTitles(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (node.hasAttribute('title')) adoptTitle(node);
  node.querySelectorAll('[title]').forEach(adoptTitle);
}
adoptTitles(document.body);
new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes') { if (record.target.hasAttribute('title')) adoptTitle(record.target); }
    else record.addedNodes.forEach(adoptTitles);
  }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
function showTooltip(target) {
  tooltipTimer = null;
  if (!target.isConnected || !target.dataset.tooltip) return;
  fillTooltip(target.dataset.tooltip);
  if (tooltip.matches(':popover-open')) tooltip.hidePopover();
  tooltip.showPopover();
  const box = target.getBoundingClientRect(), width = tooltip.offsetWidth, height = tooltip.offsetHeight;
  const below = box.bottom + 8, above = box.top - height - 8;
  tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2))}px`;
  tooltip.style.top = `${below + height > window.innerHeight - 8 && above > 8 ? above : below}px`;
}
function hideTooltip() {
  clearTimeout(tooltipTimer); tooltipTimer = null; tooltipTarget = null;
  if (tooltip.matches(':popover-open')) { tooltip.hidePopover(); tooltipHiddenAt = performance.now(); }
}
function queueTooltip(target, delay) {
  hideTooltip();
  if (!target) return;
  tooltipTarget = target;
  tooltipTimer = setTimeout(() => showTooltip(target), performance.now() - tooltipHiddenAt < 400 ? 0 : delay);
}
document.addEventListener('pointerover', event => {
  const target = event.target instanceof Element ? event.target.closest('[data-tooltip]') : null;
  if (target !== tooltipTarget) queueTooltip(event.pointerType === 'touch' ? null : target, 450);
});
document.addEventListener('pointerout', event => { if (!event.relatedTarget) hideTooltip(); });
document.addEventListener('focusin', event => { const target = event.target.closest?.('[data-tooltip]'); if (target?.matches(':focus-visible')) queueTooltip(target, 0); });
document.addEventListener('focusout', hideTooltip);
for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, hideTooltip, true);
document.addEventListener('scroll', hideTooltip, true);
// View state kept across reloads in this browser: selected clips, zoom, horizontal scroll and playhead position.
// Saving starts only once the saved view has been applied, so the startup render does not overwrite it.
function writeView() {
  clearTimeout(viewTimer); viewTimer = null;
  if (!viewReady) return;
  const selection = tracks.flatMap((track, t) => track.clips.flatMap((clip, c) => selectedClips.has(clip) ? [[t, c]] : []));
  try { localStorage.setItem('audiorec-view', JSON.stringify({ zoom: +$('zoom').value, scroll: $('timeline-scroll').scrollLeft, time: playPosition(), selection })); } catch {}
}
function saveView() { if (viewReady && viewTimer === null) viewTimer = setTimeout(writeView, 300); }
window.addEventListener('pagehide', writeView);
async function restoreView() {
  let view = null;
  try { view = JSON.parse(localStorage.getItem('audiorec-view')); } catch {}
  if (view && typeof view === 'object') {
    const settle = (events, ms) => new Promise(resolve => { for (const type of events) video.addEventListener(type, resolve, { once: true }); setTimeout(resolve, ms); });
    if (selectedVideo && video.readyState < 1) await settle(['loadedmetadata', 'error'], 4000);
    if (Number.isFinite(view.zoom)) { $('zoom').value = view.zoom; rescale(); }
    for (const [t, c] of Array.isArray(view.selection) ? view.selection : []) { const clip = tracks[t]?.clips[c]; if (clip) selectedClips.add(clip); }
    updateSelection();
    const first = tracks.flatMap(t => t.clips).find(clip => selectedClips.has(clip));
    if (first) revealClipItem(first);
    if (Number.isFinite(view.time) && view.time > 0) { const seeked = videoLength() ? settle(['seeked'], 1500) : null; seekTo(view.time); await seeked; }
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (Number.isFinite(view.scroll)) { stopTimelineScroll(); $('timeline-scroll').scrollLeft = view.scroll; }
  }
  viewReady = true;
}
restoreProject().then(restoreView); listDevices();
