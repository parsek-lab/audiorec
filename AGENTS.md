# AGENTS.md

Guidance for coding agents working on Audiorec. User-facing docs are in `README.md`.

## Project shape

- Static web app in `app/`: `index.html`, `style.css`, `app.js` (served at `/app/`). The root `index.html` is the self-contained landing page. No build, no bundler, no npm dependencies, no framework.
- Keep it that way: do not add a package manager, transpiler or library unless the user asks.
- Not a git repository. There is no `git diff` to review changes against.
- UI text, code and comments are in **English**, even though the user usually writes requests in Italian.

## Running and verifying

1. Syntax check: `node --check app/app.js`
2. Serve locally (mic needs localhost/HTTPS): `npx serve .` or `python -m http.server 8000`, then open `/app/`
3. Check the change in a Chromium browser. Real microphone tests cannot be automated; say so explicitly when reporting.

There is no test suite. Report what was verified and what was not.

## Code conventions (`app.js`)

- Single script, global scope, plain functions. `$ = id => document.getElementById(id)`.
- Dense style: short one-liners, chained statements with `;` on one line, few comments. Match it.
- State lives in module-level variables: `tracks`, `recording`, `context`, `stream`, `source`, `processor`, `nextId`, `selectedVideo`, `projectHandle`.
- Track shape: `{ id, name, armed, muted, volume (linear gain 0–3.16, i.e. −∞ to +10 dB; default 1), color? (`#rrggbb`, default from `TRACK_COLORS` via `trackColor()`), clips, pending? }`. Clip shape: `{ name, start, trimStart, trimEnd, buffer: AudioBuffer }` (mono).
- After changing tracks/clips, call in this order as needed: `renderTracks()` → `syncPlayback()` → `saveProject()`; then `status('…')` for user feedback.
- `renderTracks()` rebuilds the whole track DOM; do not keep references to clip elements across renders.
- Buttons with icons use `setIconButton(button, iconName, text, tooltip)`. Icons are `<symbol id="i-NAME">` in `index.html`.
- Tooltips include the shortcut in parentheses only when there is one, e.g. `Record (*)`; no "(no shortcut)" suffix.
- Timeline scale: `pxPerSecond`, computed in `renderTimeline()` from the `#zoom` slider (log scale from whole video to 1 s visible). Track headers (`#track-heads`) are a separate fixed column; the timeline scroll area starts at x = 0. Header and lane rows share the `--row` height in CSS.
- Fades: `FADE_SECONDS = .005`, applied as gain ramps both in `syncPlayback` and in the offline `renderMix` used by export. Keep both in sync.

## Persistence — handle with care

- **IndexedDB** database `audio-sopra-video`, store `project`, keys `current` (project snapshot) and `fileHandle`. Do not rename: existing users would lose their autosave.
- `saveProject()` is a serialized queue and is a no-op while `restoring` is true.
- **`.audiorec` file format** (see README) is versioned (currently `version: 4`; v2 added track `volume`, v3 track `color`, v4 project `length`). Any change to the layout or manifest must bump the version and keep reading older versions. `openProject` validates every field; extend validation when adding fields.
- Persisted fields must be added to all three: `projectData()`, `restoreProject()`, `projectBlob()`/`openProject()`.

## UI conventions (`index.html`, `style.css`)

- Dark theme with CSS tokens on `:root` (`--accent`, `--rec`, `--raised`, …). Use tokens, not raw colors.
- Explanations live in info popovers (`.tip` + `.info-button` with `popovertarget`), not inline text. Update the relevant tip when behavior changes.
- Buttons that need the project loaded are disabled until `restoreProject()` finishes; add new ones to both ID lists in `app.js` (end of `restoreProject` and the line before `restoreProject()` is called).

## Recording pipeline

`getUserMedia` → `MediaStreamSource` → `AnalyserNode` (level meter) and, while recording, → `ScriptProcessor(4096)` → zero-gain node → destination. Chunks are copied into `track.pending.chunks` for every armed track and assembled into an `AudioBuffer` in `finishRecording()`. Pause, seek or end of the timeline stops recording. Past the video's end, playback and recording continue on an AudioContext clock (`startOvertime`/`stopOvertime`, `cursor`), up to `timelineEnd()`; use `playPosition()`, `isPlaying()`, `play()`, `pause()` and `seekTo()` instead of reading or driving `video` directly.
