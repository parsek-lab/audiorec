// Settings and expander processor tests with no browser or dependencies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const root = new URL('../app/', import.meta.url), scope = { window: { addEventListener() {} }, tr: text => text };
vm.createContext(scope);
vm.runInContext(readFileSync(new URL('eq.js', root), 'utf8') + '\n' + readFileSync(new URL('compressor.js', root), 'utf8') + '\n' + readFileSync(new URL('effects.js', root), 'utf8') + '\nthis.api={UTILITY_EFFECTS,defaultUtilityEffect,validUtilityEffect,validEffects,copyEffects,EXPANDER_PROCESSOR_SOURCE,PITCH_PROCESSOR_SOURCE,disposeEffectChain,pitchCenter,trackLatency};', scope);
const { UTILITY_EFFECTS, defaultUtilityEffect, validUtilityEffect, validEffects, copyEffects, EXPANDER_PROCESSOR_SOURCE, PITCH_PROCESSOR_SOURCE, disposeEffectChain, pitchCenter, trackLatency } = scope.api;
const effects = Object.keys(UTILITY_EFFECTS).map(defaultUtilityEffect);
assert(validEffects(effects)); assert(!validUtilityEffect(null)); assert(!validUtilityEffect({ type: '__proto__' }));
for (const effect of effects) {
  assert(validUtilityEffect(effect));
  for (const [key, , min, max] of UTILITY_EFFECTS[effect.type].params) {
    for (const value of [NaN, Infinity, min - 1, max + 1]) assert(!validUtilityEffect({ ...effect, settings: { ...effect.settings, [key]: value } }), `${effect.type}.${key}`);
    for (const value of [min, max]) assert(validUtilityEffect({ ...effect, settings: { ...effect.settings, [key]: value } }));
  }
}
for (const preset of ['hall', 'room', 'plate']) assert(validUtilityEffect({ type: 'reverb', settings: { ...defaultUtilityEffect('reverb').settings, preset } }));
assert(!validUtilityEffect({ type: 'reverb', settings: { ...defaultUtilityEffect('reverb').settings, preset: '__proto__' } }));
const copy = copyEffects({ effects }); copy[0].settings.time = 500; assert.equal(effects[0].settings.time, 350); assert(validEffects(JSON.parse(JSON.stringify(effects))));
let disposed = 0, disconnected = 0; const chain = { effects: [{ dispose() { disposed++; } }], nodes: [{ disconnect() { disconnected++; } }] };
disposeEffectChain(chain); disposeEffectChain(chain); assert.equal(disposed, 1); assert.equal(disconnected, 1);
let Processor;
const worklet = { sampleRate: 48000, AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } }, registerProcessor(name, constructor) { assert.equal(name, 'audiorec-expander-v1'); Processor = constructor; } };
vm.runInNewContext(EXPANDER_PROCESSOR_SOURCE, worklet);
const params = Object.fromEntries(Processor.parameterDescriptors.map(d => [d.name, new Float32Array([d.defaultValue])]));
params.threshold[0] = -30; params.ratio[0] = 4; params.knee[0] = 0;
function process(amplitude, stereo = false, overrides = {}) {
  const processor = new Processor({ processorOptions: {} }), p = { ...params };
  for (const [key, value] of Object.entries(overrides)) p[key] = new Float32Array([value]);
  let power = 0, count = 0;
  for (let block = 0; block < 600; block++) {
    const input = [Float32Array.from({ length: 128 }, (_, i) => amplitude * Math.sin(2 * Math.PI * 440 * (block * 128 + i) / 48000))];
    if (stereo) input.unshift(Float32Array.from(input[0], v => v / amplitude * .8));
    const output = input.map(() => new Float32Array(128)); assert(processor.process([input], [output], p));
    if (block > 400) for (const sample of output.at(-1)) { assert(Number.isFinite(sample)); power += sample * sample; count++; }
  }
  return Math.sqrt(power / count);
}
assert(process(.001) < .001 / Math.sqrt(2) * .01, 'Quiet signals expand down');
assert(Math.abs(process(.8) / (.8 / Math.sqrt(2)) - 1) < .01, 'Loud signal stays unity');
assert(Math.abs(process(.001, false, { enabled: 0 }) / (.001 / Math.sqrt(2)) - 1) < .01, 'Bypass stays unity');
assert(Math.abs(process(.001, false, { range: 0 }) / (.001 / Math.sqrt(2)) - 1) < .01, 'Range zero stays unity');
assert(process(.001, true) > .0006, 'Stereo detector preserves quiet channel when other channel is loud');
assert.equal(process(0), 0, 'Silence stays finite and silent');
// Pitch shifter saved before version 11 has no window: it loads with the default.
{ const old = defaultUtilityEffect('pitch'); delete old.settings.window; assert(validUtilityEffect(old)); assert.equal(copyEffects({ effects: [old] })[0].settings.window, 60); }
let Pitch;
vm.runInNewContext(PITCH_PROCESSOR_SOURCE, { ...worklet, registerProcessor(name, constructor) { assert.equal(name, 'audiorec-pitch-v1'); Pitch = constructor; } });
// Runs a 220 Hz sine through the processor; returns the steady-state output after 0.5 s.
function shift(overrides = {}, stereo = false) {
  const processor = new Pitch({ processorOptions: { window: overrides.window ?? 60 } }), p = Object.fromEntries(Pitch.parameterDescriptors.map(d => [d.name, new Float32Array([overrides[d.name] ?? d.defaultValue])])), out = [];
  for (let block = 0; block < 750; block++) {
    const input = [Float32Array.from({ length: 128 }, (_, i) => .3 * Math.sin(2 * Math.PI * 220 * (block * 128 + i) / 48000))]; if (stereo) input.push(input[0].slice());
    const output = input.map(() => new Float32Array(128)); assert(processor.process([input], [output], p));
    if (block >= 188) { for (const s of output[0]) { assert(Number.isFinite(s)); out.push(s); } if (stereo) assert.deepEqual(output[0], output[1]); }
  }
  return out;
}
const crossings = x => { let n = 0, first = -1, last = -1; for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) { n++; if (first < 0) first = i; last = i; } return (n - 1) / ((last - first) / 48000); };
for (const [semitones, window] of [[12, 60], [-12, 60], [7, 20], [-5, 200], [24, 60], [-24, 60]]) { const f = crossings(shift({ semitones, window })), want = 220 * 2 ** (semitones / 12); assert(Math.abs(f / want - 1) < .005, `pitch ${semitones} st, ${window} ms: ${f} Hz`); }
// Zero semitones, bypass and the dry part of the mix are the input delayed by exactly the fixed latency.
const center = pitchCenter(60, 48000), delayed = i => .3 * Math.sin(2 * Math.PI * 220 * (188 * 128 + i - center) / 48000);
for (const overrides of [{}, { semitones: 7, enabled: 0 }, { semitones: 7, mix: 0 }]) { const x = shift(overrides); let error = 0; for (let i = 0; i < x.length; i++) error = Math.max(error, Math.abs(x[i] - delayed(i))); assert(error < 1e-6, `Delayed dry path ${JSON.stringify(overrides)}`); }
// Wet path: output onset of a burst lands within the swing (half a window plus the splice search) of the same latency.
function onset(overrides, window = 60) {
  const processor = new Pitch({ processorOptions: { window } }), p = Object.fromEntries(Pitch.parameterDescriptors.map(d => [d.name, new Float32Array([overrides[d.name] ?? d.defaultValue])]));
  for (let block = 0; block < 400; block++) {
    const input = [Float32Array.from({ length: 128 }, (_, i) => { const n = block * 128 + i - 24000; return n >= 0 ? .3 * Math.sin(2 * Math.PI * 220 * n / 48000) : 0; })], output = [new Float32Array(128)];
    processor.process([input], [output], p); for (let i = 0; i < 128; i++) if (Math.abs(output[0][i]) > .05) return block * 128 + i - 24000;
  }
}
for (const window of [20, 60, 200]) for (const semitones of [-12, 5, 12]) { const lag = onset({ semitones }, window), c = pitchCenter(window, 48000), swing = Math.round(window / 2 * 48) + Math.round(Math.min(15, window / 3) * 48) + 48; assert(Math.abs(lag - c) <= swing, `Wet onset ${semitones} st, ${window} ms: ${lag} vs ${c}`); }
assert.equal(trackLatency({ effects: [defaultUtilityEffect('delay'), defaultUtilityEffect('pitch'), { ...defaultUtilityEffect('pitch'), settings: { ...defaultUtilityEffect('pitch').settings, window: 200 } }] }, 48000), (pitchCenter(60, 48000) + pitchCenter(200, 48000)) / 48000);
assert.equal(trackLatency({ effects: [defaultUtilityEffect('delay')] }, 48000), 0);
{ const x = shift({ semitones: 12, enabled: 0 }); assert(Math.abs(crossings(x) - 220) < 1, 'Pitch bypass is dry'); }
shift({ semitones: 5 }, true);
console.log('PASS extra effects: defaults, ranges, presets, deep copies, disposal; expander threshold, bypass, range, stereo linking and silence; pitch ±24 st accuracy, windows 20–200 ms, transparency, bypass, linked stereo and pre-v11 migration.');
