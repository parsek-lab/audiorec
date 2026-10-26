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
- **Multi-track recording**: put **REC** on the track to record on (one track at a time; clicking REC on another track moves it), press **Record**, speak while the timeline plays (over the video, if one is chosen). Pausing or seeking stops the recording.
- **Timeline editing**: drag clips to move them, drag their edges to trim, cut the selected clips at the playhead (scissors button or <kbd>C</kbd>), glue selected clips that overlap or touch on a track into one (glue button or <kbd>G</kbd>; rendered as it plays, crossfades and clip gains included, keeping the outer fades editable), mute them so they stay out of playback and export (speaker button or <kbd>M</kbd>), delete them (trash button or <kbd>Del</kbd>), double-click to rename clips and tracks. Import audio files (button, or drag them from your computer onto a track); stereo files stay stereo (more channels are folded to stereo) and every file is converted to the project's 48 kHz. Click a clip to select it (Shift+click for more) and press Del to remove the selection. Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redoes every track and clip change (history resets on New/Open project). The ruler and time display read minutes:seconds:frames, with the frame rate read from the video file (MP4/MOV/WebM; otherwise measured during playback, 25 fps until then). Dragging the playhead to a timeline edge scrolls, accelerating the longer you hold. Zoom with the slider (fully left: whole video; fully right: 1 second visible), `+` / `-`, or Ctrl + mouse wheel.
- **Clip settings**: double-click a clip on the timeline for its name, gain (−∞ to +10 dB, same fader as the tracks, or a typed dB value) and fade in / fade out in ms (a fade longer than an overlap crossfade replaces it; fades are drawn as shaded corners, a non-zero gain as a badge). Cutting keeps the fade-in on the first piece and the fade-out on the second.
- **Track pan**: shown under each track volume; the volume popover has a pan slider and typed values (dB; L/R 0–100 or C). Constant-power law, unity at the centre, applied after the effects; mono exports sum both sides.
- **Clip list** next to the video: every clip in timeline order, with track, start time and length. Click one to jump to its start and select it (Shift+click adds to the selection), double-click to rename it. Each clip has a WAV download button (trimmed, with the playback fades, without the track volume); the heading imports audio files (like the import button above the track names), downloads all clips as one ZIP of WAV files and can collapse the list.
- **View kept across reloads** (in this browser): selected clips, zoom, timeline scroll and playhead position.
- **Scrubbing**: click or drag the ruler to seek; the playhead stays centered while playing.
- **Loop**: the toggle next to Play repeats playback between the export markers (the band between them is highlighted); playback started after the end jumps to the start, recording never loops. The setting is remembered in this browser.
- **Clean edits**: 1.5 ms raised-cosine fade-in/out on every clip, in playback, export and clip downloads. Where a clip on a track starts before the previous one ends, the overlap becomes an equal-power crossfade (a clip lying entirely inside another is simply mixed over it, and downloaded clips keep only the short fades).
- **Mic test & level meter** in the settings dialog, with an **Enhanced audio** toggle (browser echo cancellation, noise suppression and auto gain; off by default), plus input/output device selection (output selection depends on browser support for `setSinkId`).
- **Themes** (header → **Theme**, next to Language): **System** (default: follows the device's light/dark setting, live), **Dark** (the original look), **Light** and **Accessible**. Accessible is a high-contrast black theme with blue / yellow / vermilion state colors, a 3 px yellow focus outline, states also shown without color (✓ badge on active REC / Mute, hatched and dashed muted clips labelled "muted", dashed recording clip, "!" on error status) and no decorative animation. Its palette was checked with WCAG contrast ratios and a color-vision simulation, not with color-vision-deficient users. Every theme honours the OS *reduce motion* setting. The choice is a per-browser preference (`audiorec-theme` in localStorage); it is not part of the project, its autosave or `.audiorec` files, and track colors are never changed by a theme. Applies to the app only; the landing page stays dark.
- **Help** (Menu → Help): one dialog with a tab per topic — Saving & exporting, Recording, Editing tracks, Keyboard shortcuts (arrow keys switch tabs).
- **Keyboard**: <kbd>Space</kbd> play/pause, <kbd>*</kbd> record, <kbd>F</kbd> video full screen, <kbd>V</kbd> show / hide the video and clips panel, <kbd>H</kbd> open Help on the shortcuts; <kbd>+</kbd> / <kbd>-</kbd> move the playhead 1 s (<kbd>Ctrl</kbd> 10 s, <kbd>Shift</kbd> one frame; the physical + and - keys count, so Shift works on layouts where it changes the character); <kbd>←</kbd> / <kbd>→</kbd> move the selected clips by the same steps; <kbd>Q</kbd> whole timeline, <kbd>W</kbd> zoom out, <kbd>E</kbd> zoom in; <kbd>,</kbd> / <kbd>.</kbd> jump to the export start / end, <kbd>I</kbd> / <kbd>O</kbd> set them. The full list is in Help → Keyboard shortcuts, generated from `renderShortcuts()` in `app/app.js`.
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
| `app/index.html` | Markup, inline SVG icon library, Help dialog, device dialog |
| `app/style.css` | Design tokens per theme (`:root` = Dark, `[data-theme=light]`, `[data-theme=accessible]`), then components using tokens only |
| `app/theme.js` | Theme mode (System / Dark / Light / Accessible) → `<html data-theme>`; loaded in `<head>` so there is no flash |
| `app/app.js` | All logic: recording, timeline, playback, persistence, export |
| `app/i18n.js` | Interface translation: language choice, `tr()` / `trn()`, page translation |
| `app/locales/<code>.js` | One file per translated language (none yet) |
| `tools/i18n.mjs` | Translation helper: creates, updates and checks the locale files (Node, no dependencies) |
| `tools/check-it.mjs` | Locale coverage and integrity check: `node tools/check-it.mjs` |
| `tools/check-theme.mjs` | Theme checks: mode/scheme logic, OS sync, token completeness, contrast and color-vision heuristics, wiring: `node tools/check-theme.mjs` (`--report` prints the ratios) |

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
3. JSON manifest (`version: 13`, `nextId`, `length` (timeline length in seconds, or `null` = video length), `exportIn` / `exportOut` (export markers in seconds, optional; `exportOut` `null` = timeline length), `videoMuted`, `videoVolume` (linear gain, optional), `video` metadata, `tracks` with `volume` (linear gain, 0 to 3.16 = +10 dB), `color` (`#rrggbb`) and ordered `effects` (array of `{ type: "equalizer", eq: { enabled, bands } }` or `{ type: "compressor", compressor: { enabled, threshold, ratio, knee, attack, release, inputGain, gain, mix } }` or `{ type: "delay"|"reverb"|"pitch"|"chorus"|"expander", settings: { enabled, ...parameters } }`, up to 32; each EQ has six bands ordered low cut, high cut, four parametric, each with `type`, `enabled`, `freq` in Hz, `gain` in dB and linear `q`) and clip `start`, `trimStart`, `trimEnd`, `muted` (optional), `sampleRate`, `sampleCount`). Older files still open: version 1 (no `volume`) at 100% volume, versions 1–2 (no `color`) with default track colors, versions 1–3 (no `length`) following the video length. Version 5 added track visibility; version 6 added a single `eq`, migrated to the first effect on load; version 7 adds an ordered effect chain; version 8 adds native compressor effects; version 9 adds delay, reverb, pitch, chorus and expander settings; version 10 adds the cut `slope` (12, 24, 36 or 48 dB/octave; older files open at 12, and a stored cut `q` is ignored); version 11 adds the pitch shifter `window` in ms (older files open at 60); version 12 adds track `pan` (−1 to 1) and clip `gain` (linear), `fadeIn` and `fadeOut` (seconds); version 13 adds clip `channels` (1 or 2), with the samples of a stereo clip stored left then right. Clips at another sample rate are converted to 48 kHz when a project opens. Versions 1–5 open without effects.
4. Raw video bytes (if a video is set)
5. Each clip's samples as `float32`, in track/clip order

### Track equalizer

Open **fx** next to a track menu (it shows how many effects the track has) to see the effect chain. Each row shows its position, the effect name, an on/off button (bypassed rows are dashed and marked **Off**) and a remove button (undo with Ctrl+Z). The **Add effect** menu at the top (effects in alphabetical order for the interface language) appends an effect; click a name to open its dedicated editor, where **Remove** sits at the bottom, away from Close, and a bypassed effect's controls are dimmed. Each editor has an on/off switch next to its title, and every knob shows its value as a ring (bipolar knobs fill from zero). In the EQ graph, drag the numbered points (1–4 parametric, L/H cuts) to change frequency and gain; one drag is one undo step. The other effects show labelled graphs: echo levels over time (delay), the decay envelope with pre-delay and T60 (reverb), the two voices' delay time (chorus), the semitone shift (pitch) and the transfer curve with threshold (expander). Drag effects to reorder them (mouse/touch handle, or Alt+Up/Down on a focused row). Processing and exports follow the saved order. Multiple EQs are supported. Click the space outside any dialog to close it. Enable the low cut/high cut as needed: they are Butterworth filters (−3 dB at the cutoff, no resonance peak) with a frequency control and a selectable slope of 12, 24, 36 or 48 dB/octave. Changing the gain of a switched-off parametric band to a non-zero value (knob, number or graph point) switches the band on, in the same undo step. Four parametric bands provide frequency (20–20,000 Hz), gain (−24 to +24 dB) and Q (0.1–20). Filters can be switched off individually; **Enable equalizer** bypasses that EQ without losing its settings. Each parameter has a rotary knob plus an editable numeric value: drag vertically, use arrow keys (Shift for fine adjustment), Home/End for limits or double-click to reset. The editor uses a compact, responsive layout capped below 1,000 px in height; short screens can scroll. Remove deletes the EQ, with undo support.

The graph overlays the response curve (left scale, ±24 dB) and a live post-EQ spectrum (right scale, −90 to 0 dBFS). There are 30 third-octave bars from 20 Hz to 20 kHz; the final band is truncated at 20 kHz. The curve represents the opened EQ; the spectrum is the track output after all effects. The spectrum follows track playback, not microphone monitoring; when stopped it is empty. Frequencies are limited internally to just below the audio context's Nyquist frequency. Playback and mixed audio/video exports use the same filters; individual clip downloads remain dry. Settings and effect order are autosaved and included in project files.

### Track compressor

In **fx**, choose **Add compressor**, then click its name to open its compact editor. Controls use the same keyboard/pointer knobs and editable numbers as the EQ:

- Threshold −100–0 dB, ratio 1:1–20:1, knee 0–40 dB.
- Attack 0.1–1,000 ms; release 1–3,000 ms.
- Input gain and manual output gain −24–+24 dB; dry/wet mix 0–100%.
- Enable/bypass and Remove; all changes support undo, autosave and project files.

The graph shows the static transfer curve before the native compressor's built-in automatic makeup; meters show actual input/output peaks (dBFS) and gain reduction during track playback. Manual output gain applies to the wet path. Input gain applies to both dry/wet paths; bypass ignores all gains and adds no delay. The enabled dry path is delayed 6 ms to match native lookahead for parallel compression. Native dynamics include automatic makeup, lookahead and stereo linking; no external sidechain, listen filter, adjustable lookahead, auto/adaptive attack/release or switchable auto makeup is exposed. Unlike the reference image, these unsupported controls are not shown.

EQ and compressor instances can be combined and reordered; the order is used by both playback and offline mixed exports. Individual clip downloads remain dry. Older projects still load, including the single-EQ version 6 format.

Checks: `node tools/check-compressor.mjs` validates settings, curve and routing; `node tools/check-eq-ui.mjs` runs Chromium UI/persistence and native offline DSP checks (set `CHROME_BIN` if Chrome/Edge is not auto-detected). No microphone is needed by these checks.

### Additional track effects

Add these from **fx**, then click their name for a dedicated editor. All use knobs + editable numbers, bypass, dry/wet mix, ordering, undo, autosave and project files. Playback and offline mixed exports share the same graphs. These effects are not applied to individual clip downloads.

- **Delay:** 10–2,000 ms time, 0–95% feedback, 200–18,000 Hz feedback low-pass, dry/wet mix. Feedback is capped below unity.
- **Reverb:** deterministic synthetic stereo convolution impulses for **Hall**, **Room** and **Plate** (not sampled commercial spaces or physical-model emulations). Preset selection resets decay to 2.8, 0.8 or 1.6 s respectively. Decay 0.2–8 s (approximate T60), pre-delay 0–200 ms, damping 500–20,000 Hz, mix. Impulses are generated locally and cached; no downloads or libraries.
- **Pitch shifter:** ±24 semitones, window 20–200 ms (default 60), mix. An AudioWorklet reads a delay line at the pitch ratio and, when the delay leaves the window, crossfades to a point one window away chosen by normalized cross-correlation with the audio just played, so splices land in phase; reads use 4-point cubic interpolation and stereo channels share every splice. Clip duration is preserved and zero semitones is transparent. The processor has a fixed latency set by the window (`pitchCenter`, about 45 ms at 60 ms): its dry path is delayed by exactly that much, and the shifted reader swings by half a window around it. Playback and export feed each track ahead of the playhead by the sum of its pitch shifters' latencies (`trackLatency`), and the export renders that much pre-roll and drops it, so the dry part lands on the exact timeline sample and the wet part within half a window. Changing the window rebuilds playback; after play or seek a compensated track starts silent for its latency. Formants are not preserved. Requires AudioWorklet (localhost or HTTPS). Projects before version 11 load with a 60 ms window.
- **Chorus:** two quadrature-modulated delay voices, rate 0.05–8 Hz, depth 0–20 ms, delay 5–40 ms, stereo width and mix. Depth is internally limited below base delay. Stereo spread folds down in mono exports.
- **Expander:** stereo-linked downward expansion via AudioWorklet: threshold −100–0 dB, ratio 1–20, knee 0–24 dB, attenuation range 0–80 dB, opening attack 0.1–1,000 ms, closing release 1–3,000 ms, output gain ±24 dB and mix. Its reduction meter follows playback. AudioWorklet requires a supported browser on localhost/HTTPS. A failed worklet load stops playback or fails export with an error rather than silently bypassing the effect. The processor is prepared independently in each realtime/offline context; pausing/seeking cancels pending playback setup.

Delay/reverb tails continue while the timeline plays, but neither the timeline nor the export range is automatically extended. Set enough timeline length and export end time to retain tails. Pitch/chorus modulation is restarted when playback is rebuilt (play, seek, reorder or add/remove); offline exports start with the same deterministic initial phase. Playback stops also dispose oscillator/buffer-source modulation and worklet nodes.

Verification: `node tools/check-effects.mjs` checks ranges, presets, settings and expander sample processing; `node tools/check-eq-ui.mjs` serves the app on a temporary localhost port, runs Chromium UI/project/export checks, then tests real offline DSP (echo timing, three reverb tails, ±12-semitone pitch measurements, stereo chorus and linked expansion). The latter needs Chrome/Edge or `CHROME_BIN`; it does not need a microphone.

## Browser support

Target: recent Chrome / Edge. Browsers without the File System Access API (Firefox, Safari) fall back to downloading the project file, and may not support output device selection.

## License

Audiorec is free software, licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`); the full text is in [LICENSE](LICENSE). You may use, study, share and modify it; if you distribute a modified version, or let people use one over a network (for example by hosting it), you must offer them its complete source code under the same license.

The name "Audiorec" and the Audiorec logo are not licensed under the AGPL: forks must use a different name and logo.
