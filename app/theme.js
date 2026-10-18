// Interface theme. The saved choice is a MODE (system, dark, light, accessible) in localStorage 'audiorec-theme'; the
// effective SCHEME (dark, light, accessible) is written to <html data-theme> and drives the tokens in style.css.
// System follows prefers-color-scheme live; an explicit mode ignores OS changes. A missing or unknown value means system.
// Loaded in <head> before style.css applies, so the page never flashes the wrong palette.
const THEME = (() => {
  const KEY = 'audiorec-theme', MODES = ['system', 'dark', 'light', 'accessible'], listeners = new Set();
  const normalize = value => MODES.includes(value) ? value : 'system';
  const resolve = (mode, prefersLight) => normalize(mode) === 'system' ? (prefersLight ? 'light' : 'dark') : mode;
  const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  let mode = 'system';
  try { mode = normalize(localStorage.getItem(KEY)); } catch {}
  function apply() {
    const root = document.documentElement, scheme = resolve(mode, !!query?.matches), changed = root.dataset.theme !== scheme;
    root.dataset.theme = scheme; root.dataset.themeMode = mode;
    for (const listener of listeners) listener(scheme, mode, changed);
  }
  function setMode(value) {
    mode = normalize(value);
    try { if (mode === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch {}
    apply();
  }
  query?.addEventListener?.('change', () => { if (mode === 'system') apply(); });
  // Another tab (app) changed the choice: follow it without writing storage again.
  if (typeof addEventListener === 'function') addEventListener('storage', event => { if (event.key === KEY || event.key === null) { mode = normalize(event.newValue); apply(); } });
  apply();
  return {
    MODES, normalize, resolve, setMode,
    get mode() { return mode; },
    get scheme() { return document.documentElement.dataset.theme; },
    onChange(listener) { listeners.add(listener); },
  };
})();
