// Theme checks (Node 18+, no dependencies): node tools/check-theme.mjs
// 1. app/theme.js in a fake browser: mode vs scheme, defaults, storage, live OS changes only in System mode.
// 2. app/style.css: every theme defines the same color tokens, components use tokens only, WCAG contrast of key pairs,
//    and a color-vision simulation heuristic for the accessible state colors (a sanity check, not a certification).
// 3. Wiring: header theme menu next to Language, theme.js before the stylesheet, translated labels, canvas tokens.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const read = file => readFileSync(join(root, file), 'utf8');
const themeSource = read('theme.js'), css = read('style.css'), html = read('index.html'), js = read('app.js');
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
// JSON round trip: values from the vm context have another realm's prototypes.
const eq = (actual, expected, message) => { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, message); checks++; };

// 1. theme.js
function browser({ stored, prefersLight = false, storage = true } = {}) {
  const data = new Map(stored === undefined ? [] : [['audiorec-theme', stored]]), mediaListeners = [], windowListeners = {};
  const localStorage = {
    getItem: key => { if (!storage) throw new Error('blocked'); return data.has(key) ? data.get(key) : null; },
    setItem: (key, value) => { if (!storage) throw new Error('blocked'); data.set(key, String(value)); },
    removeItem: key => { if (!storage) throw new Error('blocked'); data.delete(key); },
  };
  const media = { matches: prefersLight, addEventListener: (type, listener) => mediaListeners.push(listener) };
  const context = {
    localStorage, document: { documentElement: { dataset: {} } },
    matchMedia: query => { assert.equal(query, '(prefers-color-scheme: light)'); return media; },
    addEventListener: (type, listener) => (windowListeners[type] ??= []).push(listener),
  };
  vm.runInNewContext(`${themeSource}\nthis.THEME = THEME;`, context);
  return {
    THEME: context.THEME, data, dataset: context.document.documentElement.dataset,
    os(light) { media.matches = light; for (const listener of mediaListeners) listener({ matches: light }); },
    otherTab(newValue) { for (const listener of windowListeners.storage || []) listener({ key: 'audiorec-theme', newValue }); },
  };
}
{
  const { THEME } = browser();
  eq(THEME.MODES, ['system', 'dark', 'light', 'accessible'], 'modes');
  for (const value of [null, undefined, '', 'blue', 'Dark', 'SYSTEM', '{}']) eq(THEME.normalize(value), 'system', `normalize ${value}`);
  for (const mode of THEME.MODES) eq(THEME.normalize(mode), mode, `normalize ${mode}`);
  eq([THEME.resolve('system', true), THEME.resolve('system', false)], ['light', 'dark'], 'system follows the OS');
  for (const light of [true, false]) eq(['dark', 'light', 'accessible'].map(mode => THEME.resolve(mode, light)), ['dark', 'light', 'accessible'], 'explicit modes ignore the OS');
  eq(THEME.resolve('bogus', true), 'light', 'invalid mode resolves as system');
}
for (const [stored, prefersLight, scheme] of [[undefined, false, 'dark'], [undefined, true, 'light'], ['nonsense', true, 'light'], ['nonsense', false, 'dark'], ['dark', true, 'dark'], ['light', false, 'light'], ['accessible', true, 'accessible'], ['system', true, 'light']]) {
  const { THEME, dataset } = browser({ stored, prefersLight });
  eq([dataset.theme, dataset.themeMode, THEME.scheme], [scheme, THEME.normalize(stored), scheme], `start: stored ${stored}, OS ${prefersLight ? 'light' : 'dark'}`);
}
{
  const page = browser({ prefersLight: false }), events = [];
  page.THEME.onChange((scheme, mode, changed) => events.push([scheme, mode, changed]));
  page.os(true); eq(page.dataset.theme, 'light', 'System mode follows a live OS change to light');
  page.os(false); eq(page.dataset.theme, 'dark', 'System mode follows a live OS change to dark');
  eq(page.data.has('audiorec-theme'), false, 'OS changes never write storage');
  page.THEME.setMode('accessible');
  eq([page.dataset.theme, page.dataset.themeMode, page.data.get('audiorec-theme')], ['accessible', 'accessible', 'accessible'], 'explicit mode is stored');
  page.os(true); page.os(false); eq(page.dataset.theme, 'accessible', 'explicit mode is stable across OS changes');
  page.THEME.setMode('light'); page.os(false); eq(page.dataset.theme, 'light', 'Light stays light on a dark OS');
  page.THEME.setMode('system'); eq([page.dataset.theme, page.data.has('audiorec-theme')], ['dark', false], 'System clears the stored mode and resolves now');
  page.THEME.setMode('purple'); eq(page.THEME.mode, 'system', 'invalid setMode falls back to system');
  eq(events.slice(0, 3), [['light', 'system', true], ['dark', 'system', true], ['accessible', 'accessible', true]], 'listeners get scheme, mode and whether the scheme changed');
}
{
  const page = browser({ storage: false, prefersLight: true });
  eq(page.dataset.theme, 'light', 'blocked storage: System still works');
  page.THEME.setMode('dark'); eq([page.dataset.theme, page.THEME.mode], ['dark', 'dark'], 'blocked storage: choice applies to this page');
}
{
  const page = browser({ stored: 'dark', prefersLight: true });
  page.otherTab('accessible'); eq(page.dataset.theme, 'accessible', 'another tab changing the mode is followed');
  page.otherTab(null); eq([page.THEME.mode, page.dataset.theme], ['system', 'light'], 'another tab clearing the mode returns to System');
}
ok(!/indexedDB|audio-sopra-video/.test(themeSource), 'theme.js does not touch the project database');

