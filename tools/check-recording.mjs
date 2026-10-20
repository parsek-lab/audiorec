// Capture worker checks with synthetic AudioData frames; no browser, microphone or dependencies. node tools/check-recording.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const app = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
const source = vm.runInNewContext(app.match(/const CAPTURE_WORKER_SOURCE = (`[\s\S]*?`);/)[1]);
// Minimal AudioData: f32-planar or interleaved s16, timestamps in microseconds.
function frame(timestamp, values, { rate = 48000, format = 'f32-planar', channels = 1 } = {}) {
  const n = values.length / channels, interleaved = !format.endsWith('-planar'), Type = format.startsWith('s16') ? Int16Array : Float32Array, scale = Type === Int16Array ? 32768 : 1;
  return { timestamp, sampleRate: rate, numberOfFrames: n, numberOfChannels: channels, format, closed: false, close() { this.closed = true; },
    allocationSize: ({ planeIndex }) => (interleaved ? values.length : n) * Type.BYTES_PER_ELEMENT,
    copyTo(dest, { planeIndex }) { for (let i = 0; i < dest.length; i++) { const v = interleaved ? values[i] : values[planeIndex * n + i]; dest[i] = Type === Int16Array ? Math.round(v * scale) : v; } } };
}
async function run(frames) {
  const messages = [], queue = [...frames], scope = { postMessage: message => messages.push(message), onmessage: null };
  vm.runInNewContext(source, scope);
  const readable = { getReader: () => ({ read: async () => queue.length ? { done: false, value: queue.shift() } : { done: true }, cancel: async () => {} }) };
  scope.onmessage({ data: { readable } }); await new Promise(r => setTimeout(r, 20));
  assert(frames.every(f => f.closed), 'every frame is closed');
  return { messages, samples: messages.flatMap(m => m.chunks.flatMap(c => [...c])) };
}
const tone = (start, n) => Array.from({ length: n }, (_, i) => Math.sin((start + i) / 7));
const at = (index, n = 480, rate = 48000) => index * n / rate * 1e6;
// Continuous frames with timestamp jitter under half a frame: no gaps, samples unchanged.
{ const { messages, samples } = await run([0, 1, 2, 3].map(i => frame(at(i) + [0, 2000, -1500, 900][i], tone(i * 480, 480))));
  assert.equal(samples.length, 1920); assert(messages.every(m => m.gap === 0 && m.rate === 48000)); assert(samples.every((v, i) => Math.abs(v - Math.sin(i / 7)) < 1e-6)); }
// Two frames lost: exactly 960 zeros inserted where they were, timing kept.
{ const { messages, samples } = await run([frame(at(0), tone(0, 480)), frame(at(1), tone(480, 480)), frame(at(4), tone(1920, 480))]);
  assert.equal(messages[2].gap, 960); assert.equal(samples.length, 2400); assert(samples.slice(960, 1920).every(v => v === 0)); assert(Math.abs(samples[1920] - Math.sin(1920 / 7)) < 1e-6); }
// Stereo interleaved 16-bit at 44.1 kHz: averaged to mono, rate passed on.
{ const values = []; for (let i = 0; i < 441; i++) values.push(.5, -.25);
  const { messages, samples } = await run([frame(0, values, { rate: 44100, format: 's16', channels: 2 })]);
  assert.equal(messages[0].rate, 44100); assert.equal(samples.length, 441); assert(samples.every(v => Math.abs(v - .125) < 1e-4)); }
// Main thread: the ScriptProcessor is gone and capture falls back to an AudioWorklet.
assert(!/createScriptProcessor/.test(app)); assert(/new MediaStreamTrackProcessor\(/.test(app)); assert(/'audiorec-recorder-v1'/.test(app));
console.log('PASS recording capture: jitter tolerance, lost frames filled with exact silence, stereo/16-bit/44.1 kHz frames, frames closed, no ScriptProcessor.');
