# midi-kbd

English | [日本語](README.ja.md)

Play a grand piano (Splendid Grand Piano) in the browser with a MIDI keyboard.
You can also play back MIDI files and follow them as falling notes, a scrolling staff, or sheet music.

The UI is in Japanese.

## Features

- Play with a MIDI keyboard, the on-screen keyboard, or your PC keyboard
- SFZ sampler with 5 velocity layers, sympathetic string resonance, and half-pedaling
- Adjustable reverb, EQ, and damping. Settings are saved in the browser
- MIDI file playback with three views: notes, staff roll, and sheet music

## Requirements

| Browser | MIDI keyboard | On-screen / PC keyboard |
|---|---|---|
| Chrome / Edge | ✅ | ✅ |
| Firefox 108+ | ✅ | ✅ |
| Safari | ❌ | ✅ |

Running locally requires Node.js (tested with 22).

## Setup

1. Install dependencies

   ```bash
   npm install
   ```

2. Get the instrument (about 75 MB) into `sfz/` at the project root

   ```bash
   git clone https://github.com/sfzinstruments/SplendidGrandPiano.git sfz/SplendidGrandPiano
   ```

To keep the instrument somewhere else, set the environment variable `SFZ_ROOT` to its parent folder
(for example, if it is in `D:/SoundFonts/SplendidGrandPiano`, set `SFZ_ROOT=D:/SoundFonts`).

## Running

On Windows, double-click `start.bat` to start the server and open the browser.
From the command line:

```bash
npm start     # open http://localhost:5173
```

On a PC, the instrument starts loading as soon as the page opens. Because of the browser's autoplay policy,
sound starts after you click the page or press a key (notes from a MIDI keyboard do not count).
On phones, loading waits for the "▶ 開始" (Start) button so that opening the page does not download 75 MB.
Press <kbd>Ctrl</kbd>+<kbd>C</kbd> in the console to stop the server.

Opening `index.html` directly (`file://`) does not work: the Web MIDI API is only available in a
secure context such as `http://localhost`.

## Usage

- MIDI keyboards are detected automatically when connected
- On the on-screen keyboard, the vertical click position sets the velocity
- On the PC keyboard, <kbd>Z</kbd>–<kbd>M</kbd> play the C3 octave, <kbd>Q</kbd>–<kbd>I</kbd> the C4 octave,
  and <kbd>Space</kbd> is the sustain pedal
- Pick a MIDI file from the preset list, drop one onto the page, or use "ファイルを選ぶ" (Choose file).
  `.mid` files under `midi/` appear as presets, grouped by subfolder
- During playback, switch the view between ノート (notes), 五線譜 (staff roll), and 楽譜 (sheet music).
  "ch.10 を無視" mutes the drum channel
- "設定を初期化" in the header resets the saved knob settings

## Notes

- There is some latency between pressing a key and hearing the sound. Browsers use the OS default
  audio output, which tends to add tens of milliseconds on Windows. The header shows an estimate (Latency).
  Bluetooth earphones and monitor speakers over HDMI add more; wired earphones or an audio interface help
- The whole instrument is decoded into memory, so the page uses about 535 MB
- Sheet music is generated from MIDI and will not match the published score. Where more than two voices
  share one staff (fugues, for example), extra voices are cut short
- Check the license of any MIDI file you add to `midi/` before publishing or redistributing it

## Deploying

`npm run build` assembles a static site in `dist/` (no server-side code is needed).
To host it as Cloudflare Workers static assets, create your own `wrangler.jsonc` and run `npm run cf:deploy`.

## License

The code is under the MIT License ([LICENSE](LICENSE)).
To report a vulnerability, see [SECURITY.md](SECURITY.md).

- Splendid Grand Piano is an SFZ conversion by kinwie of samples AKAI released into the public domain
  (string resonance and half-pedaling by P. Eastman)
- The three pieces in `midi/piano-midi.de/` are by Bernd Krueger (http://piano-midi.de/) and are distributed under
  [CC BY-SA 3.0 DE](https://creativecommons.org/licenses/by-sa/3.0/de/deed.en). Only the file names have been
  changed to the titles

Implementation notes (in Japanese) are in [NOTES.md](NOTES.md).
