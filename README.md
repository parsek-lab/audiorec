# Audiorec

Record voice-over on top of any video, directly in the browser. No build step, no backend. The only dependency is [Mediabunny](https://mediabunny.dev), loaded from a CDN on demand for video export.

## Run it

The microphone only works on `localhost` or HTTPS, so serve the folder instead of opening the files from disk:

```sh
npx serve .
# or
python -m http.server 8000
```

Then open the app at `/app/` on the printed URL (e.g. `http://localhost:8000/app/`) in a Chromium-based browser (Chrome, Edge) for full support.

Live at https://audiorec.app (Cloudflare Pages). The landing page is at `/`, the app at `/app/`. Every push to `main` redeploys the landing page and the app through `.github/workflows/deploy.yml`, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

## Features

- **Video playback** with mute and volume (−∞ to +10 dB) for the original audio (included in the export only if chosen). The video's own audio is drawn as a read-only waveform row above the tracks.
- **Multi-track recording**: arm one or more tracks with **REC**, press **Record**, speak while the video plays. Every armed track gets the same take.
- **Timeline editing**: drag clips to move them, drag their edges to trim, cut the selected clips at the playhead (scissors button or <kbd>C</kbd>), mute them so they stay out of playback and export (speaker button or <kbd>M</kbd>), delete them (trash button or <kbd>Del</kbd>), double-click to rename clips and tracks. Import audio files (button, or drag them from your computer onto a track); stereo files are mixed down to mono. Click a clip to select it (Shift+click for more) and press Del to remove the selection. Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redoes every track and clip change (history resets on New/Open project). The ruler and time display read minutes:seconds:frames, with the frame rate read from the video file (MP4/MOV/WebM; otherwise measured during playback, 25 fps until then). Dragging the playhead to a timeline edge scrolls, accelerating the longer you hold. Zoom with the slider (fully left: whole video; fully right: 1 second visible), `+` / `-`, or Ctrl + mouse wheel.
- **Clip list** next to the video: every clip in timeline order, with track, start time and length. Click one to jump to its start and select it (Shift+click adds to the selection), double-click to rename it. Each clip has a WAV download button (trimmed, with the playback fades, without the track volume); the heading downloads all clips as one ZIP of WAV files and can collapse the list.
- **View kept across reloads** (in this browser): selected clips, zoom, timeline scroll and playhead position.
- **Scrubbing**: click or drag the ruler to seek; the playhead stays centered while playing.
- **Clean edits**: 5 ms fade-in/out on every clip, in playback and export.
- **Mic test & level meter** in the settings dialog, with an **Enhanced audio** toggle (browser echo cancellation, noise suppression and auto gain; off by default), plus input/output device selection (output selection depends on browser support for `setSinkId`).
- **Autosave** of video and recordings in IndexedDB — survives a page refresh.
- **Project files** (`.audiorec`): save/open the full project (video + recordings). With the File System Access API, later saves overwrite the same file; otherwise the file is downloaded.
- **Export markers**: two draggable handles on the ruler (start and end) delimit the export; <kbd>I</kbd> / <kbd>O</kbd> place them at the playhead, double-click resets one. They snap to frames, the playhead, clip edges and the timeline length, and are saved with the project and in undo.
- **Export** (Menu → Export…) over a chosen start/end range, by default the export markers:
  - **Audio only**: 16-bit WAV mix of all unmuted tracks at the AudioContext sample rate (mono, stereo when the video audio is included), saved as `<project name>-audio.wav`.
  - **Video + audio**: MP4 with the original video packets copied (no re-encoding) and the mix encoded as AAC (Opus where AAC is unavailable), saved as `<project name>.mp4`. Needs WebCodecs; the range must end within the video.
  - Optionally mixes in the video's own audio at the Video audio volume.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `*` (or numpad `*`) | Start / stop recording |
| `Esc` | Close the device dialog |

Shortcuts are ignored while focus is on a button, input or select.

## Recording behavior

Recording stops automatically when the video is paused, seeked or ends. Recorded clips start at the video time where recording began.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Landing page (self-contained: inline CSS, SVG and script) |
| `app/index.html` | Markup, inline SVG icon library, info popovers, device dialog |
| `app/style.css` | Dark theme, design tokens on `:root` |
| `app/app.js` | All logic: recording, timeline, playback, persistence, export |
| `app/i18n.js` | Interface translation: language choice, `tr()` / `trn()`, page translation |
| `app/locales/<code>.js` | One file per translated language (none yet) |
| `tools/i18n.mjs` | Translation helper: creates, updates and checks the locale files (Node, no dependencies) |

## Translations

The app interface is written in English, and the English text is the translation key. A language is a file in `app/locales/`, loaded by a `<script>` tag in `app/index.html` before `app.js`. The homepage is self-contained: its own shorter translation table lives inline in the root `index.html`; app locale files are not loaded there. Both headers offer a **Language** control (English, Italian, Spanish, Russian or Simplified Chinese). The selection follows the browser language unless overridden and is shared between homepage and app via the `audiorec-language` localStorage key on the same origin. If browser storage is unavailable, the choice works on the current page but does not persist across navigation or reload. On the app, changing language reloads the page.

1. `node tools/i18n.mjs new it Italiano` creates `app/locales/it.js` with every string and adds its script tag.
2. Fill in the values. An empty value shows the English text. Keep `{placeholders}` as they are and keep a trailing shortcut such as `(Ctrl+Z)` at the end, where the tooltip shows it as a key. Plural entries take the [`Intl.PluralRules`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules) forms of the language (`one`, `few`, `many`, `other`…). The second object holds the paragraphs with formatting (`data-i18n-html` in `app/index.html`) as HTML.
3. `node tools/i18n.mjs` lists, for each language, the strings still missing or no longer used; `node tools/i18n.mjs update it` adds the new ones and drops the unused ones, keeping the existing translations.

In code, visible text goes through `tr('Text with {name}.', { name })`, or `trn('{count} clip', '{count} clips', count)` for plurals. Text in `app/index.html` (text, `title`, `aria-label`, `placeholder`) is translated in place; give an element `data-i18n-html="<id>"` when its content has inline markup, and `translate="no"` when it must not be translated.

## `.audiorec` format

Binary, little-endian:

1. 8 bytes: ASCII `AUDIOREC`
2. 4 bytes: `uint32` length of the JSON manifest
3. JSON manifest (`version: 4`, `nextId`, `length` (timeline length in seconds, or `null` = video length), `exportIn` / `exportOut` (export markers in seconds, optional; `exportOut` `null` = timeline length), `videoMuted`, `videoVolume` (linear gain, optional), `video` metadata, `tracks` with `volume` (linear gain, 0 to 3.16 = +10 dB), `color` (`#rrggbb`) and clip `start`, `trimStart`, `trimEnd`, `muted` (optional), `sampleRate`, `sampleCount`). Older files still open: version 1 (no `volume`) at 100% volume, versions 1–2 (no `color`) with default track colors, versions 1–3 (no `length`) following the video length.
4. Raw video bytes (if a video is set)
5. Each clip's samples as `float32`, in track/clip order

## Browser support

Target: recent Chrome / Edge. Browsers without the File System Access API (Firefox, Safari) fall back to downloading the project file, and may not support output device selection.
