# Audiorec

Record voice-over on top of any video, directly in the browser. No build step, no backend, no dependencies.

## Run it

The microphone only works on `localhost` or HTTPS, so serve the folder instead of opening `index.html` from disk:

```sh
npx serve .
# or
python -m http.server 8000
```

Then open the printed URL (e.g. `http://localhost:8000`) in a Chromium-based browser (Chrome, Edge) for full support.

## Features

- **Video playback** with optional mute of the original audio (monitoring only, never exported).
- **Multi-track recording**: arm one or more tracks with **REC**, press **Record**, speak while the video plays. Every armed track gets the same take.
- **Timeline editing**: drag clips to move them, drag their edges to trim, double-click to rename clips and tracks. Scale is 80 px = 1 s.
- **Scrubbing**: click or drag the ruler to seek; the playhead stays centered while playing.
- **Clean edits**: 5 ms fade-in/out on every clip, in playback and export.
- **Mic test & level meter** in the settings dialog, plus input/output device selection (output selection depends on browser support for `setSinkId`).
- **Autosave** of video and recordings in IndexedDB — survives a page refresh.
- **Project files** (`.audiorec`): save/open the full project (video + recordings). With the File System Access API, later saves overwrite the same file; otherwise the file is downloaded.
- **Export WAV**: mono 16-bit mix of all unmuted tracks, at the AudioContext sample rate.

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
| `index.html` | Markup, inline SVG icon library, info popovers, device dialog |
| `style.css` | Dark theme, design tokens on `:root` |
| `app.js` | All logic: recording, timeline, playback, persistence, export |

## `.audiorec` format

Binary, little-endian:

1. 8 bytes: ASCII `AUDIOREC`
2. 4 bytes: `uint32` length of the JSON manifest
3. JSON manifest (`version: 1`, `nextId`, `videoMuted`, `video` metadata, `tracks` with clip `start`, `trimStart`, `trimEnd`, `sampleRate`, `sampleCount`)
4. Raw video bytes (if a video is set)
5. Each clip's samples as `float32`, in track/clip order

## Browser support

Target: recent Chrome / Edge. Browsers without the File System Access API (Firefox, Safari) fall back to downloading the project file, and may not support output device selection.
