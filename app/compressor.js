// DynamicsCompressorNode provides the same DSP in playback and offline exports.
const COMPRESSOR_PARAMS = [
  ['ratio', tr('Ratio'), 1, 20, .1, false, ':1'],
  ['threshold', tr('Threshold (dB)'), -100, 0, .1, false, 'dB'],
  ['knee', tr('Knee (dB)'), 0, 40, .1, false, 'dB'],
  ['inputGain', tr('Input gain (dB)'), -24, 24, .1, false, 'dB'],
  ['gain', tr('Gain (dB)'), -24, 24, .1, false, 'dB'],
  ['mix', tr('Mix (%)'), 0, 100, 1, false, '%'],
  ['attack', tr('Attack (ms)'), .1, 1000, .1, true, 'ms'],
  ['release', tr('Release (ms)'), 1, 3000, .1, true, 'ms'],
];
function defaultCompressor() { return { enabled: true, ratio: 2, threshold: -15, knee: 6, inputGain: 0, gain: 0, mix: 100, attack: 15, release: 120 }; }
function validCompressor(c) {
  return !!c && typeof c.enabled === 'boolean' && COMPRESSOR_PARAMS.every(([key, , min, max]) => Number.isFinite(c[key]) && c[key] >= min && c[key] <= max);
}
function setCompressorNodes(entry) {
  const c = entry.effect.compressor, toGain = db => 10 ** (db / 20);
  entry.compressor.threshold.value = c.threshold; entry.compressor.ratio.value = c.ratio; entry.compressor.knee.value = c.knee;
  entry.compressor.attack.value = c.attack / 1000; entry.compressor.release.value = c.release / 1000;
  entry.input.gain.value = c.enabled ? toGain(c.inputGain) : 1;
  entry.makeup.gain.value = toGain(c.gain);
  entry.wet.gain.value = c.enabled ? c.mix / 100 : 0; entry.dry.gain.value = c.enabled ? 1 - c.mix / 100 : 1;
  // Native compression has a fixed 6 ms lookahead. Align the parallel dry path.
  entry.delay.delayTime.value = c.enabled ? .006 : 0;
}
function connectCompressor(audio, effect, analyse = false) {
  const input = audio.createGain(), compressor = audio.createDynamicsCompressor(), makeup = audio.createGain();
  const wet = audio.createGain(), dry = audio.createGain(), delay = audio.createDelay(.01), sum = audio.createGain();
  const nodes = [input, compressor, makeup, wet, dry, delay, sum];
  let split = input, output = sum, inputMeter = null, outputMeter = null;
  if (analyse) {
    inputMeter = audio.createAnalyser(); outputMeter = audio.createAnalyser(); inputMeter.fftSize = outputMeter.fftSize = 1024;
    input.connect(inputMeter); split = inputMeter; sum.connect(outputMeter); output = outputMeter; nodes.push(inputMeter, outputMeter);
  }
  split.connect(compressor); compressor.connect(makeup); makeup.connect(wet); wet.connect(sum);
  split.connect(delay); delay.connect(dry); dry.connect(sum);
  const entry = { effect, input, output, compressor, makeup, wet, dry, delay, inputMeter, outputMeter, nodes };
  setCompressorNodes(entry); return entry;
}
function compressorCurve(db, c) {
  const input = db + c.inputGain, delta = input - c.threshold, slope = 1 / c.ratio - 1;
  let output = input;
  if (c.knee > 0 && Math.abs(delta) <= c.knee / 2) output += slope * (delta + c.knee / 2) ** 2 / (2 * c.knee);
  else if (delta > c.knee / 2) output += slope * delta;
  const wet = 10 ** ((output + c.gain) / 20), dry = 10 ** (input / 20), mix = c.mix / 100;
  return c.enabled ? 20 * Math.log10(Math.max(1e-12, wet * mix + dry * (1 - mix))) : db;
}
let compressorEffect = null, compressorFrame = 0;
function openCompressor(effect, index) {
  compressorEffect = effect; $('compressor-title').textContent = effectTitle(effect, index); markBypass('compressor-dialog', effect);
  $('compressor-enabled').checked = effect.compressor.enabled;
  $('compressor-dynamics').replaceChildren(); $('compressor-controls').replaceChildren();
  const defaults = defaultCompressor();
  for (const [key, label, min, max, step, logarithmic, unit] of COMPRESSOR_PARAMS) {
    const knob = createEQKnob(effect.compressor, key, label, min, max, step, tr('Compressor'), { reset: defaults[key], logarithmic, unit, decimals: key === 'mix' ? 0 : 1 });
    $(['ratio', 'threshold', 'knee'].includes(key) ? 'compressor-dynamics' : 'compressor-controls').append(knob);
  }
  $('compressor-dialog').showModal(); cancelAnimationFrame(compressorFrame); drawCompressor();
}
function drawCompressor() {
  if (!compressorEffect || !$('compressor-dialog').open) return;
  const c = compressorEffect.compressor, canvas = $('compressor-graph'), g = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement), color = token => css.getPropertyValue(token).trim();
  const left = 38, right = canvas.width - 15, top = 15, bottom = canvas.height - 30;
  const x = db => left + (db + 60) / 60 * (right - left), y = db => bottom - (Math.max(-60, Math.min(0, db)) + 60) / 60 * (bottom - top);
  g.clearRect(0, 0, canvas.width, canvas.height); g.font = '11px sans-serif'; g.lineWidth = 1;
  for (let db = -60; db <= 0; db += 12) {
    g.strokeStyle = color('--line'); g.beginPath(); g.moveTo(x(db), top); g.lineTo(x(db), bottom); g.moveTo(left, y(db)); g.lineTo(right, y(db)); g.stroke();
    g.fillStyle = color('--muted'); g.fillText(`${db}`, x(db) - 8, bottom + 18); g.fillText(`${db}`, 4, y(db) + 4);
  }
  g.setLineDash([3, 4]); g.strokeStyle = color('--muted'); g.beginPath(); g.moveTo(left, bottom); g.lineTo(right, top); g.stroke(); g.setLineDash([]);
  g.strokeStyle = color('--accent-2'); g.lineWidth = 2; g.beginPath();
  for (let i = 0; i <= 300; i++) { const db = -60 + i / 5; if (i) g.lineTo(x(db), y(compressorCurve(db, c))); else g.moveTo(x(db), y(compressorCurve(db, c))); } g.stroke();
  const entries = new Set();
  for (const source of playingSources) if (source.track === eqTrack) for (const entry of source.eqChain?.effects || []) if (entry.effect === compressorEffect) entries.add(entry);
  let inputPeak = 0, outputPeak = 0, reduction = 0;
  const peak = analyser => { if (!analyser) return 0; const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); let value = 0; for (const sample of data) value = Math.max(value, Math.abs(sample)); return value; };
  for (const entry of entries) { inputPeak = Math.max(inputPeak, peak(entry.inputMeter)); outputPeak = Math.max(outputPeak, peak(entry.outputMeter)); if (c.enabled) reduction = Math.max(reduction, -entry.compressor.reduction); }
  for (const [name, value] of [['input', inputPeak], ['output', outputPeak]]) {
    const db = value > 0 ? 20 * Math.log10(value) : -Infinity;
    $(`compressor-${name}-meter`).value = Math.max(0, Math.min(60, db + 60)); $(`compressor-${name}-value`).textContent = Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : '−∞ dBFS';
  }
  $('compressor-reduction-meter').value = Math.min(36, reduction); $('compressor-reduction-value').textContent = `${reduction.toFixed(1)} dB`;
  if (inputPeak > 0) { const db = Math.max(-60, Math.min(0, 20 * Math.log10(inputPeak))) - (c.enabled ? c.inputGain : 0); g.fillStyle = color('--accent'); g.beginPath(); g.arc(x(Math.max(-60, Math.min(0, db))), y(compressorCurve(db, c)), 4, 0, Math.PI * 2); g.fill(); }
  compressorFrame = requestAnimationFrame(drawCompressor);
}
window.addEventListener('DOMContentLoaded', () => {
  wireEffectDialog('compressor', () => compressorEffect, () => { cancelAnimationFrame(compressorFrame); compressorEffect = null; });
});
