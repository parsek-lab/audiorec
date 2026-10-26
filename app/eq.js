// Native Web Audio effect chain. Persist settings, never audio nodes.
// Cuts are Butterworth cascades: -3 dB at the cutoff, no resonance. Slope in dB/octave; files before v10 have none (12).
const CUT_SLOPES = [12, 24, 36, 48], BUTTERWORTH_Q = { 12: [.7071], 24: [.5412, 1.3066], 36: [.5176, .7071, 1.9319], 48: [.5098, .6013, .9, 2.5629] };
const copyEQ = eq => eq ? { enabled: eq.enabled, bands: eq.bands.map(b => b.type === 'peaking' ? { ...b } : { ...b, slope: b.slope ?? 12 }) } : null;
function validEQ(eq) {
  return eq === null || (!!eq && typeof eq.enabled === 'boolean' && Array.isArray(eq.bands) && eq.bands.length === 6 && eq.bands.every((b, i) => b && b.type === (i === 0 ? 'highpass' : i === 1 ? 'lowpass' : 'peaking') && typeof b.enabled === 'boolean' && Number.isFinite(b.freq) && b.freq >= 20 && b.freq <= 20000 && Number.isFinite(b.gain) && Math.abs(b.gain) <= 24 && Number.isFinite(b.q) && b.q >= .1 && b.q <= 20 && (b.slope === undefined || (i < 2 && CUT_SLOPES.includes(b.slope)))));
}
// Every kind of effect in one table: the equalizer, the compressor (compressor.js) and the utility effects of effects.js,
// which share one entry. connect returns { effect, input, output, nodes }; update applies changed settings live.
// Functions from the later scripts are called through arrows, so this table can be built before they load.
const EFFECT_KINDS = {
  equalizer: {
    label: () => tr('Equalizer'), dialog: 'eq-dialog', settings: e => e.eq, valid: e => !!e.eq && validEQ(e.eq),
    create: () => ({ type: 'equalizer', eq: defaultEQ() }), copy: e => ({ type: e.type, eq: copyEQ(e.eq) }),
    connect: (audio, effect) => { const filters = createEQNodes(audio, effect.eq); setEQNodes(filters, effect.eq, audio); filters.reduce((a, b) => { a.connect(b); return b; }); return { effect, input: filters[0], output: filters.at(-1), filters, nodes: filters }; },
    update: entry => setEQNodes(entry.filters, entry.effect.eq, context), open: (effect, index) => openEqualizer(effect, index),
  },
  compressor: {
    label: () => tr('Compressor'), dialog: 'compressor-dialog', settings: e => e.compressor, valid: e => validCompressor(e.compressor),
    create: () => ({ type: 'compressor', compressor: defaultCompressor() }), copy: e => ({ type: e.type, compressor: { ...e.compressor } }),
    connect: (audio, effect, analyse) => connectCompressor(audio, effect, analyse), update: entry => setCompressorNodes(entry), open: (effect, index) => openCompressor(effect, index),
  },
  utility: {
    label: e => UTILITY_EFFECTS[e.type].name, dialog: 'utility-dialog', settings: e => e.settings, valid: e => validUtilityEffect(e),
    create: type => defaultUtilityEffect(type), copy: e => ({ type: e.type, settings: { ...UTILITY_ADDED[e.type], ...e.settings } }),
    connect: (audio, effect, analyse) => connectUtilityEffect(audio, effect, analyse), update: entry => setUtilityNodes(entry), open: (effect, index) => openUtilityEffect(effect, index),
  },
};
const effectKind = type => type === 'equalizer' || type === 'compressor' ? EFFECT_KINDS[type] : EFFECT_KINDS.utility;
const validEffects = effects => Array.isArray(effects) && effects.length <= 32 && effects.every(e => e && effectKind(e.type).valid(e));
const trackEffects = track => Array.isArray(track.effects) ? track.effects : track.eq ? [{ type: 'equalizer', eq: track.eq }] : [];
const copyEffects = track => trackEffects(track).map(e => effectKind(e.type).copy(e));
const effectLabel = effect => effectKind(effect.type).label(effect);
const effectSettings = effect => effectKind(effect.type).settings(effect);
const effectTitle = (effect, index) => `${index + 1}. ${effectLabel(effect)} · ${eqTrack.name}`;
// Bypassed editors dim their controls; the unchecked Enable box is the non-color cue.
const markBypass = (dialog, effect) => $(dialog).classList.toggle('bypassed', !effectSettings(effect).enabled);
function updateFxButton(track, button = document.querySelector(`.track-fx[data-track="${track.id}"]`)) {
  if (!button) return;
  const count = trackEffects(track).length; button.classList.toggle('has-fx', count > 0); button.replaceChildren('fx');
  if (count) { const badge = document.createElement('span'); badge.className = 'fx-count'; badge.textContent = count; button.append(badge); }
}
function defaultEQ() {
  return { enabled: true, bands: [80, 16000, 125, 500, 2000, 8000].map((freq, i) => ({ type: i === 0 ? 'highpass' : i === 1 ? 'lowpass' : 'peaking', enabled: i > 1, freq, gain: 0, q: i < 2 ? .707 : 1, ...(i < 2 && { slope: 12 }) })) };
}
// Each cut always gets four stages so a slope change never rebuilds the graph; unused stages are unity peaking filters.
const createEQNodes = (audio, eq) => eq.bands.flatMap(b => Array.from({ length: b.type === 'peaking' ? 1 : 4 }, () => audio.createBiquadFilter()));
function setEQNodes(nodes, eq, audio) {
  let n = 0;
  for (const b of eq.bands) {
    const on = eq.enabled && b.enabled, freq = Math.min(b.freq, audio.sampleRate / 2 * .999), qs = b.type === 'peaking' ? [b.q] : BUTTERWORTH_Q[b.slope ?? 12];
    for (let i = 0; i < (b.type === 'peaking' ? 1 : 4); i++) {
      const node = nodes[n++], active = on && i < qs.length; node.frequency.value = freq;
      if (b.type === 'peaking') { node.type = 'peaking'; node.Q.value = b.q; node.gain.value = on ? b.gain : 0; }
      else { node.type = active ? b.type : 'peaking'; node.Q.value = active ? 20 * Math.log10(qs[i]) : 1; node.gain.value = 0; }
    }
  }
}
function connectTrackEQ(audio, track, input, output, analyse = false) {
  const effects = [], filters = [], nodes = []; let tail = input;
  for (const effect of trackEffects(track)) {
    const entry = effectKind(effect.type).connect(audio, effect, analyse); tail.connect(entry.input); tail = entry.output;
    effects.push(entry); nodes.push(...entry.nodes); if (entry.filters) filters.push(...entry.filters);
  }
  const analyser = analyse ? audio.createAnalyser() : null;
  if (analyser) { analyser.fftSize = 16384; analyser.smoothingTimeConstant = .75; tail.connect(analyser); tail = analyser; nodes.push(analyser); }
  tail.connect(output); return { filters, effects, analyser, nodes };
}
function disposeEffectChain(chain) {
  if (!chain || chain.disposed) return; chain.disposed = true;
  for (const entry of chain.effects) entry.dispose?.();
  chain.nodes.forEach(node => node.disconnect());
}
let eqTrack = null, eqEffect = null, eqFrame = 0, eqPreview = null, fxDrag = null, finishKnob = null, eqHandles = [], eqDrag = null, eqHover = -1;
function eqGraphPoint(event) { const canvas = $('eq-graph'), r = canvas.getBoundingClientRect(); return { x: (event.clientX - r.left) * canvas.width / r.width, y: (event.clientY - r.top) * canvas.height / r.height }; }
// Nearest handle within reach; later bands win ties so the parametric points sit above the cuts.
function eqHandleAt(point) { let best = null, distance = 18; for (const h of eqHandles) { const d = Math.hypot(h.x - point.x, h.y - point.y); if (d <= distance) { best = h; distance = d; } } return best; }
function updateLiveEQ() {
  const chains = new Set(playingSources.filter(s => s.track === eqTrack).map(s => s.eqChain));
  for (const chain of chains) for (const entry of chain?.effects || []) effectKind(entry.effect.type).update(entry);
}
function openTrackEQ(track) {
  eqTrack = track;
  if (!Array.isArray(track.effects)) { track.effects = copyEffects(track); delete track.eq; }
  $('fx-title').textContent = tr('Effects: {track}', { track: track.name }); $('fx-add').value = ''; renderEffectsList();
}
function changeEQ(action) {
  if (!eqTrack || !tracks.includes(eqTrack)) return;
  remember(tr('change effects')); action(); updateLiveEQ(); saveProject();
}
function reorderEffects(from, to) {
  if (!eqTrack || from === to || to < 0 || to >= eqTrack.effects.length) return;
  changeEQ(() => { const [effect] = eqTrack.effects.splice(from, 1); eqTrack.effects.splice(to, 0, effect); });
  syncPlayback(); renderEffectsList();
  $('fx-list').children[to]?.querySelector('.fx-name').focus();
  $('fx-announcement').textContent = tr('Effect moved to position {n}', { n: to + 1 });
}
function renderEffectsList() {
  const effects = eqTrack.effects; $('fx-list').replaceChildren(); $('fx-empty').hidden = effects.length > 0; updateFxButton(eqTrack);
  $('fx-add').disabled = effects.length >= 32;
  effects.forEach((effect, i) => {
    const label = effectLabel(effect), on = effectSettings(effect).enabled;
    const row = document.createElement('li'); row.className = 'fx-item'; row.classList.toggle('off', !on); row.draggable = true; row.dataset.index = i;
    const order = document.createElement('span'); order.className = 'fx-order'; order.textContent = i + 1; order.setAttribute('aria-hidden', 'true');
    const name = document.createElement('button'); name.type = 'button'; name.className = 'fx-name'; name.textContent = label;
    if (!on) { const off = document.createElement('span'); off.className = 'fx-off'; off.textContent = tr('Off'); name.append(off); }
    name.setAttribute('aria-haspopup', 'dialog'); name.setAttribute('aria-controls', effectKind(effect.type).dialog);
    name.title = tr('Open {effect} · Alt+Arrow Up/Down to reorder', { effect: label }); name.onclick = () => effectKind(effect.type).open(effect, i);
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'fx-grip ghost'; handle.textContent = '⠿';
    handle.setAttribute('aria-label', tr('Reorder {effect}', { effect: `${i + 1}. ${label}` })); handle.title = tr('Drag to reorder · Alt+Arrow Up/Down');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'fx-toggle ghost'; setIconButton(toggle, 'power', '', tr('Enable {effect}', { effect: label })); toggle.setAttribute('aria-pressed', String(on));
    toggle.onclick = () => { changeEQ(() => { effectSettings(effect).enabled = !on; }); renderEffectsList(); $('fx-list').children[i]?.querySelector('.fx-toggle').focus(); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'fx-remove ghost'; setIconButton(remove, 'trash', '', tr('Remove {effect}', { effect: label }));
    remove.onclick = () => { changeEQ(() => effects.splice(i, 1)); syncPlayback(); renderEffectsList(); status(tr('{effect} removed. Ctrl+Z to undo.', { effect: label })); ($('fx-list').children[Math.min(i, effects.length - 1)]?.querySelector('.fx-name') || $('eq-add')).focus(); };
    row.onkeydown = event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); reorderEffects(i, i + (event.key === 'ArrowUp' ? -1 : 1)); } };
    row.ondragstart = event => { fxDrag = i; event.dataTransfer.setData('text/plain', String(i)); event.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); };
    row.ondragover = event => { if (fxDrag === null) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.add('drop-target'); };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = event => { if (fxDrag === null) return; event.preventDefault(); const from = fxDrag; fxDrag = null; reorderEffects(from, i); };
    row.ondragend = () => { fxDrag = null; for (const item of $('fx-list').children) item.classList.remove('dragging', 'drop-target'); };
    // Pointer capture gives the sort handle touch/pen support as well as mouse dragging.
    handle.onpointerdown = event => {
      if (event.button !== 0) return; event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
      let target = i; row.classList.add('dragging');
      const move = e => { const item = document.elementFromPoint(e.clientX, e.clientY)?.closest('#fx-list .fx-item'); if (item) { target = +item.dataset.index; for (const r of $('fx-list').children) r.classList.toggle('drop-target', r === item); } };
      const end = e => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); for (const r of $('fx-list').children) r.classList.remove('dragging', 'drop-target'); if (e.type === 'pointerup') reorderEffects(i, target); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    };
    row.append(handle, order, name, toggle, remove); $('fx-list').append(row);
  });
}
function addEffect(type) {
  if (!eqTrack || eqTrack.effects.length >= 32) return;
  changeEQ(() => eqTrack.effects.push(effectKind(type).create(type)));
  syncPlayback(); renderEffectsList();
}
// Changing a parametric band's gain away from 0 switches the band on, in the same undo step.
function enableBandOnGain(band) {
  if (band.type !== 'peaking' || band.enabled || !band.gain) return;
  band.enabled = true; const box = document.querySelector(`.eq-band-${eqEffect.eq.bands.indexOf(band)} .eq-band-toggle input`); if (box) box.checked = true;
}
// The effect editors share their Enable box, Remove button and close handling; current() is the effect being edited and
// closed() resets the editor's own state.
const EFFECT_DIALOGS = ['eq-dialog', 'compressor-dialog', 'utility-dialog'];
const closeEffectDialogs = () => { for (const id of EFFECT_DIALOGS) if ($(id).open) $(id).close(); };
function wireEffectDialog(name, current, closed) {
  const dialog = `${name}-dialog`, enabled = $(`${name}-enabled`);
  enabled.onchange = () => { changeEQ(() => { effectSettings(current()).enabled = enabled.checked; }); markBypass(dialog, current()); };
  $(`${name}-remove`).onclick = () => { changeEQ(() => eqTrack.effects.splice(eqTrack.effects.indexOf(current()), 1)); syncPlayback(); $(dialog).close(); renderEffectsList(); };
  $(dialog).addEventListener('close', () => { finishKnob?.(); closed(); if (eqTrack) renderEffectsList(); });
}
function openEqualizer(effect, index) {
  eqEffect = effect; $('eq-title').textContent = effectTitle(effect, index);
  renderEQEditor(); markBypass('eq-dialog', effect); $('eq-dialog').showModal(); cancelAnimationFrame(eqFrame); drawEQ();
}
function createEQKnob(band, key, text, min, max, step, bandName, options = {}) {
  const group = document.createElement('div'); group.className = `eq-knob-control eq-knob-${key}`;
  const label = document.createElement('span'); label.className = 'eq-knob-label'; label.textContent = text;
  const knob = document.createElement('div'); knob.className = 'eq-knob'; knob.tabIndex = 0; knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', `${bandName}: ${text}`); knob.setAttribute('aria-valuemin', min); knob.setAttribute('aria-valuemax', max);
  knob.title = tr('Drag vertically · Arrow keys · Shift: fine · Double-click: reset');
  const arc = document.createElement('span'), indicator = document.createElement('span'); arc.className = 'eq-knob-arc'; indicator.className = 'eq-knob-indicator'; knob.append(arc, indicator);
  const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.setAttribute('aria-label', `${bandName}: ${text} value`);
  const logarithmic = options.logarithmic ?? (key === 'freq' || key === 'q'), normalize = v => logarithmic ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
  const denormalize = t => logarithmic ? min * (max / min) ** t : min + t * (max - min);
  const origin = min < 0 && max > 0 ? normalize(0) : 0;
  const refresh = () => { const value = band[key], t = normalize(value); input.value = value; knob.style.setProperty('--knob-angle', `${-135 + t * 270}deg`); knob.style.setProperty('--arc-a', `${Math.min(t, origin) * 270}deg`); knob.style.setProperty('--arc-b', `${Math.max(t, origin) * 270}deg`); knob.setAttribute('aria-valuenow', value); knob.setAttribute('aria-valuetext', `${value} ${options.unit ?? (key === 'freq' ? 'Hz' : key === 'gain' ? 'dB' : '')}`); };
  const set = value => { band[key] = +Math.max(min, Math.min(max, Math.round(value / step) * step)).toFixed(options.decimals ?? (key === 'freq' ? 0 : key === 'q' ? 3 : 2)); options.onSet?.(); refresh(); updateLiveEQ(); };
  // onCommit runs once a change is complete (end of drag, key, typed value, reset), for settings that rebuild playback.
  const commit = () => options.onCommit?.();
  input.onchange = () => { const value = Number(input.value); if (!input.value || !Number.isFinite(value) || value < min || value > max) { refresh(); return; } changeEQ(() => set(value)); commit(); };
  knob.onpointerdown = event => {
    if (event.button !== 0 || !eqTrack) return; event.preventDefault(); knob.focus(); knob.setPointerCapture(event.pointerId);
    const startY = event.clientY, initial = normalize(band[key]); let remembered = false;
    const move = e => { const t = Math.max(0, Math.min(1, initial + (startY - e.clientY) / (e.shiftKey ? 1600 : 220))); if (!remembered && t !== initial) { remember(tr('change effect')); remembered = true; } set(denormalize(t)); };
    const end = () => { knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', end); knob.removeEventListener('pointercancel', end); knob.removeEventListener('lostpointercapture', end); finishKnob = null; if (remembered) { saveProject(); commit(); } };
    finishKnob?.(); finishKnob = end;
    knob.addEventListener('pointermove', move); knob.addEventListener('pointerup', end); knob.addEventListener('pointercancel', end); knob.addEventListener('lostpointercapture', end);
  };
  knob.onkeydown = event => {
    const delta = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[event.key];
    if (delta === undefined && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault(); changeEQ(() => set(event.key === 'Home' ? min : event.key === 'End' ? max : denormalize(Math.max(0, Math.min(1, normalize(band[key]) + delta * (event.shiftKey ? .001 : .01)))))); commit();
  };
  knob.ondblclick = () => { changeEQ(() => set(options.reset ?? (key === 'gain' ? 0 : key === 'q' ? (band.type === 'peaking' ? 1 : .707) : defaultEQ().bands[eqEffect.eq.bands.indexOf(band)].freq))); commit(); };
  refresh(); group.refresh = refresh; group.append(label, knob, input); return group;
}
function renderEQEditor() {
  const eq = eqEffect.eq; $('eq-controls').replaceChildren(); $('eq-enabled').checked = eq.enabled;
  eqPreview?.forEach(n => n.disconnect()); eqPreview = createEQNodes(getContext(), eq);
  // Keep the cut filters at the outer edges of the second row, like a hardware EQ.
  for (const i of [2, 3, 4, 5, 0, 1]) {
    const band = eq.bands[i], row = document.createElement('fieldset'), legend = document.createElement('legend');
    const bandName = i === 0 ? tr('Low cut') : i === 1 ? tr('High cut') : tr('Parametric {n}', { n: i - 1 });
    row.className = `eq-band eq-band-${i}`; legend.textContent = bandName; row.append(legend);
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'eq-band-toggle';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = band.enabled; toggle.setAttribute('aria-label', `${bandName}: enabled`);
    toggleLabel.append(toggle, document.createTextNode(tr('Enabled'))); row.append(toggleLabel);
    toggle.onchange = () => changeEQ(() => { band.enabled = toggle.checked; });
    const knobs = document.createElement('div'); knobs.className = 'eq-knobs';
    for (const [key, text, min, max, step] of [['freq', tr('Freq (Hz)'), 20, 20000, 1], ['gain', tr('Gain (dB)'), -24, 24, .1], ['q', 'Q', .1, 20, .001]]) {
      if (i < 2 && key !== 'freq') continue;
      knobs.append(createEQKnob(band, key, text, min, max, step, bandName, key === 'gain' ? { onSet: () => enableBandOnGain(band) } : {}));
    }
    if (i < 2) {
      const slope = document.createElement('div'), caption = document.createElement('span'), options = document.createElement('div');
      slope.className = 'eq-knob-control eq-slope'; slope.setAttribute('role', 'radiogroup'); slope.setAttribute('aria-label', `${bandName}: ${tr('Slope (dB/oct)')}`);
      caption.className = 'eq-knob-label'; caption.textContent = tr('Slope (dB/oct)'); options.className = 'eq-slope-options';
      for (const value of CUT_SLOPES) {
        const option = document.createElement('label'), radio = document.createElement('input'), text = document.createElement('span');
        radio.type = 'radio'; radio.name = `eq-slope-${i}`; radio.value = value; radio.checked = band.slope === value; text.textContent = value;
        radio.onchange = () => changeEQ(() => { band.slope = value; }); option.append(radio, text); options.append(option);
      }
      slope.append(caption, options); knobs.append(slope);
    }
    row.append(knobs); $('eq-controls').append(row);
  }
}
function drawEQ() {
  if (!eqEffect || !$('eq-dialog').open) return;
  const canvas = $('eq-graph'), g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const css = getComputedStyle(document.documentElement), color = token => css.getPropertyValue(token).trim();
  g.clearRect(0, 0, w, h);
  const left = 45, right = w - 45, top = 18, bottom = h - 32, x = f => left + Math.log(f / 20) / Math.log(1000) * (right - left);
  g.font = '12px sans-serif'; g.lineWidth = 1;
  for (let db = -24; db <= 24; db += 12) { const y = top + (24 - db) / 48 * (bottom - top); g.strokeStyle = color('--line'); g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke(); g.fillStyle = color('--muted'); g.fillText(`${db}`, 5, y + 4); g.fillText(`${-45 + db * 45 / 24}`, right + 6, y + 4); }
  const chains = new Set(playingSources.filter(s => s.track === eqTrack && s.eqChain?.analyser).map(s => s.eqChain)), powers = new Float64Array(30);
  for (const chain of chains) {
    const a = chain.analyser, data = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(data);
    for (let b = 0; b < 30; b++) {
      const lo = 20 * 2 ** (b / 3), hi = Math.min(20000, 20 * 2 ** ((b + 1) / 3)), first = Math.max(1, Math.ceil(lo * a.fftSize / context.sampleRate)), last = Math.min(data.length, Math.ceil(hi * a.fftSize / context.sampleRate));
      for (let k = first; k < last; k++) powers[b] += Number.isFinite(data[k]) ? 10 ** (data[k] / 10) : 0;
    }
  }
  g.fillStyle = color('--accent'); g.globalAlpha = .4;
  for (let b = 0; b < 30; b++) { const lo = 20 * 2 ** (b / 3), hi = Math.min(20000, 20 * 2 ** ((b + 1) / 3)), db = powers[b] > 0 ? 10 * Math.log10(powers[b]) : -90, bar = Math.max(0, Math.min(1, (db + 90) / 90)) * (bottom - top); g.fillRect(x(lo) + 1, bottom - bar, x(hi) - x(lo) - 2, bar); }
  g.globalAlpha = 1;
  g.fillStyle = color('--muted'); for (const f of [20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20000]) g.fillText(f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : `${f}`, x(f) - 10, h - 10);
  if (eqPreview) {
    setEQNodes(eqPreview, eqEffect.eq, getContext());
    const frequencies = Float32Array.from({ length: 512 }, (_, i) => Math.min(20 * 1000 ** (i / 511), getContext().sampleRate / 2 * .999)), response = new Float32Array(512), phase = new Float32Array(512), sum = new Float32Array(512);
    for (const filter of eqPreview) { filter.getFrequencyResponse(frequencies, response, phase); response.forEach((v, i) => { if (Number.isFinite(v)) sum[i] += 20 * Math.log10(Math.max(v, 1e-12)); }); }
    g.strokeStyle = color('--accent-2'); g.lineWidth = 2; g.beginPath(); sum.forEach((db, i) => { const y = top + (24 - Math.max(-24, Math.min(24, db))) / 48 * (bottom - top), px = left + i / 511 * (right - left); if (i) g.lineTo(px, y); else g.moveTo(px, y); }); g.stroke();
  }
  // Numbered handles: drag horizontally for frequency, vertically for gain (cuts move in frequency only).
  eqHandles = eqEffect.eq.bands.map((b, i) => ({ band: b, i, x: x(b.freq), y: top + (24 - (b.type === 'peaking' ? b.gain : 0)) / 48 * (bottom - top) }));
  g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const handle of eqHandles) {
    const active = handle === eqDrag?.handle || handle.i === eqHover, on = eqEffect.eq.enabled && handle.band.enabled;
    g.beginPath(); g.arc(handle.x, handle.y, 10, 0, Math.PI * 2); g.fillStyle = active ? color('--accent') : color('--surface-solid'); g.fill();
    g.lineWidth = 2; g.setLineDash(on ? [] : [3, 3]); g.strokeStyle = on ? color('--accent') : color('--muted'); g.stroke(); g.setLineDash([]);
    g.fillStyle = active ? color('--on-accent') : on ? color('--text') : color('--muted'); g.fillText(handle.i === 0 ? 'L' : handle.i === 1 ? 'H' : handle.i - 1, handle.x, handle.y + 1);
  }
  g.textAlign = 'start'; g.textBaseline = 'alphabetic';
  eqFrame = requestAnimationFrame(drawEQ);
}
window.addEventListener('DOMContentLoaded', () => {
  // Effect names sorted in the interface language; the first option stays the "Add effect" prompt.
  const [prompt, ...choices] = $('fx-add').options; choices.sort((a, b) => a.text.localeCompare(b.text, I18N.language)); $('fx-add').replaceChildren(prompt, ...choices);
  $('fx-add').onchange = () => { const type = $('fx-add').value; $('fx-add').value = ''; if (type) addEffect(type); };
  $('eq-graph').onpointermove = event => { if (eqDrag) return; const handle = eqHandleAt(eqGraphPoint(event)); eqHover = handle ? handle.i : -1; $('eq-graph').style.cursor = handle ? 'grab' : ''; };
  $('eq-graph').onpointerleave = () => { eqHover = -1; };
  $('eq-graph').onpointerdown = event => {
    const canvas = $('eq-graph'), handle = event.button === 0 && eqHandleAt(eqGraphPoint(event)); if (!handle) return;
    event.preventDefault(); finishKnob?.(); canvas.setPointerCapture(event.pointerId); canvas.style.cursor = 'grabbing'; eqDrag = { handle, remembered: false };
    const left = 45, right = canvas.width - 45, top = 18, bottom = canvas.height - 32, band = handle.band;
    const move = e => {
      const p = eqGraphPoint(e), freq = Math.round(Math.max(20, Math.min(20000, 20 * 1000 ** ((p.x - left) / (right - left))))), gain = Math.round(Math.max(-24, Math.min(24, 24 - (p.y - top) / (bottom - top) * 48)) * 10) / 10;
      if (freq === band.freq && (band.type !== 'peaking' || gain === band.gain)) return;
      if (!eqDrag.remembered) { remember(tr('change effect')); eqDrag.remembered = true; }
      band.freq = freq; if (band.type === 'peaking') { band.gain = gain; enableBandOnGain(band); } updateLiveEQ();
      for (const group of $('eq-controls').querySelectorAll('.eq-knob-control')) group.refresh?.();
    };
    const end = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', end); canvas.removeEventListener('pointercancel', end); canvas.style.cursor = ''; if (eqDrag?.remembered) saveProject(); eqDrag = null; };
    canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  };
  wireEffectDialog('eq', () => eqEffect, () => { cancelAnimationFrame(eqFrame); eqPreview?.forEach(n => n.disconnect()); eqPreview = null; eqEffect = null; });
  $('fx-dialog').addEventListener('close', () => { closeEffectDialogs(); eqTrack = null; });
  for (const dialog of document.querySelectorAll('dialog')) {
    const outside = e => { const r = dialog.getBoundingClientRect(); return e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
    let beganOutside = false;
    dialog.addEventListener('pointerdown', e => { beganOutside = outside(e); });
    dialog.addEventListener('click', e => { if (beganOutside && outside(e)) dialog.close('cancel'); beganOutside = false; });
  }
});
