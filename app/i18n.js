// Interface translations. English is the source language and the English text is the key: a string without a translation
// simply shows in English. Each file in locales/ calls I18N.register(); `node tools/i18n.mjs` lists what each one misses.
//
// - In code: tr('Clip renamed: {name}.', { name }) and trn('{count} clip removed.', '{count} clips removed.', count).
// - In index.html: text nodes and title / aria-label / placeholder attributes are translated in place; paragraphs with
//   inline markup carry data-i18n-html="<id>" and are replaced whole by the locale's html[id].
const I18N = (() => {
  const locales = {}, sources = new Map(), ATTRIBUTES = ['title', 'aria-label', 'placeholder'];
  let language = null;
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  function current() {
    if (language) return language;
    let saved = null;
    try { saved = localStorage.getItem('audiorec-language'); } catch {}
    language = 'en';
    for (const code of [saved, ...(navigator.languages || [navigator.language])]) {
      const base = code?.toLowerCase().split('-')[0];
      if (base && (base === 'en' || locales[base])) { language = base; break; }
    }
    return language;
  }
  const fill = (text, params) => text.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
  // Remembers which source string produced a shown text, so callers can still recognise a message after translation.
  function track(text, key) {
    sources.set(text, key);
    if (sources.size > 200) sources.delete(sources.keys().next().value);
    return text;
  }
  function tr(key, params = {}) {
    const value = locales[current()]?.strings[key];
    return track(fill(typeof value === 'string' && value ? value : key, params), key);
  }
  function trn(one, other, count, params = {}) {
    const code = current(), value = locales[code]?.strings[one], all = { count, ...params };
    if (value && typeof value === 'object') {
      const form = value[new Intl.PluralRules(code).select(count)] || value.other;
      if (form) return track(fill(form, all), one);
    }
    return track(fill(count === 1 ? one : other, all), one);
  }
  function translatePage(root = document.body) {
    const code = current();
    document.documentElement.lang = code;
    const locale = locales[code];
    if (!locale) return;
    const { strings, html = {} } = locale;
    for (const element of root.querySelectorAll('[data-i18n-html]')) { const value = html[element.dataset.i18nHtml]; if (value) element.innerHTML = value; }
    const skip = node => node.parentElement.closest('[data-i18n-html], svg, script, style, [translate="no"]');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => skip(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let node; (node = walker.nextNode());) {
      const text = normalize(node.data), value = strings[text];
      if (text && typeof value === 'string' && value) node.data = node.data.replace(node.data.trim(), value);
    }
    for (const name of ATTRIBUTES) for (const element of root.querySelectorAll(`[${name}]`)) {
      const value = strings[normalize(element.getAttribute(name))];
      if (typeof value === 'string' && value) element.setAttribute(name, value);
    }
  }
  return {
    register(code, name, strings, html = {}) { locales[code] = { name, strings, html }; },
    languages: () => [['en', 'English'], ...Object.entries(locales).map(([code, locale]) => [code, locale.name])],
    get language() { return current(); },
    setLanguage(code) { if (code !== 'en' && !locales[code]) return; language = code; try { localStorage.setItem('audiorec-language', code); } catch {} location.reload(); },
    sourceOf: text => sources.get(text) ?? text,
    tr, trn, translatePage,
  };
})();
const tr = I18N.tr, trn = I18N.trn;
