// Translation helper for the Audiorec interface (no dependencies, Node 18+).
//
//   node tools/i18n.mjs                    report, for every locale, the strings it is missing or no longer uses
//   node tools/i18n.mjs new <code> <Name>  create app/locales/<code>.js with every string to translate, and load it in
//                                          app/index.html (e.g. node tools/i18n.mjs new it Italiano)
//   node tools/i18n.mjs update <code>      add the missing strings to an existing locale (empty = not translated yet)
//                                          and drop the unused ones; existing translations are kept
//
// Source strings come from tr()/trn() calls in app/app.js and from app/index.html (text, title, aria-label,
// placeholder, and data-i18n-html blocks). An empty translation falls back to English at runtime.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const read = file => readFileSync(join(root, file), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ').trim();
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = text => text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, name) => name[0] === '#'
  ? String.fromCodePoint(parseInt(name.slice(1).replace(/^x/i, ''), name[1].toLowerCase() === 'x' ? 16 : 10))
  : ENTITIES[name] ?? match);
const literal = String.raw`'((?:\\.|[^'\\])*)'`;
const unquote = text => text.replace(/\\(.)/g, '$1');

function sourceStrings() {
  const strings = new Map(), html = new Map();
  const add = (key, value = '') => { if (/[a-z]/i.test(key) && !strings.has(key)) strings.set(key, value); };
  const code = ['app.js', 'eq.js', 'compressor.js', 'effects.js'].map(read).join('\n');
  for (const [, one] of code.matchAll(new RegExp(String.raw`\btrn\(\s*${literal}`, 'g'))) add(unquote(one), { one: '', other: '' });
  for (const [, key] of code.matchAll(new RegExp(String.raw`\btr\(\s*${literal}`, 'g'))) add(unquote(key));
  let page = read('index.html');
  page = page.slice(page.indexOf('<body'), page.indexOf('</body>'))
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<(svg|script|style)\b[\s\S]*?<\/\1>/g, '');
  page = page.replace(/<(\w+)\b[^>]*\bdata-i18n-html="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g, (match, tag, id, inner) => { html.set(id, inner); return ''; });
  for (const [, , value] of page.matchAll(/\s(title|aria-label|placeholder)="([^"]*)"/g)) add(normalize(decode(value)));
  for (const [, text] of page.matchAll(/>([^<]+)</g)) add(normalize(decode(text)));
  return { strings, html };
}

function loadLocale(code) {
  const file = join(root, 'locales', `${code}.js`);
  if (!existsSync(file)) throw new Error(`app/locales/${code}.js does not exist`);
  let locale = null;
  vm.runInNewContext(readFileSync(file, 'utf8'), { I18N: { register: (c, name, strings = {}, html = {}) => { locale = { code: c, name, strings, html }; } } });
  if (!locale) throw new Error(`app/locales/${code}.js does not call I18N.register`);
  return locale;
}
const locales = () => existsSync(join(root, 'locales')) ? readdirSync(join(root, 'locales')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort() : [];
const translated = value => typeof value === 'string' ? value !== '' : !!value && Object.values(value).some(Boolean);

function writeLocale({ code, name }, strings, html) {
  const q = value => JSON.stringify(value);
  const lines = [...strings].map(([key, value]) => typeof value === 'object'
    ? `  ${q(key)}: { ${Object.entries(value).map(([form, text]) => `${form}: ${q(text)}`).join(', ')} },`
    : `  ${q(key)}: ${q(value)},`);
  const blocks = [...html].map(([id, value]) => `  ${q(id)}: ${q(value)},`);
  mkdirSync(join(root, 'locales'), { recursive: true });
  writeFileSync(join(root, 'locales', `${code}.js`), `// ${name} interface strings. Keys are the English source text; an empty value shows the English text.
// Plural entries use Intl.PluralRules forms (one, few, many, other...). Regenerate the key list with
// \`node tools/i18n.mjs update ${code}\`; the second object holds the HTML blocks of index.html marked data-i18n-html.
I18N.register(${q(code)}, ${q(name)}, {
${lines.join('\n')}
}, {
${blocks.join('\n')}
});
`);
}

function merge(locale, source) {
  const strings = new Map([...source.strings].map(([key, empty]) => {
    const old = locale.strings[key];
    if (typeof empty === 'object') return [key, old && typeof old === 'object' ? { one: '', other: '', ...old } : { one: '', other: '' }];
    return [key, typeof old === 'string' ? old : ''];
  }));
  const html = new Map([...source.html.keys()].map(id => [id, typeof locale.html[id] === 'string' ? locale.html[id] : '']));
  return { strings, html };
}

const [command, code, ...name] = process.argv.slice(2);
const source = sourceStrings();
if (command === 'new') {
  if (!/^[a-z]{2,3}$/.test(code || '') || !name.length) throw new Error('usage: node tools/i18n.mjs new <code> <Name>');
  if (existsSync(join(root, 'locales', `${code}.js`))) throw new Error(`app/locales/${code}.js already exists; use update`);
  const { strings, html } = merge({ strings: {}, html: {} }, source);
  writeLocale({ code, name: name.join(' ') }, strings, html);
  const index = read('index.html'), tag = `<script src="locales/${code}.js"></script>`;
  if (!index.includes(tag)) writeFileSync(join(root, 'index.html'), index.replace('<script src="app.js"></script>', `${tag}\n  <script src="app.js"></script>`));
  console.log(`Created app/locales/${code}.js with ${strings.size} strings and ${html.size} HTML blocks to translate.`);
} else if (command === 'update') {
  const locale = loadLocale(code), { strings, html } = merge(locale, source);
  writeLocale(locale, strings, html);
  console.log(`Updated app/locales/${code}.js: ${strings.size} strings, ${html.size} HTML blocks.`);
} else if (!command) {
  console.log(`Source: ${source.strings.size} strings, ${source.html.size} HTML blocks.`);
  const index = read('index.html');
  for (const c of locales()) {
    const locale = loadLocale(c);
    const missing = [...source.strings.keys()].filter(key => !translated(locale.strings[key]));
    const missingHtml = [...source.html.keys()].filter(id => !locale.html[id]);
    const unused = [...Object.keys(locale.strings).filter(key => !source.strings.has(key)), ...Object.keys(locale.html).filter(id => !source.html.has(id))];
    console.log(`\n${c} (${locale.name}): ${source.strings.size - missing.length}/${source.strings.size} strings, ${source.html.size - missingHtml.length}/${source.html.size} HTML blocks translated${index.includes(`src="locales/${c}.js"`) ? '' : ' - NOT loaded in index.html'}`);
    for (const key of missing) console.log(`  missing: ${key}`);
    for (const id of missingHtml) console.log(`  missing HTML block: ${id}`);
    for (const key of unused) console.log(`  unused: ${key}`);
  }
  if (!locales().length) console.log('No locales yet: node tools/i18n.mjs new <code> <Name>');
} else throw new Error(`unknown command ${command}`);
