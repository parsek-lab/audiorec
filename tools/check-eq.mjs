// Dependency-free EQ settings, routing and integration checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('app/eq.js', root), 'utf8');
const sandbox = { window: { addEventListener() {} }, tr: text => text };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('app/compressor.js', root), 'utf8') + '\n' + readFileSync(new URL('app/effects.js', root), 'utf8'), sandbox);
vm.runInContext(source + '\nthis.api = { defaultEQ, validEQ, copyEQ, validEffects, copyEffects, connectTrackEQ, setEQNodes };', sandbox);
const { defaultEQ, validEQ, copyEQ, validEffects, copyEffects, connectTrackEQ, setEQNodes } = sandbox.api;
const eq = defaultEQ();
assert(validEQ(eq)); assert(validEQ(null)); assert(!validEQ(undefined));
assert.equal(eq.bands.length, 6);
for (const bad of [NaN, Infinity, -1, 20001]) { const e = copyEQ(eq); e.bands[0].freq = bad; assert(!validEQ(e)); }
for (const key of ['q', 'gain']) { const e = copyEQ(eq); e.bands[2][key] = Infinity; assert(!validEQ(e)); }
const clone = copyEQ(eq); clone.bands[2].gain = 12; assert.equal(eq.bands[2].gain, 0);
assert(validEQ(JSON.parse(JSON.stringify(eq))));
const node = () => ({ frequency: {}, Q: {}, gain: {}, connections: [], connect(n) { this.connections.push(n); }, disconnect() {} });
const audio = { sampleRate: 32000, createBiquadFilter: node, createAnalyser: node };
const input = node(), output = node();
const chain = connectTrackEQ(audio, { eq }, input, output, true);
assert.equal(chain.filters.length, 12); assert.equal(chain.nodes.length, 13);
assert.equal(input.connections[0], chain.filters[0]);
assert.equal(chain.nodes.at(-1).connections[0], output);
assert.equal(chain.filters[0].type, 'peaking'); // Disabled cut is a unity filter.
eq.bands[0].enabled = true; eq.bands[1].enabled = true;
setEQNodes(chain.filters, eq, audio);
assert.equal(chain.filters[0].type, 'highpass'); assert.equal(chain.filters[1].type, 'peaking'); // 12 dB/oct uses one of the four stages.
assert(Math.abs(chain.filters[0].Q.value - 20 * Math.log10(.7071)) < 1e-9);
assert(chain.filters[4].frequency.value < audio.sampleRate / 2); assert.equal(chain.filters[4].type, 'lowpass');
eq.bands[0].slope = 48; eq.bands[0].q = 20; setEQNodes(chain.filters, eq, audio);
assert(chain.filters.slice(0, 4).every(f => f.type === 'highpass')); assert(Math.abs(chain.filters[3].Q.value - 20 * Math.log10(2.5629)) < 1e-9); // Cut ignores the stored q.
for (const slope of [6, 13, '24']) { const e = copyEQ(eq); e.bands[0].slope = slope; assert(!validEQ(e)); }
{ const e = copyEQ(eq); e.bands[2].slope = 12; assert(!validEQ(e)); }
{ const old = copyEQ(eq); delete old.bands[0].slope; delete old.bands[1].slope; assert(validEQ(old)); assert.equal(copyEQ(old).bands[1].slope, 12); }
eq.bands[0].slope = 12;
eq.enabled = false; setEQNodes(chain.filters, eq, audio);
assert(chain.filters.every(f => f.type === 'peaking' && f.gain.value === 0));
const dry = node(); assert.equal(connectTrackEQ(audio, {}, dry, output).nodes.length, 0); assert.equal(dry.connections[0], output);
const app = readFileSync(new URL('app/app.js', root), 'utf8');
assert(app.includes('connectTrackEQ(context, track, input, pan.input, true)'));
assert(app.includes('connectTrackEQ(offline, track, eqInput, connectPan(offline, track, offline.destination).input)'));
assert(app.includes('version: 13')); assert(app.includes('const at = now + trackLatency(track, context.sampleRate)')); assert(app.includes('const from = start - lead + trackLatency(track, rate)')); assert(app.includes('effects: track.effects'));
assert(app.includes('effects: copyEffects(t)')); assert(app.includes('validEQ(track.eq)')); assert(app.includes('validEffects(track.effects)'));
const effects = [{ type: 'equalizer', eq: defaultEQ() }, { type: 'equalizer', eq: defaultEQ() }];
assert(validEffects(effects)); assert(!validEffects([{ type: 'unknown', eq: defaultEQ() }])); assert(!validEffects([{ type: 'equalizer', eq: null }]));
assert(!validEffects(Array(33).fill(effects[0]))); assert.equal(copyEffects({ eq: defaultEQ() }).length, 1);
const copied = copyEffects({ effects }); copied[0].eq.bands[2].gain = 9; assert.equal(effects[0].eq.bands[2].gain, 0);
const ordered = connectTrackEQ(audio, { effects }, node(), output);
assert.equal(ordered.filters.length, 24); assert.equal(ordered.effects[0].effect, effects[0]);
assert.equal(ordered.filters[11].connections[0], ordered.filters[12]);
effects.reverse(); const reversed = connectTrackEQ(audio, { effects }, node(), output); assert.equal(reversed.effects[0].effect, effects[0]);
assert(source.includes('new Float64Array(30)'));
console.log('EQ checks passed: validation, deep copy, bypass, Q, Nyquist, routing, persistence/export integration.');
