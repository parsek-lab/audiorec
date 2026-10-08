# Audiorec

Record voice-over on top of any video, directly in the browser. No build step, no backend, no dependencies.

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

- **Video playback** with optional mute of the original audio (monitoring only, never exported).
- **Multi-track recording**: arm one or more tracks with **REC**, press **Record**, speak while the video plays. Every armed track gets the same take.
- **Timeline editing**: drag clips to move them, drag their edges to trim, double-click to rename clips and tracks. Import audio files (button, or drag them from your computer onto a track); stereo files are mixed down to mono. Click a clip to select it (Shift+click for more) and press Del to remove the selection. Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redoes every track and clip change (history resets on New/Open project). The ruler and time display read minutes:seconds:frames, with the frame rate read from the video file (MP4/MOV/WebM; otherwise measured during playback, 25 fps until then). Dragging the playhead to a timeline edge scrolls, accelerating the longer you hold. Zoom with the slider (fully left: whole video; fully right: 1 second visible), `+` / `-`, or Ctrl + mouse wheel.
- **Scrubbing**: click or drag the ruler to seek; the playhead stays centered while playing.
- **Clean edits**: 5 ms fade-in/out on every clip, in playback and export.
- **Input level meter**, always on (the microphone opens when the app loads), plus input/output device selection (output selection depends on browser support for `setSinkId`).
- **Autosave** of video and recordings in IndexedDB — survives a page refresh.
- **Project files** (`.audiorec`): save/open the full project (video + recordings). With the File System Access API, later saves overwrite the same file; otherwise the file is downloaded.
- **Export WAV**: mono 16-bit mix of all unmuted tracks, at the AudioContext sample rate, saved as `<project name>-audio.wav`.

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

## `.audiorec` format

Binary, little-endian:

1. 8 bytes: ASCII `AUDIOREC`
2. 4 bytes: `uint32` length of the JSON manifest
3. JSON manifest (`version: 4`, `nextId`, `length` (timeline/WAV length in seconds, or `null` = video length), `videoMuted`, `video` metadata, `tracks` with `volume` (0–2), `color` (`#rrggbb`) and clip `start`, `trimStart`, `trimEnd`, `sampleRate`, `sampleCount`). Older files still open: version 1 (no `volume`) at 100% volume, versions 1–2 (no `color`) with default track colors, versions 1–3 (no `length`) following the video length.
4. Raw video bytes (if a video is set)
5. Each clip's samples as `float32`, in track/clip order

## Browser support

Target: recent Chrome / Edge. Browsers without the File System Access API (Firefox, Safari) fall back to downloading the project file, and may not support output device selection.
