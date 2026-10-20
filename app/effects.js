// Additional effects, dependency-free: native audio graphs plus expander and pitch shifter worklets.
const UTILITY_EFFECTS = {
  delay: { name: tr('Delay'), params: [['time', tr('Time (ms)'), 10, 2000, 1, true, 'ms', 350], ['feedback', tr('Feedback (%)'), 0, 95, 1, false, '%', 35], ['tone', tr('Tone (Hz)'), 200, 18000, 1, true, 'Hz', 6000], ['mix', tr('Mix (%)'), 0, 100, 1, false, '%', 30]], note: tr('Feedback delay with low-pass damping. Feedback is capped at 95%. Echoes outside the export range are trimmed.') },
  reverb: { name: tr('Reverb'), params: [['decay', tr('Decay (s)'), .2, 8, .1, true, 's', 2.8], ['preDelay', tr('Pre-delay (ms)'), 0, 200, 1, false, 'ms', 20], ['damping', tr('Damping (Hz)'), 500, 20000, 1, true, 'Hz', 8000], ['mix', tr('Mix (%)'), 0, 100, 1, false, '%', 25]], note: tr('Deterministic stereo convolution: Hall, Room or Plate. Decay is the approximate 60 dB decay time. Tails outside the export range are trimmed.') },
  pitch: { name: tr('Pitch shifter'), params: [['semitones', tr('Semitones'), -24, 24, .1, false, 'st', 0], ['window', tr('Window (ms)'), 20, 200, 1, true, 'ms', 60], ['mix', tr('Mix (%)'), 0, 100, 1, false, '%', 100]], note: tr('Changes pitch without changing duration by splicing the audio where the waveforms match. Window is the splice length: longer is smoother on sustained sounds, shorter follows fast speech better. The effect delay is compensated: the track is played that much earlier, so the original and the shifted sound stay aligned with each other and with the video. Formants are not preserved. Requires AudioWorklet (localhost or HTTPS).') },
  chorus: { name: tr('Chorus'), params: [['rate', tr('Rate (Hz)'), .05, 8, .01, true, 'Hz', .8], ['depth', tr('Depth (ms)'), 0, 20, .1, false, 'ms', 6], ['delay', tr('Delay (ms)'), 5, 40, .1, true, 'ms', 18], ['width', tr('Width (%)'), 0, 100, 1, false, '%', 75], ['mix', tr('Mix (%)'), 0, 100, 1, false, '%', 35]], note: tr('Two quadrature-modulated delay voices with stereo spread. Depth is limited internally to keep delay time positive. Stereo width folds down in mono exports.') },
  expander: { name: tr('Expander'), params: [['threshold', tr('Threshold (dB)'), -100, 0, .1, false, 'dB', -40], ['ratio', tr('Ratio'), 1, 20, .1, false, ':1', 2], ['knee', tr('Knee (dB)'), 0, 24, .1, false, 'dB', 6], ['range', tr('Range (dB)'), 0, 80, .1, false, 'dB', 60], ['attack', tr('Attack (ms)'), .1, 1000, .1, true, 'ms', 5], ['release', tr('Release (ms)'), 1, 3000, .1, true, 'ms', 150], ['gain', tr('Gain (dB)'), -24, 24, .1, false, 'dB', 0], ['mix', tr('Mix (%)'), 0, 100, 1, false, '%', 100]], note: tr('Stereo-linked downward expander. Signals below threshold are attenuated, never boosted. Attack opens the gate; release closes it. Requires AudioWorklet (localhost or HTTPS).') },
};
const REVERB_DECAYS = { hall: 2.8, room: .8, plate: 1.6 };
// Settings added after an effect first shipped: older projects load them with these values (pitch window: version 11).
const UTILITY_ADDED = { pitch: { window: 60 } };
const WORKLET_EFFECTS = { expander: 'audiorec-expander-v1', pitch: 'audiorec-pitch-v1' };
function defaultUtilityEffect(type) {
  const settings = { enabled: true }; for (const [key, , , , , , , value] of UTILITY_EFFECTS[type].params) settings[key] = value;
  if (type === 'reverb') settings.preset = 'hall'; return { type, settings };
}
function validUtilityEffect(effect) {
  if (!effect || typeof effect.type !== 'string') return false;
  if (!Object.hasOwn(UTILITY_EFFECTS, effect.type) || !effect.settings) return false;
  const definition = UTILITY_EFFECTS[effect.type], s = { ...UTILITY_ADDED[effect.type], ...effect.settings };
  return typeof s.enabled === 'boolean' && definition.params.every(([key, , min, max]) => Number.isFinite(s[key]) && s[key] >= min && s[key] <= max) && (effect.type !== 'reverb' || Object.hasOwn(REVERB_DECAYS, s.preset));
}
// A static module in a Blob works with both realtime and OfflineAudioContext, without fetching dependencies.
const EXPANDER_PROCESSOR_SOURCE = `
class AudiorecExpander extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    ['enabled',1,0,1],['threshold',-40,-100,0],['ratio',2,1,20],['knee',6,0,24],['range',60,0,80],
    ['attack',5,.1,1000],['release',150,1,3000],['gain',0,-24,24],['mix',100,0,100]
  ].map(([name,defaultValue,minValue,maxValue])=>({name,defaultValue,minValue,maxValue,automationRate:'k-rate'})); }
  constructor(options) { super(); this.envelope=0; this.gainDb=0; this.frames=0; this.running=true; this.meter=!!options.processorOptions?.meter; this.port.onmessage=e=>{if(e.data==='stop')this.running=false;}; }
  process(inputs,outputs,p) {
    if(!this.running)return false;
    const input=inputs[0],output=outputs[0]; if(!output.length)return true;
    const enabled=p.enabled[0]>=.5,threshold=p.threshold[0],ratio=p.ratio[0],knee=p.knee[0],range=p.range[0];
    const attack=Math.exp(-1/(sampleRate*p.attack[0]/1000)),release=Math.exp(-1/(sampleRate*p.release[0]/1000));
    const detectorRelease=Math.exp(-1/(sampleRate*.03)),makeup=10**(p.gain[0]/20),mix=p.mix[0]/100;
    for(let i=0;i<output[0].length;i++) {
      let peak=0;for(let c=0;c<input.length;c++)peak=Math.max(peak,Math.abs(input[c][i]||0));
      this.envelope=Math.max(peak,this.envelope*detectorRelease);
      const delta=20*Math.log10(Math.max(1e-12,this.envelope))-threshold;
      let target=0;
      if(knee>0&&Math.abs(delta)<knee/2)target=-(ratio-1)*(knee/2-delta)**2/(2*knee);
      else if(delta<0)target=(ratio-1)*delta;
      target=Math.max(-range,Math.min(0,target));
      const coefficient=target>this.gainDb?attack:release;this.gainDb=target+(this.gainDb-target)*coefficient;
      const wet=10**(this.gainDb/20)*makeup;
      for(let c=0;c<output.length;c++){const dry=input[c]?.[i]||0;output[c][i]=enabled?dry*((1-mix)+mix*wet):dry;}
    }
    if(this.meter&&(this.frames+=output[0].length)>=2048){this.frames=0;this.port.postMessage(enabled?-this.gainDb:0);}
    return true;
  }
}
registerProcessor('audiorec-expander-v1',AudiorecExpander);
`;
// Fixed pitch shifter latency in samples for a window in ms: the reader's delay swings by half a window around it, and
// the dry path is delayed by exactly this much. The host feeds the track this much earlier (trackLatency), so dry, wet
// and the video line up. Shared with the worklet by source, so both always agree.
const pitchCenter = (window, rate) => 4 + Math.round(Math.max(window / 4, Math.min(15, window / 3)) * rate / 1000) + Math.round(window / 2 * rate / 1000);
const trackLatency = (track, rate) => trackEffects(track).reduce((sum, e) => sum + (e.type === 'pitch' ? pitchCenter(e.settings.window ?? UTILITY_ADDED.pitch.window, rate) : 0), 0) / rate;
// Splicing pitch shifter: one reader moves through a delay line at the pitch ratio. When its delay leaves the window it
// crossfades to a second reader one window away, at the offset whose recent waveform best matches what was just played
// (normalized correlation on the mono sum), so the two pieces add in phase. Matching on the past, not ahead, keeps the
// delay low. 4-point cubic interpolation; stereo channels share every splice decision. The window is fixed per node
// because it sets the latency; changing it rebuilds playback.
const PITCH_PROCESSOR_SOURCE = `
class AudiorecPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [['enabled',1,0,1],['semitones',0,-24,24],['mix',100,0,100]]
    .map(([name,defaultValue,minValue,maxValue])=>({name,defaultValue,minValue,maxValue,automationRate:'k-rate'})); }
  constructor(options) {
    super(); const pitchCenter=${pitchCenter},ms=options?.processorOptions?.window??60;this.window=Math.round(ms*sampleRate/1000);this.center=pitchCenter(ms,sampleRate);
    this.size=2**Math.ceil(Math.log2(sampleRate*1.5)); this.mask=this.size-1; this.lines=[]; this.mono=new Float32Array(this.size);
    this.write=0; this.delay=-1; this.next=0; this.fade=0; this.fadeLength=0; this.running=true; this.port.onmessage=e=>{if(e.data==='stop')this.running=false;};
  }
  read(line,position) {
    const i=Math.floor(position),f=position-i,m=this.mask,x0=line[(i-1)&m],x1=line[i&m],x2=line[(i+1)&m],x3=line[(i+2)&m];
    return ((((.5*(x3-x0)+1.5*(x1-x2))*f+(x0-2.5*x1+2*x2-.5*x3))*f+.5*(x2-x0))*f)+x1;
  }
  // Best delay near target, comparing the last length samples of both readers: every 4 samples, then refined to the sample.
  match(target,length,search,ratio) {
    const m=this.mask,mono=this.mono,from=this.write-this.delay,to=this.write-target,step=2,score=offset=>{let ab=0,bb=0;for(let k=0;k<length;k+=step){const b=mono[Math.round(to-offset-k*ratio)&m];ab+=mono[Math.round(from-k*ratio)&m]*b;bb+=b*b;}return ab/Math.sqrt(bb+1e-9);};
    let best=0,bestScore=-Infinity;
    for(let o=-search;o<=search;o+=4){const s=score(o);if(s>bestScore){bestScore=s;best=o;}}
    for(let o=best-3;o<=best+3;o++){if(o<-search||o>search)continue;const s=score(o);if(s>bestScore){bestScore=s;best=o;}}
    return target+best;
  }
  process(inputs,outputs,p) {
    if(!this.running)return false;
    const input=inputs[0],output=outputs[0];if(!output.length)return true;
    while(this.lines.length<output.length)this.lines.push(new Float32Array(this.size));
    const enabled=p.enabled[0]>=.5,ratio=2**(p.semitones[0]/12),shift=Math.abs(ratio-1)>1e-5,mix=p.mix[0]/100,m=this.mask;
    const window=this.window,center=this.center,search=Math.round(Math.min(.015*sampleRate,window/3));
    // The old reader approaches the writer by fadeLength*(ratio-1) during an upward fade: capped at a quarter window, which
    // the center keeps clear, as it does the search range a downward splice may land early.
    const fadeLength=Math.max(16,Math.min(Math.round(window/4),Math.round(.03*sampleRate),Math.floor(window/4/Math.max(1e-5,Math.abs(ratio-1)))));
    const low=center-Math.round(window/2),high=low+window;
    if(this.delay<0)this.delay=center;
    for(let i=0;i<output[0].length;i++) {
      const w=this.write;let sum=0;
      for(let c=0;c<output.length;c++){const x=input[c]?.[i]??input[0]?.[i]??0;this.lines[c][w&m]=x;sum+=x;}
      this.mono[w&m]=sum/output.length;
      const g=this.fade?Math.sin(Math.PI/2*this.fade/this.fadeLength)**2:0;
      for(let c=0;c<output.length;c++) {
        const dry=this.lines[c][(w-center)&m];let wet=dry;
        if(shift){wet=this.read(this.lines[c],w-this.delay);if(this.fade)wet+=g*(this.read(this.lines[c],w-this.next)-wet);}
        output[c][i]=enabled?dry*(1-mix)+wet*mix:dry;
      }
      this.write=w+1;
      if(!shift)continue;
      this.delay=Math.max(4,this.delay+1-ratio);
      if(this.fade){this.next+=1-ratio;if(++this.fade>=this.fadeLength){this.delay=this.next;this.fade=0;}}
      else if(ratio>1?this.delay<low:this.delay>high){this.fadeLength=fadeLength;this.next=this.match(ratio>1?this.delay+window:this.delay-window,fadeLength,search,ratio);this.fade=1;}
    }
    return true;
  }
}
registerProcessor('audiorec-pitch-v1',AudiorecPitch);
`;
const utilityWorklets = new WeakMap();
function prepareTrackEffects(audio, items) {
  if (!items.some(t => trackEffects(t).some(e => Object.hasOwn(WORKLET_EFFECTS, e.type)))) return Promise.resolve();
  if (!audio.audioWorklet) return Promise.reject(new Error('Expander and pitch shifter require AudioWorklet on localhost or HTTPS.'));
  if (!utilityWorklets.has(audio)) {
    const url = URL.createObjectURL(new Blob([EXPANDER_PROCESSOR_SOURCE, PITCH_PROCESSOR_SOURCE], { type: 'text/javascript' }));
    const ready = audio.audioWorklet.addModule(url).catch(error => { utilityWorklets.delete(audio); throw error; }).finally(() => URL.revokeObjectURL(url));
    utilityWorklets.set(audio, ready);
  }
  return utilityWorklets.get(audio);
}
const impulseCaches = new WeakMap();
function reverbImpulse(audio, preset, decay) {
  let cache = impulseCaches.get(audio); if (!cache) impulseCaches.set(audio, cache = new Map());
  const key = `${preset}:${decay}`; if (cache.has(key)) return cache.get(key);
  const buffer = audio.createBuffer(2, Math.ceil(audio.sampleRate * decay), audio.sampleRate);
  const early = preset === 'room' ? [.007, .013, .023, .041] : preset === 'plate' ? [.004, .011, .019, .031] : [.019, .037, .061, .089];
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel); let seed = (preset === 'hall' ? 11939 : preset === 'room' ? 3119 : 7919) + channel * 101;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const time = i / audio.sampleRate, onset = preset === 'plate' ? .002 : preset === 'room' ? .006 : .02;
      data[i] = ((seed / 4294967296) * 2 - 1) * Math.exp(-6.9078 * time / decay) * Math.min(1, time / onset) * .18;
    }
    early.forEach((time, i) => { const sample = Math.round((time + channel * .0017) * audio.sampleRate); if (sample < data.length) data[sample] += (i % 2 ? -.6 : .8) * Math.exp(-6.9078 * time / decay); });
  }
  if (cache.size >= 8) cache.delete(cache.keys().next().value); cache.set(key, buffer); return buffer;
}
function connectUtilityEffect(audio, effect, analyse = false) {
  if (Object.hasOwn(WORKLET_EFFECTS, effect.type)) {
    const node = new AudioWorkletNode(audio, WORKLET_EFFECTS[effect.type], { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'max', processorOptions: { meter: analyse, window: effect.settings.window } });
    const entry = { effect, input: node, output: node, nodes: [node], processor: node, reduction: 0 };
    node.port.onmessage = event => { entry.reduction = event.data; };
    node.onprocessorerror = () => status(`${UTILITY_EFFECTS[effect.type].name}: processing failed. Stop playback and reload the project.`);
    entry.dispose = () => { node.port.postMessage('stop'); node.port.close(); };
    setUtilityNodes(entry); return entry;
  }
  const input = audio.createGain(), output = audio.createGain(), dry = audio.createGain(), wet = audio.createGain(), feed = audio.createGain();
  const entry = { audio, effect, input, output, dry, wet, feed, nodes: [input, output, dry, wet, feed], sources: [] };
  const keep = node => { entry.nodes.push(node); return node; };
  input.connect(dry); dry.connect(output); input.connect(feed); wet.connect(output);
  if (effect.type === 'delay') {
    entry.delay = keep(audio.createDelay(2.1)); entry.feedback = keep(audio.createGain()); entry.tone = keep(audio.createBiquadFilter()); entry.tone.type = 'lowpass';
    feed.connect(entry.delay); entry.delay.connect(wet); entry.delay.connect(entry.tone); entry.tone.connect(entry.feedback); entry.feedback.connect(entry.delay);
  } else if (effect.type === 'reverb') {
    entry.preDelay = keep(audio.createDelay(.21)); entry.convolver = keep(audio.createConvolver()); entry.tone = keep(audio.createBiquadFilter()); entry.tone.type = 'lowpass';
    feed.connect(entry.preDelay); entry.preDelay.connect(entry.convolver); entry.convolver.connect(entry.tone); entry.tone.connect(wet);
  } else if (effect.type === 'chorus') {
    entry.voices = [];
    for (let i = 0; i < 2; i++) {
      const delay = keep(audio.createDelay(.1)), depth = keep(audio.createGain()), oscillator = keep(audio.createOscillator()), pan = keep(audio.createStereoPanner()), gain = keep(audio.createGain());
      if (i) oscillator.setPeriodicWave(audio.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])));
      gain.gain.value = .5; oscillator.connect(depth); depth.connect(delay.delayTime); feed.connect(delay); delay.connect(pan); pan.connect(gain); gain.connect(wet);
      entry.voices.push({ delay, depth, oscillator, pan }); entry.sources.push(oscillator);
    }
  }
  entry.dispose = () => { for (const source of entry.sources) { try { source.stop(); } catch {} } };
  setUtilityNodes(entry); entry.sources.forEach(source => source.start(audio.currentTime));
  return entry;
}
function setUtilityNodes(entry) {
  const s = entry.effect.settings, type = entry.effect.type;
  if (entry.processor) { entry.processor.parameters.get('enabled').value = +s.enabled; for (const [name] of UTILITY_EFFECTS[type].params) { const param = entry.processor.parameters.get(name); if (param) param.value = s[name]; } return; }
  const enabled = s.enabled, mix = s.mix / 100;
  entry.dry.gain.value = enabled ? 1 - mix : 1; entry.wet.gain.value = enabled ? mix : 0; entry.feed.gain.value = enabled ? 1 : 0;
  if (type === 'delay') {
    entry.delay.delayTime.value = s.time / 1000; entry.feedback.gain.value = s.enabled ? s.feedback / 100 : 0; entry.tone.frequency.value = Math.min(s.tone, entry.audio.sampleRate * .499); entry.tone.Q.value = -3.01;
  } else if (type === 'reverb') {
    entry.preDelay.delayTime.value = s.preDelay / 1000; entry.tone.frequency.value = Math.min(s.damping, entry.audio.sampleRate * .499); entry.tone.Q.value = -3.01;
    const key = `${s.preset}:${s.decay}`; if (entry.impulseKey !== key) { entry.convolver.buffer = reverbImpulse(entry.audio, s.preset, s.decay); entry.impulseKey = key; }
  } else if (type === 'chorus') {
    entry.voices.forEach((voice, i) => { voice.delay.delayTime.value = s.delay / 1000; voice.depth.gain.value = Math.min(s.depth, s.delay - .5) / 1000; voice.oscillator.frequency.value = s.rate; voice.pan.pan.value = (i ? 1 : -1) * s.width / 100; });
  }
}
let utilityEffect = null, utilityFrame = 0;
function renderUtilityControls(effect) {
  const definition = UTILITY_EFFECTS[effect.type], count = definition.params.length; $('utility-controls').replaceChildren(); $('utility-controls').style.setProperty('--cols', count <= 5 ? count : 4);
  for (const [key, label, min, max, step, logarithmic, unit, reset] of definition.params) $('utility-controls').append(createEQKnob(effect.settings, key, label, min, max, step, definition.name, { reset, logarithmic, unit, decimals: step >= 1 ? 0 : step >= .1 ? 1 : 2, onCommit: effect.type === 'pitch' && key === 'window' ? syncPlayback : null }));
}
function openUtilityEffect(effect, index) {
  utilityEffect = effect; const definition = UTILITY_EFFECTS[effect.type];
  $('utility-title').textContent = effectTitle(effect, index); markBypass('utility-dialog', effect); $('utility-enabled').checked = effect.settings.enabled;
  $('reverb-preset-field').hidden = effect.type !== 'reverb'; $('utility-meter').hidden = effect.type !== 'expander';
  if (effect.type === 'reverb') $('reverb-preset').value = effect.settings.preset;
  $('utility-note').textContent = definition.note; renderUtilityControls(effect);
  $('utility-dialog').showModal(); cancelAnimationFrame(utilityFrame); drawUtilityEffect();
}
const niceStep = range => { const raw = range / 6, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map(m => m * p).find(v => v >= raw); };
const ticks = (from, to, format) => { const step = niceStep(to - from), list = []; for (let v = Math.ceil(from / step) * step; v <= to + 1e-9; v += step) list.push([v, format(+v.toFixed(6))]); return list; };
function expanderCurve(db, s) {
  const delta = db - s.threshold; let gain = delta < 0 ? (s.ratio - 1) * delta : 0;
  if (s.knee && Math.abs(delta) < s.knee / 2) gain = -(s.ratio - 1) * (s.knee / 2 - delta) ** 2 / (2 * s.knee);
  return s.enabled ? db + Math.max(-s.range, gain) + s.gain : db;
}
function drawUtilityEffect() {
  if (!utilityEffect || !$('utility-dialog').open) return;
  const e = utilityEffect, s = e.settings, canvas = $('utility-graph'), g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const css = getComputedStyle(document.documentElement), color = token => css.getPropertyValue(token).trim();
  const left = 52, right = w - 18, top = 14, bottom = h - 26, X = (v, a, b) => left + (v - a) / (b - a) * (right - left), Y = (v, a, b) => bottom - (Math.max(a, Math.min(b, v)) - a) / (b - a) * (bottom - top);
  g.clearRect(0, 0, w, h); g.font = '11px sans-serif'; g.lineWidth = 1;
  // Labelled grid: each effect passes [value, label] ticks and its axis ranges.
  const axes = (xs, xa, xb, ys, ya, yb) => {
    g.strokeStyle = color('--line'); g.fillStyle = color('--muted'); g.textAlign = 'center';
    for (const [v, label] of xs) { const x = X(v, xa, xb); g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.fillText(label, x, h - 8); }
    g.textAlign = 'right'; for (const [v, label] of ys) { const y = Y(v, ya, yb); g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke(); g.fillText(label, left - 7, y + 4); }
    g.textAlign = 'start';
  };
  const line = (points, stroke, dash = []) => { g.strokeStyle = stroke; g.lineWidth = 2; g.setLineDash(dash); g.beginPath(); points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]); g.lineWidth = 1; };
  let readout = '';
  if (e.type === 'delay') {
    const end = s.time * 8, x = t => X(t, 0, end), y = v => Y(v, 0, 100);
    axes(ticks(0, end, v => `${v} ms`), 0, end, [[0, '0%'], [50, '50%'], [100, '100%']], 0, 100);
    g.fillStyle = color('--muted'); g.fillRect(x(0) - 3, y(100 - s.mix), 6, bottom - y(100 - s.mix));
    g.fillStyle = color('--accent-2'); for (let k = 1; k < 8; k++) { const level = s.mix * (s.feedback / 100) ** (k - 1); g.fillRect(x(k * s.time) - 3, y(level), 6, bottom - y(level)); }
    readout = tr('Echo spacing: {time} ms', { time: s.time });
  } else if (e.type === 'reverb') {
    const pre = s.preDelay / 1000, end = pre + s.decay * 1.25, x = t => X(t, 0, end), y = db => Y(db, -60, 0);
    axes(ticks(0, end, v => `${v} s`), 0, end, [0, -20, -40, -60].map(db => [db, `${db} dB`]), -60, 0);
    g.fillStyle = color('--accent-2'); g.globalAlpha = .18; g.beginPath(); g.moveTo(x(pre), y(-60)); g.lineTo(x(pre), y(0)); g.lineTo(x(pre + s.decay), y(-60)); g.fill(); g.globalAlpha = 1;
    line([[x(0), y(-60)], [x(0), y(0)]], color('--muted')); line([[x(pre), y(0)], [x(pre + s.decay), y(-60)]], color('--accent-2'));
    line([[x(pre + s.decay), top], [x(pre + s.decay), bottom]], color('--muted'), [3, 4]); g.fillStyle = color('--subtle'); g.fillText('T60', x(pre + s.decay) + 5, top + 10);
    readout = tr('{preset} · {decay} s decay · {preDelay} ms pre-delay', { preset: { hall: tr('Hall'), room: tr('Room'), plate: tr('Plate') }[s.preset], decay: s.decay, preDelay: s.preDelay });
  } else if (e.type === 'chorus') {
    const depth = Math.min(s.depth, s.delay - .5), span = Math.min(4, Math.max(1, 2 / s.rate)), max = Math.max(5, Math.ceil((s.delay + depth) / 5) * 5);
    axes(ticks(0, span, v => `${v} s`), 0, span, ticks(0, max, v => `${v} ms`), 0, max);
    // Voice 2 runs a cosine, a quarter period ahead of voice 1.
    ['--accent', '--accent-2'].forEach((token, voice) => line(Array.from({ length: 301 }, (_, i) => { const t = i / 300 * span; return [X(t, 0, span), Y(s.delay + depth * Math.sin(2 * Math.PI * s.rate * t + voice * Math.PI / 2), 0, max)]; }), color(token)));
    readout = tr('{rate} Hz modulation · {depth} ms depth', { rate: s.rate, depth: s.depth });
  } else if (e.type === 'pitch') {
    const x = st => X(st, -24, 24), mid = (top + bottom) / 2;
    axes([-24, -12, 0, 12, 24].map(st => [st, `${st > 0 ? '+' : ''}${st} st`]), -24, 24, [], 0, 1);
    g.strokeStyle = color('--line-strong'); for (let st = -24; st <= 24; st++) { g.beginPath(); g.moveTo(x(st), mid - (st % 12 ? 4 : 9)); g.lineTo(x(st), mid + (st % 12 ? 4 : 9)); g.stroke(); }
    g.fillStyle = color('--accent-2'); g.globalAlpha = .35; g.fillRect(Math.min(x(0), x(s.semitones)), mid - 8, Math.abs(x(s.semitones) - x(0)), 16); g.globalAlpha = 1;
    g.beginPath(); g.arc(x(s.semitones), mid, 7, 0, Math.PI * 2); g.fill();
    readout = tr('Pitch ratio: {ratio}× · duration unchanged', { ratio: (2 ** (s.semitones / 12)).toFixed(3) });
  } else if (e.type === 'expander') {
    const dbTicks = [-80, -60, -40, -20, 0].map(db => [db, `${db}`]);
    axes(dbTicks, -80, 0, dbTicks, -80, 0);
    line([[X(-80, -80, 0), Y(-80, -80, 0)], [X(0, -80, 0), Y(0, -80, 0)]], color('--muted'), [3, 4]);
    line([[X(s.threshold, -80, 0), top], [X(s.threshold, -80, 0), bottom]], color('--accent'), [2, 4]);
    line(Array.from({ length: 301 }, (_, i) => { const db = -80 + i / 300 * 80; return [X(db, -80, 0), Y(expanderCurve(db, s), -80, 0)]; }), color('--accent-2'));
    let reduction = 0; for (const source of playingSources) if (source.track === eqTrack) for (const entry of source.eqChain?.effects || []) if (entry.effect === e) reduction = Math.max(reduction, entry.reduction || 0);
    $('utility-reduction').value = reduction; $('utility-reduction-value').textContent = `${reduction.toFixed(1)} dB`; readout = tr('Input / output: −80 to 0 dB · wet transfer curve');
  }
  if ($('utility-readout').textContent !== readout) $('utility-readout').textContent = readout;
  utilityFrame = requestAnimationFrame(drawUtilityEffect);
}
window.addEventListener('DOMContentLoaded', () => {
  $('utility-enabled').onchange = () => { changeEQ(() => { utilityEffect.settings.enabled = $('utility-enabled').checked; }); markBypass('utility-dialog', utilityEffect); };
  $('reverb-preset').onchange = () => { changeEQ(() => { utilityEffect.settings.preset = $('reverb-preset').value; utilityEffect.settings.decay = REVERB_DECAYS[utilityEffect.settings.preset]; }); finishKnob?.(); renderUtilityControls(utilityEffect); };
  $('utility-remove').onclick = () => { changeEQ(() => eqTrack.effects.splice(eqTrack.effects.indexOf(utilityEffect), 1)); syncPlayback(); $('utility-dialog').close(); renderEffectsList(); };
  $('utility-dialog').addEventListener('close', () => { finishKnob?.(); cancelAnimationFrame(utilityFrame); utilityEffect = null; if (eqTrack) renderEffectsList(); });
});
