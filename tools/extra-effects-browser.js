// Real native/offline DSP checks for the additional effects.
async function runAdditionalEffectChecks() {
  const assert = (value, label) => { if (!value) throw Error(label); };
  async function render(effects, { seconds = 1, channels = 1, signal = (t, c) => .2 * Math.sin(2 * Math.PI * 440 * t) } = {}) {
    const audio = new OfflineAudioContext(channels, Math.round(48000 * seconds), 48000);
    await prepareTrackEffects(audio, [{ effects }]);
    const source = audio.createBufferSource(), buffer = audio.createBuffer(channels, audio.length, 48000);
    for (let c = 0; c < channels; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < data.length; i++) data[i] = signal(i / 48000, c, i); }
    source.buffer = buffer; const chain = connectTrackEQ(audio, { effects }, source, audio.destination); source.start();
    const result = await audio.startRendering(); disposeEffectChain(chain); return result;
  }
  const rms = (buffer, channel = 0, from = .5, to = buffer.duration) => { const a = buffer.getChannelData(channel); let sum = 0, count = 0; for (let i = Math.ceil(from * buffer.sampleRate); i < Math.min(a.length, Math.floor(to * buffer.sampleRate)); i++) { assert(Number.isFinite(a[i]), 'Finite DSP samples'); sum += a[i] ** 2; count++; } return Math.sqrt(sum / Math.max(1, count)); };
  const impulse = (t, c, i) => i === 0 ? 1 : 0;
  for (const type of Object.keys(UTILITY_EFFECTS)) {
    const effect = defaultUtilityEffect(type); effect.settings.enabled = false;
    const result = await render([effect]); assert(Math.abs(rms(result) / (.2 / Math.sqrt(2)) - 1) < .003, `${type} bypass unity`);
  }
  const delay = defaultUtilityEffect('delay'); Object.assign(delay.settings, { time: 100, feedback: 50, mix: 100 });
  const echoes = await render([delay], { signal: impulse });
  assert(rms(echoes, 0, .099, .11) > .02, 'First delay echo at 100 ms');
  assert(rms(echoes, 0, .199, .22) > .001, 'Feedback produces a second echo');
  assert(rms(echoes, 0, 0, .09) === 0, 'Fully wet delay has no direct sound');
  const reverbs = [];
  for (const preset of ['hall', 'room', 'plate']) {
    const effect = defaultUtilityEffect('reverb'); Object.assign(effect.settings, { preset, decay: REVERB_DECAYS[preset], preDelay: 0, mix: 100 });
    const result = await render([effect], { channels: 2, signal: impulse, seconds: 2 }); reverbs.push(result);
    assert(rms(result, 0, .1, .3) > .0001, `${preset} has a reverberant tail`);
    let difference = 0; const l = result.getChannelData(0), r = result.getChannelData(1); for (let i = 0; i < 10000; i++) difference += Math.abs(l[i] - r[i]);
    assert(difference > .01, `${preset} has a stereo impulse`);
  }
  assert(Math.abs(rms(reverbs[0], 0, .3, .6) - rms(reverbs[1], 0, .3, .6)) > .00001, 'Hall and room differ');
  const pitch = defaultUtilityEffect('pitch');
  assert(Math.abs(rms(await render([pitch])) / (.2 / Math.sqrt(2)) - 1) < .003, 'Zero pitch is transparent');
  const frequency = buffer => { const data = buffer.getChannelData(0); let crossings = 0; for (let i = 24001; i < data.length; i++) if (data[i - 1] <= 0 && data[i] > 0) crossings++; return crossings / (buffer.duration - .5); };
  pitch.settings.semitones = 12; const up = await render([pitch]); assert(Math.abs(frequency(up) - 880) < 25, `Pitch +12: measured ${frequency(up)} Hz`);
  pitch.settings.semitones = -12; const down = await render([pitch]); assert(Math.abs(frequency(down) - 220) < 20, `Pitch -12: measured ${frequency(down)} Hz`);
  // Spliced output must stay a clean sine: residual after a per-50 ms best-fit sine (THD+N) below -40 dB. The previous
  // two-voice design measured about -7 dB at +12 st.
  const thdn = (buffer, f) => { const x = buffer.getChannelData(0).slice(24000), b = 2400; let res = 0, tot = 0; for (let i = 0; i + b <= x.length; i += b) { let ss = 0, cc = 0, sc = 0, sn = 0, cs = 0; for (let k = 0; k < b; k++) { const p = 2 * Math.PI * f * (i + k) / 48000, s = Math.sin(p), c = Math.cos(p); ss += s * s; cc += c * c; sc += s * c; sn += x[i + k] * s; cs += x[i + k] * c; } const det = ss * cc - sc * sc, a = (sn * cc - cs * sc) / det, bb = (cs * ss - sn * sc) / det; for (let k = 0; k < b; k++) { const p = 2 * Math.PI * f * (i + k) / 48000, e = x[i + k] - a * Math.sin(p) - bb * Math.cos(p); res += e * e; tot += x[i + k] ** 2; } } return 10 * Math.log10(res / tot); };
  assert(thdn(up, 880) < -40 && thdn(down, 220) < -40, `Pitch THD+N: +12 ${thdn(up, 880).toFixed(1)} dB, -12 ${thdn(down, 220).toFixed(1)} dB`);
  const chorus = defaultUtilityEffect('chorus'); chorus.settings.mix = 100; const spread = await render([chorus], { channels: 2 });
  assert(rms(spread) > .01, 'Chorus emits audio');
  let stereoDifference = 0; const l = spread.getChannelData(0), r = spread.getChannelData(1); for (let i = 24000; i < l.length; i++) stereoDifference += (l[i] - r[i]) ** 2;
  assert(stereoDifference / 24000 > .00001, 'Chorus stereo voices differ');
  const expander = defaultUtilityEffect('expander'); Object.assign(expander.settings, { threshold: -30, ratio: 4, knee: 0, release: 50 });
  const quiet = await render([expander], { signal: t => .001 * Math.sin(2 * Math.PI * 440 * t) });
  assert(rms(quiet) < .00001, 'Native worklet expander attenuates quiet input');
  const linked = await render([expander], { channels: 2, signal: (t, c) => (c ? .001 : .8) * Math.sin(2 * Math.PI * 440 * t) });
  assert(rms(linked, 1) > .0006, 'Native worklet stereo detector links channels');
  const mixed = await render([defaultUtilityEffect('chorus'), defaultUtilityEffect('delay'), expander, defaultUtilityEffect('reverb')], { channels: 2 });
  assert(rms(mixed) > .001, 'Mixed utility chain renders offline');
  return 'delay echoes, Hall/Room/Plate tails, pitch ±12 st, stereo chorus, worklet expansion and stereo linking';
}
