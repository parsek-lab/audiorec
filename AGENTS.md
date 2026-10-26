# AGENTS.md

Guidance for coding agents working on Audiorec. User-facing docs are in `README.md`.

## Project shape

- Static web app in `app/`: `index.html`, `style.css`, `app.js`, `i18n.js` and `locales/` (served at `/app/`). The root `index.html` is the self-contained landing page. No build, no bundler, no npm dependencies, no framework.
- Keep it that way: do not add a package manager, transpiler or library unless the user asks.
- Git repository on GitHub (`parsek-lab/audiorec`). A push to `main` deploys the site to Cloudflare Pages: commit or push only when the user asks.
- UI text, code and comments are in **English**, even though the user usually writes requests in Italian.

## Running and verifying

1. Syntax check: `node --check app/app.js` (and `app/theme.js`)
   Checks (Node, no dependencies): `node tools/check-it.mjs` (locales; update its string count when UI strings change) and `node tools/check-theme.mjs` (themes), `node tools/check-recording.mjs` (capture worker), `node tools/check-effects.mjs`, `node tools/check-eq.mjs`, `node tools/check-compressor.mjs`; `node tools/check-eq-ui.mjs` runs headless Chromium (fake microphone included; `CHROME_BIN` selects the browser).
2. Serve locally (mic needs localhost/HTTPS): `npx serve .` or `python -m http.server 8000`, then open `/app/`
3. Check the change in a Chromium browser. Real microphone tests cannot be automated; say so explicitly when reporting.

There is no test suite. Report what was verified and what was not.

## Code conventions (`app.js`)

- Single script, global scope, plain functions. `$ = id => document.getElementById(id)`.
- Dense style: short one-liners, chained statements with `;` on one line, few comments. Match it.
- State lives in module-level variables: `tracks`, `recording`, `context`, `stream`, `source`, `recorder`, `nextId`, `selectedVideo`, `projectHandle`.
- Track shape: `{ id, name, armed, muted, volume (linear gain 0–3.16, i.e. −∞ to +10 dB; default 1), color? (`#rrggbb`, default from `TRACK_COLORS` via `trackColor()`), clips, pending? }`. Clip shape: `{ name, start, trimStart, trimEnd, muted?, gain?, fadeIn?, fadeOut?, buffer: AudioBuffer }`, the buffer mono or stereo at 48 kHz (`PROJECT_RATE`; the AudioContext runs at that rate). Bring outside audio in through `adaptAudio()`, and read samples with `channelData(buffer, c)` / `clipChannels(buffer)`, never `getChannelData` directly (Brave).
- After changing tracks/clips, call in this order as needed: `renderTracks()` → `syncPlayback()` → `saveProject()`; then `status('…')` for user feedback.
- `renderTracks()` rebuilds the whole track DOM; do not keep references to clip elements across renders.
- Buttons with icons use `setIconButton(button, iconName, text, tooltip)`. Icons are `<symbol id="i-NAME">` in `index.html`.
- Tooltips include the shortcut in parentheses only when there is one, e.g. `Record (*)`; no "(no shortcut)" suffix.
- Timeline scale: `pxPerSecond`, computed in `renderTimeline()` from the `#zoom` slider (log scale from whole video to 1 s visible). Track headers (`#track-heads`) are a separate fixed column; the timeline scroll area starts at x = 0. Header and lane rows share the `--row` height in CSS.
- Playback (`syncPlayback`) and export (`renderMix`) schedule clips through the same `scheduleTrack()`: change the clip graph there, once.
- Waveform canvases are cached per `AudioBuffer` (`waveCache`, keyed by size and color). Never change a buffer's samples in place: make a new buffer (as cut and glue do), or the timeline shows the old waveform.
- Effects: each kind has one entry in `EFFECT_KINDS` (`eq.js`; the utility effects of `effects.js` share one) with label, dialog, settings, create, copy, valid, connect, update and open. Editors use `wireEffectDialog()` for Enable, Remove and close.
- Single-key shortcuts live in `KEY_ACTIONS` (`app.js`); list every shortcut in `renderShortcuts()` for the Help tab.
- Fades: `FADE_SECONDS = .0015`, raised-cosine shape from `fadeGain()`, scheduled by `scheduleFades()` in both `syncPlayback` and the offline `renderMix` used by export, and applied per sample in `clipWav`. `clipFades(track, clip)` turns partial overlaps between clips of a track into equal-power crossfades; pass its result to `scheduleFades()`. Value curves throw if they overlap other automation events: keep using `scheduleFades()`.

## Persistence — handle with care

- **IndexedDB** database `audio-sopra-video`, store `project`, keys `current` (project snapshot) and `fileHandle`. Do not rename: existing users would lose their autosave.
- `saveProject()` is a serialized queue and is a no-op while `restoring` is true.
- **`.audiorec` file format** (see README) is versioned (currently `version: 13`; v13 added the clip `channels` count for stereo clips). Any change to the layout or manifest must bump the version and keep reading older versions. `openProject` validates every field; extend validation when adding fields.
- Persisted fields must be added to all three: `projectData()`, `restoreProject()`, `projectBlob()`/`openProject()`.

## UI conventions (`index.html`, `style.css`)

- Themes: `app/theme.js` stores the MODE (`system|dark|light|accessible`, localStorage `audiorec-theme`, missing/invalid = system) and writes the SCHEME to `<html data-theme>`; only System follows OS changes. Never persist the theme in the project, IndexedDB or `.audiorec`.
- Colors are CSS tokens: `:root` (Dark, the original palette), `:root[data-theme=light]`, `:root[data-theme=accessible]`. Components use `var(--…)` only, never raw colors; a new token must be defined in all three blocks (`check-theme.mjs` enforces it). Canvas waveforms read `--wave`, `--wave-video`, `--wave-rec` via `themeColor()`; a scheme change re-renders tracks.
- Accessible theme: any new state needs a non-color cue there too (shape, pattern or text), and focus must stay visible. Respect `prefers-reduced-motion`.
- Explanations live in the Help dialog (`#help-dialog`, opened from the main menu), one tab per topic (`help-files`, `help-recording`, `help-tracks` panels), not inline text. Update the relevant panel when behavior changes; a new topic needs a tab, a panel and its `aria-controls`.
- Buttons that need the project loaded are disabled until `restoreProject()` finishes; add new ones to `PROJECT_BUTTONS` in `app.js`.

## Recording pipeline

`getUserMedia` → `MediaStreamSource` → `AnalyserNode` (level meter, monitor). Recording does not go through Web Audio where it can avoid it: `startRecorder()` reads the microphone track with `MediaStreamTrackProcessor` in a Blob worker (`CAPTURE_WORKER_SOURCE`), on the device clock and off the main thread; whole frames missing from the timestamps are filled with silence and counted as gaps. Without it (non-Chromium), an AudioWorklet (`audiorec-recorder-v1`) taps `source`. Both call `deliverRecording()`, which appends mono `Float32Array` chunks (recordings are mono; a take not at 48 kHz is resampled after it ends) to `track.pending.chunks` for every armed track; `finishRecording()` stops the capture and assembles an `AudioBuffer` at the capture's sample rate. Do not reintroduce `ScriptProcessor`: it lost whole 4096-sample blocks when the main thread was busy. Pause, seek or end of the timeline stops recording. Past the video's end, playback and recording continue on an AudioContext clock (`startOvertime`/`stopOvertime`, `cursor`), up to `timelineEnd()`; use `playPosition()`, `isPlaying()`, `play()`, `pause()` and `seekTo()` instead of reading or driving `video` directly.
