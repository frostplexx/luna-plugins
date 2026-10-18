# @frostplexx/audio-studio

An example Luna plugin that **deeply hooks TIDAL's playback controller** and **takes over
audio processing entirely** — enabling things stock TIDAL can't do:

- **Karaoke mode** — center-channel vocal cancellation (vocals live in the middle of the mix; this removes them while keeping bass + stereo width)
- **3-band EQ** — low/mid/high shelves on the raw decoded stream
- **Gapless crossfade** — overlapping transitions between queued tracks

## How it works

TIDAL's UI never touches audio directly. Every playback command the web client produces is
funneled through `PlayerController.sendPlayerMessage` in the main process as a JSON string
(`{"command":"media.load","url":...,"encryptionKey":...,"streamFormat":...}`) and forwarded
over stdio IPC to the native `TIDALPlayer` child process, which does the actual
fetch/decrypt/decode/DAC work.

```
web client ──player.message──▶ PlayerController.sendPlayerMessage() ──stdio──▶ TIDALPlayer ──▶ speakers
                                     ▲
                                     │  patched by this plugin
```

This plugin hooks that funnel in two layers:

### 1. Main process (`src/takeover.native.ts`)

Runs in TIDAL's main process via Luna's native module loader. It `require()`s TIDAL's own
modules from `original.asar` (same live module instances) and monkey-patches:

- **`PlayerController.prototype.sendPlayerMessage`** — MITMs every UI command. In take-over
  mode, `media.load`/`media.preload` payloads (stream URL + AES key + format) are captured and
  forwarded to the engine; `media.play/pause/stop/seek/volume` are relayed; the native player
  is parked (stopped, volume 0) so nothing double-plays.
- **`spoofSignal`** — pushes synthetic player signals
  (`media.currenttime`, `media.duration`, `media.state` = `active`/`paused`/`completed`)
  into the web client through the exact channel `TIDALPlayer` normally reports through, so
  the progress bar, play state and **queue advance** all work as if the native player were
  still running.

Releasing control seamlessly re-loads the captured stream into the native player at the
current position (handback).

### 2. Renderer engine (`src/engine.ts`)

Owns all audio once enabled:

1. **Fetch** — the captured stream URL is fetched in the renderer (via Luna's `https`
   protocol handler), with a main-process fetch fallback.
2. **Decrypt** — keyId (AES-256-CBC wrapped security token) is unwrapped in the main process
   (same scheme as Luna's `lib.native`), then the stream is deciphered with WebCrypto
   AES-128-CTR (nonce + zero counter).
3. **Decode** — `mediabunny` demuxes the fMP4/FLAC container and WebCodecs decodes it to
   `AudioBuffer`s.
4. **DSP** — WebAudio graph: per-track gain → 3-band EQ → karaoke mid/side network →
   master volume → output.
5. **Crossfade** — `media.preload` payloads are decoded ahead of time; when the current
   track is within the fade window, the next track starts overlapped with gain ramps, and
   `completed` is spoofed so the UI advances the queue into the already-playing track.

## Cross-platform

The hook targets `PlayerController` + `clientDispatcher`, which are identical on macOS,
Windows and Linux builds of the stock client (Linux `tidal-hifi` forks without the native
player process are not covered by the take-over engine — playback there goes through
Chromium's own audio stack).

## Limitations (inherent to the approach, left as exercises)

- Whole-track decode before playback → ~1–2s startup latency per track; streaming
  (chunked) decode would remove this.
- Output device selection is bypassed (WebAudio renders to the browser's default output).
- Signature (`media.format`) spoofing is approximate.
- Remote/Cast playback doesn't work while taken over.

## Dependencies

- [`mediabunny`](https://github.com/Vanilagy/mediabunny) — container demux + decode
  (installed as a repo devDependency).