// 2. style.css
const block = selector => { const start = css.indexOf(`${selector}{`); ok(start >= 0, `${selector} block`); return css.slice(start, css.indexOf('}', css.indexOf('--', start)) + 1); };
const tokens = text => Object.fromEntries([...text.matchAll(/(--[\w-]+):([^;}]+)/g)].map(([, name, value]) => [name, value.trim()]));
const themes = { dark: tokens(block(':root')), light: tokens(block(':root[data-theme=light]')), accessible: tokens(block(':root[data-theme=accessible]')) };
const LAYOUT = new Set(['--radius', '--radius-sm', '--font', '--mono']), colorTokens = Object.keys(themes.dark).filter(name => !LAYOUT.has(name));
for (const name of ['light', 'accessible']) eq(Object.keys(themes[name]).sort(), colorTokens.sort(), `${name} defines every color token`);
const end = css.indexOf('--bg-glow:none}') + '--bg-glow:none}'.length, components = css.slice(end);
eq(components.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi), null, 'components use tokens, not raw colors');
for (const [, name] of css.matchAll(/var\((--[\w-]+)/g)) if (!['--track-color', '--clip', '--swatch', '--tone', '--grid', '--row', '--ruler', '--mix', '--video-row', '--video-height'].includes(name)) ok(name in themes.dark, `${name} is defined`);
ok(/@media \(prefers-reduced-motion:reduce\)\{[^}]*animation-duration:\.01ms!important/.test(css), 'reduced motion stops animations');
ok(/:root\[data-theme=accessible\] :focus-visible[^{]*\{outline:3px solid var\(--focus\)/.test(css), 'accessible focus outline');
ok(/:root\[data-theme=accessible\] \.track-head-bottom button\[aria-pressed=true\]::after\{content:"✓"/.test(css), 'REC and Mute show a check mark when on');
ok(/:root\[data-theme=accessible\] \.clip\.muted-clip\{[^}]*border-style:dashed[^}]*repeating-linear-gradient/.test(css), 'muted clips are hatched and dashed');
ok(/attr\(data-state\)/.test(css) && (js.match(/dataset\.state = tr\('muted'\)/g) || []).length === 2, 'muted clips carry a text label');
ok(/\.menu-item\[aria-current=true\]::after\{content:"✓"/.test(css), 'current menu item has a check mark');

const hex = value => { const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value), h = m && (m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]); return h && [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const linear = c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const color = (theme, name) => { const value = themes[theme][name], rgb = hex(value) ?? hex(themes[theme][value?.match(/^var\((--[\w-]+)\)$/)?.[1]]); ok(rgb, `${theme} ${name} is a hex color`); return rgb; };
const gradientStops = (theme, name) => [...themes[theme][name].matchAll(/#[0-9a-f]{6}/gi)].map(([stop]) => hex(stop));
const report = [];
function need(theme, fg, backgrounds, min) {
  for (const bg of backgrounds) {
    const ratio = contrast(color(theme, fg), color(theme, bg));
    report.push(`${theme.padEnd(10)} ${fg.padEnd(12)} on ${bg.padEnd(14)} ${ratio.toFixed(2)}`);
    ok(ratio >= min, `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}, needs ${min}`);
  }
}
const SURFACES = ['--bg', '--surface-solid', '--raised', '--well', '--field'];
need('light', '--text', SURFACES, 7); need('light', '--subtle', SURFACES, 4.5); need('light', '--muted', SURFACES, 4.5);
for (const fg of ['--accent', '--accent-2', '--rec-text', '--warn-text', '--ok', '--focus']) need('light', fg, ['--surface-solid', '--raised', '--well'], 4.5);
need('light', '--warn', ['--surface-solid'], 3); // playhead and meters: graphics, 3:1
need('accessible', '--text', SURFACES, 7); need('accessible', '--subtle', SURFACES, 7); need('accessible', '--muted', SURFACES, 7);
for (const fg of ['--accent', '--accent-2', '--rec', '--rec-text', '--warn-text', '--ok', '--focus']) need('accessible', fg, ['--bg', '--raised'], 7);
need('accessible', '--line', ['--bg', '--surface-solid'], 4.5); need('accessible', '--line-strong', ['--raised'], 7);
need('dark', '--text', SURFACES, 7); // the existing dark theme is kept as it was; only its main text is asserted
for (const [theme, gradient] of [['light', '--accent-grad'], ['light', '--rec-grad'], ['accessible', '--accent-grad'], ['accessible', '--rec-grad']])
  for (const stop of gradientStops(theme, gradient)) { const ratio = contrast(color(theme, '--on-accent'), stop); report.push(`${theme.padEnd(10)} --on-accent  on ${gradient} stop ${ratio.toFixed(2)}`); ok(ratio >= (theme === 'accessible' ? 7 : 4.5), `${theme}: --on-accent on ${gradient} is ${ratio.toFixed(2)}`); }
// Color-vision simulation (Machado et al. 2009, severity 1) on the accessible state colors: every pair must stay apart
// by lightness or by simulated color. The pairs are the ones that carry meaning: meter safe / loud / clipping and
// REC vs monitoring (--ok and --accent are both blue on purpose). Heuristic only.
const MACHADO = {
  protanopia: [[.152286, 1.052583, -.204868], [.114503, .786281, .099216], [-.003882, -.048116, 1.051998]],
  deuteranopia: [[.367322, .860646, -.227968], [.280085, .672501, .047413], [-.011820, .042940, .968881]],
  tritanopia: [[1.255528, -.076749, -.178779], [-.078411, .930809, .147602], [.004733, .691367, .303900]],
};
const simulate = (rgb, matrix) => { const lin = rgb.map(linear); return matrix.map(row => Math.min(1, Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]))); };
const distance = (a, b) => Math.hypot(...a.map((v, i) => Math.cbrt(v) - Math.cbrt(b[i])));
const PAIRS = [['--rec', '--ok'], ['--rec', '--warn'], ['--ok', '--warn']];
for (const [vision, matrix] of Object.entries(MACHADO)) for (const [first, second] of PAIRS) {
  const a = color('accessible', first), b = color('accessible', second), apart = distance(simulate(a, matrix), simulate(b, matrix));
  report.push(`accessible ${vision.padEnd(13)} ${first} vs ${second} ${apart.toFixed(3)}`);
  ok(apart >= .12 || contrast(a, b) >= 1.6, `accessible ${vision}: ${first} vs ${second} too close (${apart.toFixed(3)})`);
}

// 3. Wiring
ok(html.indexOf('<script src="theme.js"></script>') > 0 && html.indexOf('<script src="theme.js"></script>') < html.indexOf('href="style.css"') && html.indexOf('theme.js') < html.indexOf('<body'), 'theme.js runs in <head> before the stylesheet');
ok(/<div class="header-actions"><button id="language-button"[^]*?<\/button><button id="theme-button"[^>]*popovertarget="theme-menu"/.test(html), 'Theme button sits right after Language in the header');
ok(/id="theme-menu" class="menu language-menu" popover aria-label="Theme"[^]*?id="theme-options"/.test(html), 'theme menu markup');
ok(/<symbol id="i-theme"/.test(html), 'theme icon');
ok(/#project-menu, #language-menu, #theme-menu/.test(js), 'theme menu anchored like the other header menus');
ok(/THEME\.onChange\([^)]*\) => \{ renderThemeMenu\(\); if \(changed\) \{ videoWave\.scale = 0; renderTracks\(\); \} \}\)/.test(js), 'scheme change redraws waveforms');
for (const name of ['--wave', '--wave-video', '--wave-rec']) ok(js.includes(`themeColor('${name}')`) && name in themes.dark, `canvas uses ${name}`);
eq(js.match(/fillStyle = '[^']*'/g), null, 'no hard-coded canvas colors');
ok(/const TRACK_COLORS = \[\[tr\('Violet'\), '#8b7bff'\]/.test(js), 'stored track colors are unchanged');
// The theme lives only in localStorage: the project database, snapshot and .audiorec file never see it.
const body = name => { const start = js.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); ok(start >= 0, name); return js.slice(start, js.indexOf('\n}\n', start)); };
for (const name of ['projectData', 'saveProject', 'restoreProject', 'projectBlob', 'openProject']) ok(!/theme/i.test(body(name)), `${name} does not store the theme`);
ok(/indexedDB\.open\('audio-sopra-video', 1\)/.test(js), 'project database name and version unchanged');
const labels = ['Theme', 'System', 'Dark', 'Light', 'Accessible', 'Now: {theme}', 'High contrast, clear focus, labeled states', 'Theme: {theme}.', 'muted', 'System follows the light or dark setting of your device.'];
for (const code of ['it', 'es', 'ru', 'zh']) {
  let strings = null;
  vm.runInNewContext(read(`locales/${code}.js`), { I18N: { register: (c, name, s) => { strings = s; } } });
  for (const label of labels) ok(typeof strings[label] === 'string' && strings[label] && (label.includes('{theme}') ? strings[label].includes('{theme}') : true), `${code}: ${label}`);
}

if (process.argv.includes('--report')) console.log(report.join('\n'));
console.log(`OK theme: ${checks} checks (theme.js modes and OS sync, ${colorTokens.length} tokens × 3 themes, ${report.length} contrast / color-vision pairs, menu wiring, ${labels.length} labels × 4 locales).`);
