// Reproducible locale coverage / integrity check: node tools/check-it.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync('app/index.html','utf8');
const js = readFileSync('app/app.js','utf8');
const landing = readFileSync('index.html','utf8');
const names={it:'Italiano',es:'Español',ru:'Русский',zh:'简体中文'};
const load=code=>{ let locale; vm.runInNewContext(readFileSync(`app/locales/${code}.js`,'utf8'),{I18N:{register:(c,name,strings,html)=>locale={code:c,name,strings,html}}}); return locale; };
const scripts=[...source.matchAll(/<script src="([^"]+)"><\/script>/g)].map(([,path])=>path);
assert.ok(scripts.indexOf('i18n.js')>=0 && scripts.at(-1)==='app.js');
for(const code of Object.keys(names)) assert.ok(scripts.indexOf(`locales/${code}.js`)>scripts.indexOf('i18n.js') && scripts.indexOf(`locales/${code}.js`)<scripts.indexOf('app.js'),code+' script order');
const literal = String.raw`'((?:\\.|[^'\\])*)'`, unquote = v => v.replace(/\\(.)/g,'$1');
const plural = [...js.matchAll(new RegExp(String.raw`\btrn\(\s*${literal}\s*,\s*${literal}`,'g'))].map(([,one,other])=>[unquote(one),unquote(other)]);
const codeKeys = [...js.matchAll(new RegExp(String.raw`\btr\(\s*${literal}`,'g'))].map(([,key])=>unquote(key));
let page = source.slice(source.indexOf('<body'),source.indexOf('</body>')).replace(/<!--[\s\S]*?-->/g,'').replace(/<(svg|script|style)\b[\s\S]*?<\/\1>/g,'');
const blocks = new Map([...page.matchAll(/<(\w+)\b[^>]*\bdata-i18n-html="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)].map(([,tag,id,text])=>[id,text]));
page = page.replace(/<(\w+)\b[^>]*\bdata-i18n-html="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g,'');
const decode = text => text.replace(/&(#x?[0-9a-f]+|\w+);/gi,(match,name)=>name[0]==='#'?String.fromCodePoint(parseInt(name.slice(1).replace(/^x/i,''),name[1].toLowerCase()==='x'?16:10)):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name]??match));
const normalize = text => text.replace(/\s+/g,' ').trim();
const keys = new Set([...plural.map(([one])=>one),...codeKeys]);
for(const [, ,text] of page.matchAll(/\s(title|aria-label|placeholder)="([^"]*)"/g)) { const key=normalize(decode(text)); if(/[a-z]/i.test(key)) keys.add(key); }
for(const [,text] of page.matchAll(/>([^<]+)</g)) { const key=normalize(decode(text)); if(/[a-z]/i.test(key)) keys.add(key); }
assert.equal(keys.size,309); assert.equal(blocks.size,22);
assert.match(source, /<header class="topbar">[\s\S]*?id="language-button"[^>]*popovertarget="language-menu"/);
assert.match(source, /id="language-menu"[^>]*popover/);
assert.match(source, /id="language-options"/);
assert.doesNotMatch(source, /id="language-field"|id="language"/);
assert.match(js, /language-options'\)\.replaceChildren\(\.\.\.I18N\.languages\(\)/);
assert.match(js, /button\.onclick = \(\) => I18N\.setLanguage\(code\)/);
assert.match(landing, /<header class="topbar">[\s\S]*?<button id="language-button"[^>]*popovertarget="language-menu"[\s\S]*?<div id="language-menu" class="menu" popover aria-label="Language"><span class="menu-label">Language<\/span>/);
assert.doesNotMatch(landing, /<select id="language"/);
assert.deepEqual([...landing.matchAll(/<button class="menu-item" type="button" lang="([a-z]+)" data-language="\1" translate="no">/g)].map(([,code])=>code),['en','it','es','ru','zh']);
assert.match(landing, /localStorage\.getItem\('audiorec-language'\)/);
assert.match(landing, /localStorage\.setItem\('audiorec-language', code\)/);
assert.match(readFileSync('app/i18n.js','utf8'), /localStorage\.getItem\('audiorec-language'\)/);
assert.match(readFileSync('app/i18n.js','utf8'), /localStorage\.setItem\('audiorec-language', code\)/);
const placeholders = text => [...text.matchAll(/\{\w+\}/g)].map(([x])=>x).sort();
const shortcuts = text => [...text.matchAll(/\((?:Ctrl\+Shift\+Z|Ctrl\+Z|Ctrl\+Y|Space|Esc|Del|Shift\+click|double-click|drag|\*|[A-Z])\)/g)].map(([x])=>x).sort();
const tags = html => [...html.matchAll(/<\/?(?:kbd|code|strong)>/g)].map(([x])=>x).sort();
const kbd = html => [...html.matchAll(/<kbd>(.*?)<\/kbd>/g)].map(([,x])=>x).sort();
const codeTags = html => [...html.matchAll(/<code>(.*?)<\/code>/g)].map(([,x])=>x).sort();
for(const code of Object.keys(names)) {
const locale=load(code);
assert.equal(locale.code,code); assert.equal(locale.name,names[code]);
assert.deepEqual(Object.keys(locale.strings).sort(),[...keys].sort(),code+' keys');
assert.deepEqual(Object.keys(locale.html).sort(),[...blocks.keys()].sort(),code+' HTML keys');
const forms=code==='it'?['one','other']:[...new Intl.PluralRules(code).resolvedOptions().pluralCategories].sort(); // Existing Italian plural forms remain unchanged.
for(const key of keys) {
  const value=locale.strings[key];
  if(plural.some(([one])=>one===key)) {
    assert.deepEqual(Object.keys(value).sort(),forms,code+': '+key);
    const other=plural.find(([one])=>one===key)[1];
    for(const form of forms) { const text=form==='one'?key:other; assert.ok(value[form],code+': '+key+form); assert.deepEqual(placeholders(value[form]),placeholders(text),code+': '+key+form); assert.deepEqual(shortcuts(value[form]),shortcuts(text),code+': '+key+form); }
  } else { assert.equal(typeof value,'string',key); assert.ok(value,key); assert.deepEqual(placeholders(value),placeholders(key),key); assert.deepEqual(shortcuts(value),shortcuts(key),key); }
}
for(const [id,original] of blocks) { const value=locale.html[id]; assert.ok(value,id); assert.deepEqual(tags(value),tags(original),code+': '+id+' tags'); assert.deepEqual(kbd(value),kbd(original),code+': '+id+' keys'); assert.deepEqual(codeTags(value),codeTags(original),code+': '+id+' code'); assert.deepEqual(placeholders(value),placeholders(original),code+': '+id+' placeholders'); assert.equal(/<[^>]*\bon\w+=|<script|javascript:/i.test(value),false,code+': '+id+' unsafe markup'); assert.doesNotMatch(value,/⟦|\[\[/,code+': '+id+' draft markers'); }
for(const [key,value] of Object.entries(locale.strings)) for(const text of typeof value==='string'?[value]:Object.values(value)) assert.doesNotMatch(text,/⟦|\[\[/,code+': '+key+' draft markers');
assert.equal(new Intl.Locale(code==='zh'?'zh-CN':code).textInfo.direction,'ltr',code+' direction');
if(code==='it') { assert.equal(locale.strings['Play'],'Riproduci'); assert.equal(locale.strings['Play (Space)'],'Riproduci (Space)'); }
if(code==='es') { assert.equal(locale.strings['Record'],'Grabar'); assert.equal(locale.strings['Play'],'Reproducir'); assert.match(locale.strings['No audible recordings to export.'],/audibles/); }
if(code==='ru') { assert.equal(locale.strings['Play'],'Воспроизвести'); assert.match(locale.strings['{count} clip'].few,/клипа/); assert.match(locale.strings['{count} clip'].many,/клипов/); assert.match(locale.strings['No audible recordings to export.'],/слышимых записей/); }
if(code==='zh') { assert.equal(locale.strings['Play'],'播放'); assert.equal(locale.strings['Record'],'录音'); assert.equal(locale.strings['Export'],'导出'); }
console.log(`OK ${code}: ${keys.size} strings, ${blocks.size} HTML blocks, ${plural.length} plural uses; placeholders, shortcuts, markup, keys and script order.`);
}
const landingScript=landing.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(landingScript,'landing inline script');
const table=vm.runInNewContext('('+landingScript.match(/const LANDING = (\{[\s\S]*?\});\s*const button/)?.[1]+')');
const landingKeys=Object.keys(table.it);
for(const code of Object.keys(names)) {
  assert.deepEqual(Object.keys(table[code]).sort(),landingKeys.sort(),code+' landing keys');
  assert.ok(Object.keys(table[code]).length>=55,code+' landing copy coverage');
  for(const [key,text] of Object.entries(table[code])) {
    assert.ok(text.trim(),code+': '+key+' landing text');
    if(['hero','lead','step-record','frames','projects',...['shortcut-play','shortcut-record','shortcut-fullscreen','shortcut-zoom','shortcut-delete','shortcut-undo']].includes(key)) {
      const original=landing.match(new RegExp(`<[^>]+data-landing-key="${key}"[^>]*>([^\\n]*?)<\\/(?:h1|p|div)>`))?.[1];
      assert.ok(original,code+': '+key+' source');
      assert.deepEqual(tags(text),tags(original),code+': '+key+' landing markup');
      assert.deepEqual(kbd(text),kbd(original),code+': '+key+' landing shortcuts');
      assert.deepEqual(codeTags(text),codeTags(original),code+': '+key+' landing code');
      assert.doesNotMatch(text,/<script|javascript:|\bon\w+\s*=/i,code+': '+key+' unsafe markup');
    }
  }
}
console.log(`OK landing: ${landingKeys.length} copy keys × 4 locales, 5 selectable languages, shared storage key, structural UI and shortcut checks.`);
