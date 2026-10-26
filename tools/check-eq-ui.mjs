// Real Chromium UI/DSP checks, no dependencies. CHROME_BIN can override the executable.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let binary = process.env.CHROME_BIN;
for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
  if (binary) break; try { await access(candidate); binary = candidate; } catch {}
}
if (!binary) throw Error('Set CHROME_BIN to a Chromium executable');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname), path = resolve(root, `.${pathname}`);
    if (!path.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
    const data = await readFile(path), type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type }); response.end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/`;
const profile = await mkdtemp(join(tmpdir(), 'audiorec-eq-ui-'));
// A fake microphone (Chrome's beep generator) and no autoplay gate let the recording path run without hardware, a
// permission prompt or a user gesture (AudioContext.resume() otherwise never settles headless).
const chrome = spawn(binary, ['--headless', '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(Error('Chromium startup timeout')), 15000);
    chrome.once('error', reject); chrome.stderr.on('data', chunk => { text += chunk; const url = text.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]; if (url) { clearTimeout(timer); resolve(url); } });
  });
  const address = new URL(endpoint), tabs = await (await fetch(`http://${address.host}/json`)).json();
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
    if (pending.has(message.id)) { const { resolve, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer); if (message.error) reject(Error(JSON.stringify(message.error))); else resolve(message.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error(`${method} timed out`)); }, 20000); pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const wait = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await sleep(100); } throw Error(`Timeout: ${expression}`); };
  const click = async (x, y) => { await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); };
  await call('Runtime.enable');
  await call('Page.navigate', { url: new URL('app/index.html', baseURL).href });
  await wait("!!document.querySelector('.track-fx') && !document.getElementById('add-track').disabled");
  // Picks an effect from the Add effect dropdown, as a user would.
  function addFx(type) { return `(s => { s.value = '${type}'; s.dispatchEvent(new Event('change')); })(document.getElementById('fx-add'))`; }
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1100, deviceScaleFactor: 1, mobile: false });
  assert(await evaluate(`(() => {
    const button=document.getElementById('video-panel-toggle'),panel=document.getElementById('video-panel'),splitter=document.getElementById('splitter');
    if(button.previousElementSibling.id!=='video-file' || !button.querySelector('use').getAttribute('href').includes('film'))return false;
    window.beforeVideoPanel=JSON.stringify(projectData());showClipList(false);setVideoHeight(240);
    const height=document.querySelector('.app').style.getPropertyValue('--video-height'),before=document.getElementById('tracks-panel').getBoundingClientRect().height;
    button.click();window.dispatchEvent(new Event('resize'));
    if(!panel.hidden || !splitter.hidden || panel.getBoundingClientRect().height!==0 || splitter.getBoundingClientRect().height!==0 || button.getAttribute('aria-expanded')!=='false' || document.getElementById('tracks-panel').getBoundingClientRect().height<=before)return false;
    if(document.querySelector('.app').style.getPropertyValue('--video-height')!==height)return false;
    button.click();
    if(panel.hidden || splitter.hidden || button.getAttribute('aria-pressed')!=='true' || !document.getElementById('clip-list').classList.contains('collapsed') || JSON.stringify(projectData())!==window.beforeVideoPanel)return false;
    showClipList(true);button.click();return true;
  })()`), 'Film toggle hides entire panel and splitter, expands tracks and preserves layout/project state');
  await call('Page.reload');await wait("!!document.querySelector('.track-fx') && !document.getElementById('add-track').disabled");
  assert(await evaluate("document.getElementById('video-panel').hidden && document.getElementById('video-panel-toggle').getAttribute('aria-pressed')==='false'"),'Hidden video-panel preference restored after reload');
  await evaluate("document.getElementById('video-panel-toggle').click()");
  assert(await evaluate(`(() => {
    document.querySelector('.track-fx').click();
    if (!document.getElementById('fx-dialog').open) return false;
    ${addFx('equalizer')}; ${addFx('equalizer')};
    window.firstEffect = tracks[0].effects[0];
    return tracks[0].effects.length === 2 && !document.getElementById('eq-dialog').open && document.querySelectorAll('#fx-list .fx-name').length === 2 && document.getElementById('fx-dialog').getBoundingClientRect().width < 360;
  })()`), 'Compact effects list, add multiple effects without opening editor');
  assert(await evaluate(`(() => {
    document.querySelector('.fx-name').click();
    const fields = document.querySelectorAll('#eq-controls .eq-knob');
    if (!document.getElementById('eq-dialog').open || fields.length !== 14 || document.querySelectorAll('#eq-controls .eq-slope input[type=radio]').length !== 8) return false;
    const gain = document.querySelector('.eq-band-2 .eq-knob-gain input'); gain.value = 9; gain.dispatchEvent(new Event('change'));
    return tracks[0].effects[0].eq.bands[2].gain === 9 && projectData().tracks[0].effects[0].eq.bands[2].gain === 9;
  })()`), 'Separate editor, 16 knobs and editable values persisted');
  const bounds = await evaluate("(()=>{const r=document.getElementById('eq-dialog').getBoundingClientRect();return {height:r.height,scroll:document.getElementById('eq-dialog').scrollHeight,client:document.getElementById('eq-dialog').clientHeight}})()");
  assert(bounds.height < 1000 && bounds.scroll <= bounds.client + 1, `Desktop EQ fits without scrolling: ${JSON.stringify(bounds)}`);
  assert(await evaluate(`(() => {
    const options = [...document.getElementById('fx-add').options], names = options.slice(1).map(o => o.text);
    if (options[0].value !== '' || document.getElementById('fx-add').value !== '' || names.length !== 7) return false;
    if (document.getElementById('fx-dialog').firstElementChild.nextElementSibling !== document.getElementById('fx-add')) return false;
    return names.every((name, i) => !i || names[i - 1].localeCompare(name, I18N.language) <= 0);
  })()`), 'Add effect dropdown sits at the top, sorted alphabetically, and resets to its prompt');
  assert(await evaluate(`(() => {
    const band = tracks[0].effects[0].eq.bands[3], box = document.querySelector('.eq-band-3 .eq-band-toggle input'), input = document.querySelector('.eq-band-3 .eq-knob-gain input');
    box.click(); if (band.enabled || box.checked) return false; const history = undoStack.length;
    input.value = 0; input.dispatchEvent(new Event('change')); if (band.enabled) return false;
    input.value = 4; input.dispatchEvent(new Event('change')); return band.enabled && box.checked && undoStack.length === history + 2 && projectData().tracks[0].effects[0].eq.bands[3].enabled;
  })()`), 'Changing a disabled band gain to non-zero switches it on, in the same undo step');
  assert(await evaluate(`(() => { const knob = document.querySelector('.eq-band-2 .eq-knob-gain .eq-knob'); knob.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp', bubbles:true})); return tracks[0].effects[0].eq.bands[2].gain > 9; })()`), 'Knob keyboard interaction');
  const point = await evaluate("(()=>{const r=document.querySelector('.eq-band-2 .eq-knob-q .eq-knob').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,before:tracks[0].effects[0].eq.bands[2].q,history:undoStack.length}})()");
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 4; i++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y - i * 8, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y - 32, button: 'left', clickCount: 1 });
  assert(await evaluate(`tracks[0].effects[0].eq.bands[2].q > ${point.before} && undoStack.length === ${point.history + 1}`), 'Pointer knob gesture creates one undo entry');
  await sleep(80);
  const handle = await evaluate("(()=>{const c=document.getElementById('eq-graph'),r=c.getBoundingClientRect(),h=eqHandles[3],b=tracks[0].effects[0].eq.bands[3];return {x:r.left+h.x*r.width/c.width,y:r.top+h.y*r.height/c.height,freq:b.freq,gain:b.gain,history:undoStack.length}})()");
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 4; i++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + i * 10, y: handle.y - i * 6, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 40, y: handle.y - 24, button: 'left', clickCount: 1 });
  assert(await evaluate(`(()=>{const b=tracks[0].effects[0].eq.bands[3];return b.freq > ${handle.freq} && b.gain > ${handle.gain} && undoStack.length === ${handle.history + 1} && +document.querySelector('.eq-band-3 .eq-knob-freq input').value === b.freq && projectData().tracks[0].effects[0].eq.bands[3].freq === b.freq})()`), 'Graph handle drag moves frequency and gain with one undo entry');
  await click(1, 1); await sleep(80);
  assert(await evaluate("!document.getElementById('eq-dialog').open && document.getElementById('fx-dialog').open"), 'Backdrop closes only top dialog');
  assert(await evaluate(`(() => { document.querySelector('.fx-name').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', altKey:true, bubbles:true})); return tracks[0].effects[1] === window.firstEffect && projectData().tracks[0].effects[1].eq.bands[2].gain > 9; })()`), 'Sortable keyboard order and persistence');
  assert(await evaluate(`(() => { const rows=document.querySelectorAll('.fx-item'), transfer=new DataTransfer(); rows[1].dispatchEvent(new DragEvent('dragstart',{dataTransfer:transfer,bubbles:true})); rows[0].dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true})); return tracks[0].effects[0] === window.firstEffect; })()`), 'Native drag/drop sortable order');
  await evaluate("document.querySelector('.fx-name').click()");
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  const mobile = await evaluate("(()=>{const e=document.getElementById('eq-dialog'),r=e.getBoundingClientRect();return {height:r.height,width:r.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}})()");
  assert(mobile.height < 1000 && mobile.width <= 390 && mobile.scrollWidth <= mobile.clientWidth + 1, `Mobile size and no horizontal overflow: ${JSON.stringify(mobile)}`);
  await evaluate("document.getElementById('eq-remove').click()"); await sleep(80);
  assert(await evaluate("tracks[0].effects.length === 1 && !document.getElementById('eq-dialog').open"), 'Remove closes editor');
  await click(1, 1); await sleep(80);
  assert(await evaluate("!document.getElementById('fx-dialog').open"), 'Effects list backdrop closes');
  await evaluate('undo()'); assert.equal(await evaluate('tracks[0].effects.length'), 2, 'Undo restores removed effect');
  await evaluate('saveProject()');
  const saved = await evaluate('JSON.stringify(projectData().tracks[0].effects)');
  await call('Page.reload'); await wait("!!document.querySelector('.track-fx') && !document.getElementById('add-track').disabled");
  assert.equal(await evaluate('JSON.stringify(tracks[0].effects)'), saved, 'IndexedDB round-trip preserves effect order and settings');
  assert(await evaluate(`(async () => {
    const before = JSON.stringify(tracks[0].effects), file = new File([projectBlob()], 'round-trip.audiorec');
    const bytes = new Uint8Array(await file.arrayBuffer()), view = new DataView(bytes.buffer), size = view.getUint32(8, true);
    const manifest = JSON.parse(new TextDecoder().decode(bytes.slice(12, 12 + size)));
    if (manifest.version !== 13 || manifest.tracks[0].effects.length !== 2) return false;
    const oldAsk = ask; ask = async () => true;
    try {
      await openProject(file); if (JSON.stringify(tracks[0].effects) !== before) return false;
      manifest.version = 6;
      for (const track of manifest.tracks) { track.eq = track.effects[0]?.eq || null; delete track.effects; for (const band of track.eq?.bands || []) delete band.slope; }
      const json = new TextEncoder().encode(JSON.stringify(manifest)), header = new Uint8Array(12); header.set(new TextEncoder().encode('AUDIOREC')); new DataView(header.buffer).setUint32(8, json.length, true);
      await openProject(new File([header, json, bytes.slice(12 + size)], 'legacy-v6.audiorec'));
      return tracks[0].effects.length === 1 && JSON.stringify(tracks[0].effects[0].eq) === JSON.stringify(copyEQ(manifest.tracks[0].eq)) && tracks[0].effects[0].eq.bands[0].slope === 12;
    } finally { ask = oldAsk; }
  })()`), 'Version 13 file round-trip and version 6 EQ migration (cuts default to 12 dB/oct)');
  assert(await evaluate(`(() => {
    document.querySelector('.track-fx').click(); ${addFx('compressor')};
    const row=document.querySelectorAll('.fx-name')[1]; if(!row.textContent.includes('Compressor'))return false; row.click();
    if(!document.getElementById('compressor-dialog').open || document.querySelectorAll('.compressor-knobs .eq-knob').length!==8)return false;
    const ratio=document.querySelector('#compressor-dynamics .eq-knob-ratio input');ratio.value=4.5;ratio.dispatchEvent(new Event('change'));
    const threshold=document.querySelector('#compressor-dynamics .eq-knob-threshold input');threshold.value=-24;threshold.dispatchEvent(new Event('change'));
    document.querySelector('#compressor-controls .eq-knob-attack .eq-knob').dispatchEvent(new MouseEvent('dblclick'));
    document.getElementById('compressor-enabled').click();
    const c=tracks[0].effects[1].compressor;if(c.enabled || c.ratio!==4.5 || c.threshold!==-24 || c.attack!==15)return false;
    document.getElementById('compressor-enabled').click();return projectData().tracks[0].effects[1].compressor.enabled;
  })()`), 'Compressor editor, eight knobs, edit/reset, bypass and serialization');
  await sleep(100);
  const compressorMobile = await evaluate("(()=>{const e=document.getElementById('compressor-dialog'),r=e.getBoundingClientRect();return {height:r.height,width:r.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}})()");
  assert(compressorMobile.height<1000 && compressorMobile.width<=390 && compressorMobile.scrollWidth<=compressorMobile.clientWidth+1, 'Compressor mobile sizing');
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1100, deviceScaleFactor: 1, mobile: false });
  const compressorDesktop=await evaluate("(()=>{const e=document.getElementById('compressor-dialog');return {height:e.getBoundingClientRect().height,scroll:e.scrollHeight,client:e.clientHeight}})()");
  assert(compressorDesktop.height<1000 && compressorDesktop.scroll<=compressorDesktop.client+1, 'Compressor desktop fits without scrolling');
  await click(1,1);await sleep(80);
  assert(await evaluate(`(() => {document.querySelectorAll('.fx-name')[1].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}));return tracks[0].effects[0].type==='compressor' && tracks[0].effects[1].type==='equalizer';})()`), 'Mixed effect types sort in saved order');
  await click(1,1);await sleep(80);await evaluate('saveProject()');
  const compressorSaved=await evaluate('JSON.stringify(projectData().tracks[0].effects)');
  await call('Page.reload');await wait("!!document.querySelector('.track-fx') && !document.getElementById('add-track').disabled");
  assert.equal(await evaluate('JSON.stringify(tracks[0].effects)'),compressorSaved,'Mixed compressor/EQ autosave round-trip');
  assert(await evaluate(`(async()=>{const before=JSON.stringify(tracks[0].effects),file=new File([projectBlob()],'compressor.audiorec'),oldAsk=ask;ask=async()=>true;try{await openProject(file);return JSON.stringify(tracks[0].effects)===before}finally{ask=oldAsk}})()`),'Compressor project file round-trip');
  assert(await evaluate(`(async()=>{
    const t=tracks[0], original={effects:t.effects,clips:t.clips,muted:t.muted,visible:t.visible,volume:t.volume};
    try {
      const buffer=getContext().createBuffer(1,48000,48000),data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=.8*Math.sin(2*Math.PI*777*i/48000);
      t.clips=[{name:'test',start:0,trimStart:0,trimEnd:0,buffer}];t.muted=false;t.visible=true;t.volume=1;
      t.effects=[{type:'compressor',compressor:{...defaultCompressor(),threshold:-30,ratio:12,knee:0}},{type:'equalizer',eq:defaultEQ()}];
      const rms=b=>{const a=b.getChannelData(0);let sum=0;for(let i=24000;i<a.length;i++)sum+=a[i]*a[i];return Math.sqrt(sum/(a.length-24000))};
      const wet=rms(await renderMix(0,1,48000,1,null));t.effects[0].compressor.enabled=false;
      const dry=rms(await renderMix(0,1,48000,1,null));return wet<dry*.9;
    }finally{Object.assign(t,original)}
  })()`),'Actual mixed export applies compressor and bypass');
  assert(await evaluate(`(()=>{document.querySelector('.track-fx').click();document.querySelector('.fx-name').click();document.getElementById('compressor-remove').click();return tracks[0].effects.length===1 && tracks[0].effects[0].type==='equalizer'})()`),'Remove compressor from mixed chain');
  await sleep(80);await click(1,1);await sleep(80);await evaluate('undo()');
  assert.equal(await evaluate("tracks[0].effects[0].type"),'compressor','Undo restores removed compressor');
  await evaluate("document.querySelector('.track-fx').click()");
  for (const type of ['delay','reverb','pitch','chorus','expander']) {
    assert(await evaluate(`(()=>{
      ${addFx(type)};document.querySelector('#fx-list li:last-child .fx-name').click();
      const effect=tracks[0].effects.at(-1),definition=UTILITY_EFFECTS['${type}'];
      if(effect.type!=='${type}' || !document.getElementById('utility-dialog').open || document.querySelectorAll('#utility-controls .eq-knob').length!==definition.params.length)return false;
      const input=document.querySelector('#utility-controls input'),key=definition.params[0][0];input.value=Number(input.value)+Number(input.step);input.dispatchEvent(new Event('change'));
      document.querySelector('#utility-controls .eq-knob').dispatchEvent(new MouseEvent('dblclick'));
      if(effect.settings[key]!==definition.params[0][7])return false;
      if('${type}'==='reverb'){const preset=document.getElementById('reverb-preset');preset.value='plate';preset.dispatchEvent(new Event('change'));if(effect.settings.preset!=='plate'||effect.settings.decay!==1.6||!document.getElementById('utility-dialog').open)return false;}
      document.getElementById('utility-enabled').click();if(effect.settings.enabled)return false;document.getElementById('utility-enabled').click();return validEffects(tracks[0].effects);
    })()`), `${type} UI: add, dedicated controls, editing, reset, presets and bypass`);
    await sleep(60);await click(1,1);await sleep(60);
  }
  assert(await evaluate(`(()=>{document.querySelector('#fx-list li:last-child .fx-name').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}));return tracks[0].effects.at(-2).type==='expander'})()`),'Reorder utility effects');
  await click(1,1);await sleep(80);await evaluate('saveProject()');
  const utilitiesSaved=await evaluate('JSON.stringify(projectData().tracks[0].effects)');
  await call('Page.reload');await wait("!!document.querySelector('.track-fx') && !document.getElementById('add-track').disabled");
  assert.equal(await evaluate('JSON.stringify(tracks[0].effects)'),utilitiesSaved,'All utility effects autosave round-trip');
  assert(await evaluate(`(async()=>{const before=JSON.stringify(tracks[0].effects),file=new File([projectBlob()],'all-effects.audiorec'),oldAsk=ask;ask=async()=>true;try{await openProject(file);return JSON.stringify(tracks[0].effects)===before}finally{ask=oldAsk}})()`),'All utility effects project-file round-trip');
  assert(await evaluate(`(async()=>{
    const t=tracks[0],clips=t.clips,buffer=getContext().createBuffer(1,24000,48000),data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=.2*Math.sin(2*Math.PI*440*i/48000);
    t.clips=[{name:'utility export',start:0,trimStart:0,trimEnd:0,buffer}];
    try{const result=await renderMix(0,1,48000,2,null);let power=0;for(const value of result.getChannelData(0)){if(!Number.isFinite(value))return false;power+=value*value;}return power>.001;}finally{t.clips=clips;}
  })()`),'Actual stereo export renders full utility chain including expander worklet');
  // Clip fades: 1.5 ms raised cosine at both ends, in export (also starting mid-fade and for clips shorter than two
  // fades) and in single-clip WAV downloads.
  const fades = await evaluate(`(async()=>{
    const t=tracks[0],clips=t.clips,effects=t.effects,dc=n=>{const b=getContext().createBuffer(1,n,48000);b.getChannelData(0).fill(.5);return b;};
    try{
      t.effects=[];t.clips=[{name:'fade',start:1,trimStart:0,trimEnd:0,buffer:dc(4800)}];
      const full=(await renderMix(1,1.1,48000,1,null)).getChannelData(0),mid=(await renderMix(1+36/48000,1.1,48000,1,null)).getChannelData(0);
      t.clips=[{name:'short',start:1,trimStart:0,trimEnd:0,buffer:dc(100)}];const short=(await renderMix(1,1.01,48000,1,null)).getChannelData(0);
      const wav=new DataView(clipWav({name:'w',start:0,trimStart:0,trimEnd:0,buffer:dc(4800)}).buffer),sample=i=>wav.getInt16(44+i*2,true)/32768;
      const near=(a,b)=>Math.abs(a-b)<.01;
      return {ok:near(full[0],0)&&near(full[36],.25)&&full[30]<full[36]&&full[36]<full[42]&&near(full[72],.5)&&near(full[2400],.5)&&near(full[4799],0)&&near(full[4764],.25)
        &&near(mid[0],.25)&&near(mid[36],.5)&&near(short[50],.5)&&near(short[25],.25)&&short[99]<.01&&near(sample(0),0)&&near(sample(36),.25)&&near(sample(2400),.5)&&near(sample(4799),0),
        values:[full[0],full[36],full[72],full[4764],full[4799],mid[0],short[25],short[50],short[99],sample(36)].map(v=>+v.toFixed(3))};
    }finally{t.clips=clips;t.effects=effects;}
  })()`);
  assert(fades.ok, `Raised-cosine 1.5 ms clip fades: ${JSON.stringify(fades.values)}`);
  // Overlapping clips on a track crossfade with equal power across the whole overlap: A (+0.5) then B (-0.5) overlapping
  // 1.05-1.1 s render as 0.5*cos - 0.5*sin there, also when the export starts mid-crossfade; a contained clip does not.
  const crossfade = await evaluate(`(async()=>{
    const t=tracks[0],clips=t.clips,effects=t.effects,dc=(n,v)=>{const b=getContext().createBuffer(1,n,48000);b.getChannelData(0).fill(v);return b;};
    try{
      t.effects=[];const a={name:'a',start:1,trimStart:0,trimEnd:0,buffer:dc(4800,.5)},b={name:'b',start:1.05,trimStart:0,trimEnd:0,buffer:dc(4800,-.5)};t.clips=[a,b];
      const fa=clipFades(t,a),fb=clipFades(t,b),x=(await renderMix(1,1.2,48000,1,null)).getChannelData(0),late=(await renderMix(1.075,1.2,48000,1,null)).getChannelData(0);
      const expect=i=>{const u=Math.min(1,Math.max(0,(i-2400)/2400));return .5*Math.cos(Math.PI/2*u)-.5*Math.sin(Math.PI/2*u);},near=(p,q)=>Math.abs(p-q)<.01;
      const power=[0,.25,.5,.75,1].every(u=>near(fadeGain(4800/48000-.05+u*.05,fa)**2+fadeGain(u*.05,fb)**2,1));
      const inner={name:'c',start:1.02,trimStart:0,trimEnd:0,buffer:dc(480,.5)};t.clips=[a,inner];const fc=clipFades(t,inner),fo=clipFades(t,a);
      return {ok:near(fa.out,.05)&&fa.outPower&&near(fb.in,.05)&&fb.inPower&&power&&[1200,2400,3000,3600,4200,4790].every(i=>near(x[i],expect(i)))&&near(x[6000],-.5)
        &&near(late[0],expect(3600))&&near(late[600],expect(4200))&&fc.in<.002&&fo.out<.002&&!fc.inPower,values:[x[2400],x[3600],x[4790],late[0],fa.out,fb.in,fc.in]};
    }finally{t.clips=clips;t.effects=effects;}
  })()`);
  assert(crossfade.ok, `Equal-power crossfade on overlapping clips: ${JSON.stringify(crossfade.values)}`);
  // Clip dialog (double-click): rename, typed gain, fade in; export applies gain and fade; pan: constant power with unity
  // centre in stereo, mono export unchanged at the centre; typed volume/pan parse; all of it survives a project file.
  const clipPan = await evaluate(`(async()=>{
    const t=tracks[0],clips=t.clips,effects=t.effects,pan=t.pan,dc=(n,v)=>{const b=getContext().createBuffer(1,n,48000);b.getChannelData(0).fill(v);return b;},near=(p,q,e=.005)=>Math.abs(p-q)<e;
    try{
      t.effects=[];t.pan=0;t.volume=1;t.muted=false;t.visible=true;const clip={name:'gain',start:1,trimStart:0,trimEnd:0,buffer:dc(48000,.25)};t.clips=[clip];renderTracks();
      const block=[...document.querySelectorAll('.clip')].find(b=>b.querySelector('.clip-label')?.textContent.startsWith('gain'));block.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      const opened=document.getElementById('clip-dialog').open,history=undoStack.length;
      const name=document.getElementById('clip-name');name.value='renamed';name.dispatchEvent(new Event('change'));
      const gainField=document.getElementById('clip-gain-value');gainField.value='+6';gainField.dispatchEvent(new Event('change'));
      const fadeIn=document.getElementById('clip-fade-in');fadeIn.value=100;fadeIn.dispatchEvent(new Event('change'));
      document.getElementById('clip-dialog').close();
      const oneStep=undoStack.length===history+1,settings=[clip.name,+(20*Math.log10(clip.gain)).toFixed(2),clip.fadeIn];
      const badge=!!document.querySelector('.clip .clip-gain'),shade=!!document.querySelector('.clip .clip-fade.in');
      const x=(await renderMix(1,2,48000,1,null)).getChannelData(0),g=10**(6/20);
      const gained=near(x[24000],.25*g)&&near(x[2400],.25*g*Math.sin(Math.PI/4)**2)&&x[0]<.001;
      clip.gain=1;clip.fadeIn=0;t.pan=.5;const st=await renderMix(1,2,48000,2,null),[l,r]=[st.getChannelData(0)[24000],st.getChannelData(1)[24000]];
      const panned=near(l,.25*Math.SQRT2*Math.cos(1.5*Math.PI/4))&&near(r,.25*Math.SQRT2*Math.sin(1.5*Math.PI/4))&&near(l*l+r*r,2*.25*.25);
      t.pan=0;const centre=await renderMix(1,2,48000,2,null),mono=(await renderMix(1,2,48000,1,null)).getChannelData(0)[24000];
      const unity=near(centre.getChannelData(0)[24000],.25)&&near(centre.getChannelData(1)[24000],.25)&&near(mono,.25);
      const parsed=[parseDb('-6'),parseDb('-inf'),parseDb('+20'),parseDb('x'),parsePan('L50'),parsePan('r 25'),parsePan('C'),parsePan('-30'),parsePan(formatPan(-.4))].map(v=>v===null?null:+v.toFixed(3));
      clip.gain=.5;clip.fadeIn=.2;clip.fadeOut=.1;t.pan=-.25;
      const before=JSON.stringify([clip.gain,clip.fadeIn,clip.fadeOut,t.pan]),file=new File([projectBlob()],'v12.audiorec'),oldAsk=ask;ask=async()=>true;
      try{await openProject(file);}finally{ask=oldAsk;}
      const c=tracks[0].clips.find(k=>k.name==='renamed'),roundTrip=!!c&&JSON.stringify([c.gain,c.fadeIn,c.fadeOut,tracks[0].pan])===before;
      return {opened,oneStep,settings,badge,shade,gained,panned,unity,parsed,roundTrip};
    }finally{if(tracks[0]===t){t.clips=clips;t.effects=effects;t.pan=pan;}renderTracks();}
  })()`);
  assert(clipPan.opened && clipPan.oneStep && JSON.stringify(clipPan.settings) === JSON.stringify(['renamed', 6, .1]) && clipPan.badge && clipPan.shade && clipPan.gained && clipPan.panned && clipPan.unity && JSON.stringify(clipPan.parsed) === JSON.stringify([.501, 0, 3.162, null, -.5, .25, 0, -.3, -.4]) && clipPan.roundTrip, `Clip dialog, clip gain/fades, track pan: ${JSON.stringify(clipPan)}`);
  // Glue (G): enabled only for overlapping/touching selected clips of a track; the glued clip renders exactly like the
  // originals (crossfade, clip gains), keeps the outer fades, takes one undo step and is selected afterwards.
  const glue = await evaluate(`(async()=>{
    const t=tracks[0],clips=t.clips,effects=t.effects,dc=(n,v)=>{const b=getContext().createBuffer(1,n,48000);b.getChannelData(0).fill(v);return b;};
    try{
      t.effects=[];t.pan=0;t.volume=1;t.muted=false;t.visible=true;
      const a={name:'A',start:1,trimStart:0,trimEnd:0,buffer:dc(4800,.5),fadeIn:.02},b={name:'B',start:1.05,trimStart:0,trimEnd:0,buffer:dc(4800,-.5),gain:.5,fadeOut:.03},far={name:'far',start:3,trimStart:0,trimEnd:0,buffer:dc(4800,.5)};
      t.clips=[a,b,far];selectedClips.clear();selectedClips.add(a);selectedClips.add(far);renderTracks();updateClipActions();const gapDisabled=document.getElementById('glue-clips').disabled;
      selectedClips.add(b);updateClipActions();const enabled=!document.getElementById('glue-clips').disabled;
      const before=(await renderMix(1,1.2,48000,1,null)).getChannelData(0).slice(),history=undoStack.length;
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'g',bubbles:true,cancelable:true}));for(let i=0;i<50&&gluing;i++)await new Promise(r=>setTimeout(r,20));
      const glued=t.clips.find(c=>c.name==='A'),after=(await renderMix(1,1.2,48000,1,null)).getChannelData(0);let diff=0;for(let i=0;i<before.length;i++)diff=Math.max(diff,Math.abs(before[i]-after[i]));
      const result={gapDisabled,enabled,count:t.clips.length,steps:undoStack.length-history,diff:+diff.toFixed(4),duration:+glued.buffer.duration.toFixed(3),fades:[glued.fadeIn,glued.fadeOut,glued.gain],selected:selectedClips.has(glued)&&selectedClips.size===2,farKept:t.clips.includes(far)};
      undo();result.undone=tracks[0].clips.length===3;return result;
    }finally{tracks[0].clips=clips;tracks[0].effects=effects;selectedClips.clear();renderTracks();}
  })()`);
  assert(glue.gapDisabled && glue.enabled && glue.count === 2 && glue.steps === 1 && glue.diff < .002 && glue.duration === .15 && JSON.stringify(glue.fades) === JSON.stringify([.02, .03, 1]) && glue.selected && glue.farKept && glue.undone, `Glue overlapping clips: ${JSON.stringify(glue)}`);
  // 48 kHz project, stereo clips: imports at other rates are resampled and keep their channels; cut, glue, clip WAV,
  // export and both kinds of saved project keep stereo; a 44.1 kHz clip in a project file is converted on open.
  const stereo = await evaluate(`(async()=>{
    const wav=(rate,channels,seconds,sample)=>{const n=Math.round(rate*seconds),data=new DataView(new ArrayBuffer(44+n*channels*2)),text=(o,t)=>[...t].forEach((c,i)=>data.setUint8(o+i,c.charCodeAt(0)));
      text(0,'RIFF');data.setUint32(4,36+n*channels*2,true);text(8,'WAVEfmt ');data.setUint32(16,16,true);data.setUint16(20,1,true);data.setUint16(22,channels,true);data.setUint32(24,rate,true);data.setUint32(28,rate*channels*2,true);data.setUint16(32,channels*2,true);data.setUint16(34,16,true);text(36,'data');data.setUint32(40,n*channels*2,true);
      for(let i=0;i<n;i++)for(let c=0;c<channels;c++)data.setInt16(44+(i*channels+c)*2,Math.round(sample(i/rate,c)*32767),true);return new File([data.buffer],'test.wav',{type:'audio/wav'});};
    const t=tracks[0],clips=t.clips,effects=t.effects,rms=(a,from=0,to=a.length)=>{let s=0;for(let i=from;i<to;i++)s+=a[i]*a[i];return Math.sqrt(s/(to-from));};
    try{
      t.effects=[];t.pan=0;t.clips=[];
      await importAudio([wav(44100,2,1,(time,c)=>c?0:.5*Math.sin(2*Math.PI*440*time))],t,1);const st=t.clips[0];
      await importAudio([wav(22050,1,.5,time=>.3*Math.sin(2*Math.PI*300*time))],t,3);const mono=t.clips[1];
      const imported=[st.buffer.sampleRate,st.buffer.numberOfChannels,+st.buffer.duration.toFixed(3),+rms(channelData(st.buffer,0)).toFixed(2),+rms(channelData(st.buffer,1)).toFixed(3),mono.buffer.sampleRate,mono.buffer.numberOfChannels,+mono.buffer.duration.toFixed(3)];
      const mix=await renderMix(1,2,48000,2,null),separated=rms(mix.getChannelData(0),4800,43200)>.3&&rms(mix.getChannelData(1),4800,43200)<.001;
      const wavOut=new DataView(clipWav(st).buffer),wavChannels=wavOut.getUint16(22,true),wavRate=wavOut.getUint32(24,true);
      selectedClips.clear();selectedClips.add(st);seekTo(1.5);cutClips();const pieces=t.clips.filter(c=>c.name.startsWith('test')&&c!==mono),cutStereo=pieces.length===2&&pieces.every(c=>c.buffer.numberOfChannels===2);
      selectedClips.clear();pieces.forEach(c=>selectedClips.add(c));await glueClips();const glued=t.clips.find(c=>c.buffer.numberOfChannels===2&&c.start===1),glueStereo=!!glued&&Math.abs(glued.buffer.duration-1)<.01;
      const saved=projectData().tracks[0].clips.find(c=>c.start===1),dbStereo=!!saved?.samplesRight&&saved.samplesRight.length===saved.samples.length;
      t.clips.push({name:'old',start:5,trimStart:0,trimEnd:0,buffer:getContext().createBuffer(1,44100,44100)});
      const file=new File([projectBlob()],'stereo.audiorec'),oldAsk=ask;ask=async()=>true;try{await openProject(file);}finally{ask=oldAsk;}
      const reopened=tracks[0].clips,back=reopened.find(c=>c.start===1),old=reopened.find(c=>c.name==='old');
      return {rate:getContext().sampleRate,imported,separated,wav:[wavChannels,wavRate],cutStereo,glueStereo,dbStereo,fileStereo:back?.buffer.numberOfChannels===2&&Math.abs(rms(channelData(back.buffer,0))-rms(channelData(glued.buffer,0)))<.001,oldConverted:[old?.buffer.sampleRate,+old?.buffer.duration.toFixed(3)]};
    }finally{if(tracks[0]===t){t.clips=clips;t.effects=effects;}selectedClips.clear();seekTo(0);renderTracks();}
  })()`);
  assert(stereo.rate === 48000 && JSON.stringify(stereo.imported) === JSON.stringify([48000, 2, 1, .35, 0, 48000, 1, .5]) && stereo.separated && JSON.stringify(stereo.wav) === JSON.stringify([2, 48000]) && stereo.cutStereo && stereo.glueStereo && stereo.dbStereo && stereo.fileStereo && JSON.stringify(stereo.oldConverted) === JSON.stringify([48000, 1]), `48 kHz project and stereo clips: ${JSON.stringify(stereo)}`);
  // A stereo clip survives the browser autosave and a reload.
  await evaluate(`(async()=>{const b=getContext().createBuffer(2,4800,48000);b.getChannelData(1).fill(.25);tracks[0].clips.push({name:'stereo-db',start:7,trimStart:0,trimEnd:0,buffer:b});await saveProject();return true})()`);
  await call('Page.reload'); await wait("!!document.querySelector('.track-fx') && !document.getElementById('add-track').disabled");
  assert(await evaluate(`(async()=>{const c=tracks[0].clips.find(c=>c.name==='stereo-db'),ok=!!c&&c.buffer.numberOfChannels===2&&Math.abs(channelData(c.buffer,1)[10]-.25)<1e-6&&channelData(c.buffer,0)[10]===0;tracks[0].clips=tracks[0].clips.filter(x=>x!==c);await saveProject();return ok})()`), 'Stereo clip survives the browser autosave');
  // Export with a pitch shifter: the dry part must land on the exact timeline sample, the wet part within its swing.
  const latency = await evaluate(`(async()=>{
    const t=tracks[0],clips=t.clips,effects=t.effects,buffer=getContext().createBuffer(1,48000,48000),data=buffer.getChannelData(0);
    for(let i=24000;i<data.length;i++)data[i]=.3*Math.sin(2*Math.PI*220*(i-24000)/48000);
    const onset=b=>{const d=b.getChannelData(0);for(let i=0;i<d.length;i++)if(Math.abs(d[i])>.05)return i;return -1;};
    t.clips=[{name:'latency',start:1,trimStart:0,trimEnd:0,buffer}];
    try{
      t.effects=[];const reference=onset(await renderMix(1,2,48000,1,null)),pitch=defaultUtilityEffect('pitch');t.effects=[pitch];
      Object.assign(pitch.settings,{semitones:7,mix:0});const dry=onset(await renderMix(1,2,48000,1,null));
      pitch.settings.mix=100;const wet=onset(await renderMix(1,2,48000,1,null));
      Object.assign(pitch.settings,{window:200,mix:0});const dryLong=onset(await renderMix(1,2,48000,1,null));
      const late=onset(await renderMix(1.2,2,48000,1,null));
      return {reference,dry,wet,dryLong,late};
    }finally{t.clips=clips;t.effects=effects;}
  })()`);
  assert(latency.reference > 24000 && latency.dry === latency.reference && latency.dryLong === latency.reference && latency.late === latency.reference - 9600 && Math.abs(latency.wet - latency.reference) <= 48 * 45, `Pitch latency compensation: ${JSON.stringify(latency)}`);
  // + and - (Italian layout codes; Shift turns + into *) move the playhead 1 s, Ctrl 10 s, Shift one frame; the arrows
  // move the selected clips the same way, stopping at 0, a held key being one undo step; Q/W/E zoom; F is full screen.
  const keys = await evaluate(`(()=>{
    timelineLength=60;seekTo(20);const press=(key,o={})=>document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...o})),at=()=>Math.round(playPosition()*1000)/1000,frame=Math.round(1000/fps)/1000;
    const plus={code:'BracketRight'},minus={code:'Slash'};
    press('+',plus);const a=at();press('-',minus);const b=at();press('+',{...plus,ctrlKey:true});const c=at();press('-',{...minus,ctrlKey:true});const d=at();
    press('*',{...plus,shiftKey:true});const e=at();press('_',{...minus,shiftKey:true});press('_',{...minus,shiftKey:true});const f=at();const recordingAfterShiftPlus=recording;
    const field=document.getElementById('timeline-length');field.focus();field.dispatchEvent(new KeyboardEvent('keydown',{key:'+',code:'BracketRight',bubbles:true,cancelable:true}));const g=at();field.blur();
    const t=tracks[0],clips=t.clips,buffer=getContext().createBuffer(1,4800,48000),clip={name:'nudge',start:5,trimStart:0,trimEnd:0,buffer};t.clips=[clip];selectedClips.clear();selectedClips.add(clip);renderTracks();
    const history=undoStack.length,pos=at();press('ArrowRight');const h=clip.start;press('ArrowRight',{ctrlKey:true});const i=clip.start;press('ArrowLeft',{shiftKey:true});const j=Math.round(clip.start*1000)/1000;
    press('ArrowLeft',{ctrlKey:true});press('ArrowLeft',{ctrlKey:true,repeat:true});const k=clip.start,steps=undoStack.length-history,playheadKept=at()===pos;
    selectedClips.clear();t.clips=clips;renderTracks();
    const zoom=document.getElementById('zoom');zoom.value=500;press('w');const zoomOut=+zoom.value;press('e');press('e');const zoomIn=+zoom.value;press('q');const whole=+zoom.value===+zoom.min;
    timelineLength=null;seekTo(0);
    return {seek:[a,b,c,d,e,f,g],expected:[21,20,30,20,Math.round((20+1/fps)*1000)/1000,Math.round((20-1/fps)*1000)/1000,Math.round((20-1/fps)*1000)/1000],recordingAfterShiftPlus,nudge:[h,i,j,k],expectedNudge:[6,16,Math.round((16-1/fps)*1000)/1000,0],steps,playheadKept,zoom:[zoomOut<500,zoomIn>zoomOut,whole]};
  })()`);
  assert(JSON.stringify(keys.seek) === JSON.stringify(keys.expected) && !keys.recordingAfterShiftPlus && JSON.stringify(keys.nudge) === JSON.stringify(keys.expectedNudge) && keys.steps === 4 && keys.playheadKept && keys.zoom.every(Boolean), `+/- seek, arrows nudge clips, Q/W/E zoom: ${JSON.stringify(keys)}`);
  // , and . jump to the export markers; the Help dialog lists every shortcut in its own tab.
  assert(await evaluate(`(()=>{
    exportIn=1.5;exportOut=3;const press=key=>document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
    press(',');const atStart=Math.abs(playPosition()-1.5)<.01;press('.');const atEnd=Math.abs(playPosition()-3)<.01;
    const field=document.getElementById('timeline-length');field.focus();field.dispatchEvent(new KeyboardEvent('keydown',{key:',',bubbles:true,cancelable:true}));const typing=Math.abs(playPosition()-3)<.01;field.blur();
    exportIn=0;exportOut=null;seekTo(0);
    const tab=document.getElementById('help-tab-keys'),panel=document.getElementById('help-keys'),keys=[...panel.querySelectorAll('kbd')].map(k=>k.textContent);
    tab.click();const shown=!panel.hidden&&document.getElementById('help-tracks').hidden;document.getElementById('help-tab-files').click();
    return atStart&&atEnd&&typing&&shown&&tab.getAttribute('aria-controls')==='help-keys'&&panel.querySelectorAll('tr').length>=24&&[',','.','I','O','Space','*','W','C','M'].every(k=>keys.includes(k));
  })()`), 'Comma and period jump to the export markers (not while typing); Help lists all shortcuts');
  // Loop toggle: playback that reaches the export end restarts at the export start; Play after the end jumps to the start.
  const loop = await evaluate(`(async()=>{
    const button=document.getElementById('loop'),off=button.getAttribute('aria-pressed')==='false';
    timelineLength=10;exportIn=1;exportOut=1.3;button.click();const on=button.getAttribute('aria-pressed')==='true'&&localStorage.getItem('audiorec-loop')==='on'&&document.getElementById('timeline').classList.contains('looping');
    seekTo(1.25);await togglePlay();await new Promise(r=>setTimeout(r,450));const position=playPosition(),playing=isPlaying();pause();
    seekTo(5);await togglePlay();const jumped=playPosition()<1.1;pause();
    button.click();seekTo(1.25);await togglePlay();await new Promise(r=>setTimeout(r,300));const unlooped=playPosition();pause();
    exportIn=0;exportOut=null;timelineLength=null;seekTo(0);
    return {off,on,position:+position.toFixed(3),playing,jumped,unlooped:+unlooped.toFixed(3),stored:localStorage.getItem('audiorec-loop')};
  })()`);
  assert(loop.off && loop.on && loop.position >= 1 && loop.position < 1.3 && loop.playing && loop.jumped && loop.unlooped > 1.4 && loop.stored === 'off', `Loop between the export markers: ${JSON.stringify(loop)}`);
  // H opens Help on the keyboard shortcuts tab.
  assert(await evaluate(`(()=>{
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'h',code:'KeyH',bubbles:true,cancelable:true}));
    const dialog=document.getElementById('help-dialog'),ok=dialog.open&&!document.getElementById('help-keys').hidden&&document.activeElement===document.getElementById('help-tab-keys');
    dialog.close();document.getElementById('help-tab-files').click();return ok;
  })()`), 'H opens Help on the shortcuts tab');
  // V shows / hides the video and clips panel, not while typing.
  assert(await evaluate(`(()=>{
    const panel=document.getElementById('video-panel'),start=panel.hidden,press=(t=document)=>t.dispatchEvent(new KeyboardEvent('keydown',{key:'v',code:'KeyV',bubbles:true,cancelable:true}));
    press();const toggled=panel.hidden!==start;const field=document.getElementById('timeline-length');field.focus();press(field);const typing=panel.hidden!==start;field.blur();press();
    return toggled&&typing&&panel.hidden===start&&document.getElementById('video-panel-toggle').title.endsWith('(V)');
  })()`), 'V toggles the video panel');
  // Single-key table: I / O set the markers, M mutes once per press (not on key repeat, not with Ctrl), C cuts, an open
  // dialog blocks them.
  const single = await evaluate(`(()=>{
    const t=tracks[0],clips=t.clips,press=(key,options={})=>document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));
    try{
      timelineLength=10;t.clips=[{name:'k',start:0,trimStart:0,trimEnd:0,muted:false,gain:1,fadeIn:0,fadeOut:0,buffer:getContext().createBuffer(1,48000*4,48000)}];renderTracks();
      seekTo(1);press('i');seekTo(3);press('o');const marks=[exportIn,exportOut];
      selectedClips.clear();selectedClips.add(t.clips[0]);press('m');const muted=t.clips[0].muted;press('m',{repeat:true});const repeatIgnored=t.clips[0].muted;press('m',{ctrlKey:true});const ctrlIgnored=t.clips[0].muted;press('M',{shiftKey:true});const shiftWorks=!t.clips[0].muted;
      document.getElementById('device-dialog').showModal();press('c');const blocked=t.clips.length===1;document.getElementById('device-dialog').close();
      seekTo(2);press('c');const cut=t.clips.length===2;
      const wasLooping=looping;press('l');const loop=looping!==wasLooping&&document.getElementById('loop').getAttribute('aria-pressed')===String(looping);press('l');
      return {marks,muted,repeatIgnored,ctrlIgnored,shiftWorks,blocked,cut,loop:loop&&looping===wasLooping};
    }finally{t.clips=clips;timelineLength=null;exportIn=0;exportOut=null;selectedClips.clear();seekTo(0);renderTracks();}
  })()`);
  // Waveform cache: a re-render reuses the clip's canvas, a duplicated clip gets its own copy, a zoom change redraws.
  const wave = await evaluate(`(()=>{
    const t=tracks.find(track=>!isHidden(track)),clips=t.clips,buffer=getContext().createBuffer(1,48000*60,48000);channelData(buffer).fill(.5);
    try{
      t.clips=[{name:'w',start:0,trimStart:0,trimEnd:0,muted:false,gain:1,fadeIn:0,fadeOut:0,buffer}];renderTracks();
      const canvas=()=>[...document.querySelectorAll('#tracks .clip .clip-wave')];const first=canvas()[0];
      let t0=performance.now();renderTracks();const cachedMs=performance.now()-t0,reused=canvas()[0]===first;
      t.clips.push({...t.clips[0],start:70});renderTracks();const [a,b]=canvas(),copied=a!==b&&a.width===b.width&&b.getContext('2d').getImageData(Math.floor(b.width/2),Math.floor(b.height/2),1,1).data[3]>0;
      t.clips.pop();const zoom=document.getElementById('zoom'),before=zoom.value;zoom.value=zoom.value===zoom.min?zoom.max:zoom.min;renderTracks();const redrawn=canvas()[0]!==first;zoom.value=before;
      return {reused,copied,redrawn,cachedMs:+cachedMs.toFixed(1)};
    }finally{t.clips=clips;renderTracks();}
  })()`);
  assert(wave.reused && wave.copied && wave.redrawn, `Waveform cache: ${JSON.stringify(wave)}`);
  assert(JSON.stringify(single.marks) === '[1,3]' && single.muted && single.repeatIgnored && single.ctrlIgnored && single.shiftWorks && single.blocked && single.cut && single.loop, `Single-key shortcuts: ${JSON.stringify(single)}`);
  // Recording: direct track capture where available, AudioWorklet otherwise; the take must match the elapsed time.
  for (const direct of [true, false]) {
    const take = await evaluate(`(async()=>{
      const saved=window.MediaStreamTrackProcessor;if(!${direct})window.MediaStreamTrackProcessor=undefined;
      try{
        const t=tracks[0],before=t.clips.length;tracks.forEach(x=>x.armed=x===t);t.muted=false;t.visible=true;
        await toggleRecording();if(!recording)return {error:'not recording'};const capture=recorder,from=performance.now();
        await new Promise(r=>setTimeout(r,1500));const elapsed=(performance.now()-from)/1000;await toggleRecording();
        const clip=t.clips[before];if(!clip)return {error:'no clip',kind:capture.kind};
        const data=clip.buffer.getChannelData(0);let finite=true,peak=0;for(const v of data){if(!Number.isFinite(v))finite=false;peak=Math.max(peak,Math.abs(v));}
        const result={kind:capture.kind,gaps:capture.gaps,duration:clip.buffer.duration,elapsed,rate:clip.buffer.sampleRate,finite,peak};
        t.clips.splice(before,1);renderTracks();return result;
      }finally{window.MediaStreamTrackProcessor=saved;if(isPlaying())pause();}
    })()`);
    assert(!take.error && take.kind === (direct ? 'track' : 'worklet') && take.finite && take.peak > 0 && take.rate >= 8000 && take.gaps === 0 && Math.abs(take.duration - take.elapsed) < .25, `Recording ${direct ? 'track processor' : 'worklet fallback'}: ${JSON.stringify(take)}`);
  }
  assert(await evaluate(`(async()=>{await prepareTrackEffects(getContext(),tracks);startOvertime();pause();await new Promise(r=>setTimeout(r,80));return !isPlaying()&&playingSources.length===0})()`),'Paused playback cancels async effect preparation');
  await call('Page.navigate', { url: new URL('tools/check-eq-browser.html', baseURL).href });
  await wait("document.getElementById('result')?.textContent?.startsWith('PASS') || document.getElementById('result')?.textContent?.startsWith('FAIL')");
  const dsp = await evaluate("document.getElementById('result').textContent"); assert(dsp.startsWith('PASS'), dsp);
  assert.deepEqual(errors, [], 'No browser runtime exceptions');
  console.log('PASS: film visibility toggle and layout persistence; effects list, separate EQ, editable knobs, keyboard/pointer input, sortable order, backdrops, desktop/mobile sizing, undo, autosave restore; compressor and utility knobs, bypass, mixed ordering, presets, export, worklet preparation and project round-trip.');
  console.log(dsp);
} finally {
  socket?.close(); chrome.kill(); server.closeAllConnections(); server.close(); await sleep(500); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
