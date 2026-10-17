# Optional local voice dictation

Voice dictation is optional. It transcribes speech locally with NVIDIA Parakeet
through sherpa-onnx, with no API key and no cloud inference. Everything happens
from `/gentle:voice`; nothing described here runs at startup.

## Quick path

1. Run `/gentle:voice` and choose **Download voice dictation**. The
   confirmation lists each component, its size, the destination directory,
   the licenses and the platform limitations. Esc during the download cancels it.
2. Run `/gentle:voice` again and choose **Start dictation**. Speak, then press
   Enter to stop. Esc cancels at any point.
3. The transcript is pasted into the editor draft at the cursor. It is never
   sent automatically. Pi collapses pastes over 1,000 characters or 10 lines into
   a `[paste #N …]` marker; the full text is retained and expanded when you submit.
   Long transcripts are therefore not displayed as editable text in the draft.

## The command

| Topic | Behavior |
|-------|----------|
| Menu | Built-in select and confirm dialogs. **Show status and notices** reports the target, both components, limitations and licenses. |
| Download | Only after the confirmation; runtime first, then the model. A cancelled download keeps components that already finished. |
| Dictation | A compact overlay shows preparing, recording, transcribing. Enter stops recording; the overlay stays until the transcript is ready. |
| Recording limit | After 2 minutes recording stops by itself, and the transcript is pasted without a key press. |
| Insertion | The recognized text goes through Pi's editor paste pipeline, which may collapse long text into a paste marker. A blank result pastes nothing. |
| One at a time | A second `/gentle:voice` while a download or dictation runs is refused with a notice. |
| Cancel and shutdown | Esc, reload or session shutdown aborts the download or cancels the session. A transcript that arrives afterwards is dropped. |
| Where it runs | Interactive TUI parent sessions only. RPC, print, JSON and delegated child sessions refuse it. No model-callable tool exists. |
| Errors | Fixed messages with the action to take, such as installing ALSA or the Visual C++ runtime. Gentle AI never runs those installers. |

The command is tested with fake dialogs, downloads and sessions only. No real
download, native load or microphone recording has been exercised through it.

## What gets downloaded

All versions, sizes and digests are pinned in `lib/voice-artifacts.ts`.

| Component | Source | Size | Verified by |
|-----------|--------|------|-------------|
| `sherpa-onnx-node@1.13.8` | npm registry | 12 KB | `dist.integrity` (SHA-512) |
| `sherpa-onnx-<platform>-<arch>@1.13.8` | npm registry | 9–14 MB | `dist.integrity` (SHA-512) |
| `node-cpal@1.0.0` (microphone capture) | npm registry | 7.7 MB | `dist.integrity` (SHA-512) |
| Parakeet TDT 0.6B v3, int8 | Hugging Face, commit `2bda32ec70b0` | about 670 MB | per-file size and SHA-256 |

The model is the sherpa-onnx export
`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`: `encoder.int8.onnx`,
`decoder.int8.onnx`, `joiner.int8.onnx` and `tokens.txt`.

## Where it is stored

Everything lives in `<Gentle AI config home>/voice` (by default
`~/.pi/gentle-ai/voice`; see `gentlePiConfigHome()`):

```text
voice/
  runtime/sherpa-onnx-1.13.8-node-cpal-1.0.0-<target>/node_modules/
    sherpa-onnx-node/
    sherpa-onnx-<platform>-<arch>/
    node-cpal/
  models/parakeet-tdt-0.6b-v3-int8-2bda32ec70b0/
```

The platform package sits next to `sherpa-onnx-node` because its loader resolves
`../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`. node-cpal loads
`bin/<platform>-<arch>/index.node` from its own directory. The runtime directory
names both native versions, so a runtime installed with other pins is never
reported as the current one.

## How an install stays safe

- **Explicit only.** Importing the voice modules performs no filesystem or
  network access. Status checks never create the voice directory.
- **Streamed and bounded.** Each file is hashed while it streams to disk and is
  cut off as soon as it exceeds its pinned size. A wrong length or digest fails
  the install.
- **Pinned redirects.** npm tarballs are fetched without redirects. Hugging Face
  redirects are followed only over HTTPS to the paths observed for this revision:
  `huggingface.co/api/resolve-cache/...` and `us.aws.cdn.hf.co/xet-bridge-us/...`.
  Any other host, including other CDN regions, is refused.
- **Cancellable and time-bounded.** An install can be aborted. It also stops
  when no data arrives for 60 seconds, or when it runs past 20 minutes for the
  runtime or 2 hours for the model.
- **Checked archives.** Every tarball is validated before anything is
  extracted. Only regular files under `package/` are accepted, within the
  registry's file count and unpacked size. Links, directories, traversal,
  duplicates and Windows device names are refused. No package script runs, and
  no downloaded code is loaded during installation.
- **Atomic publication.** Work happens in a private `.staging-*` directory. The
  install marker is written last, and one rename publishes the component. A
  failure or cancellation removes only that staging directory. An existing
  installation is never partially overwritten: a valid one is kept as is, and an
  invalid one is replaced only by a complete, verified copy.

## Dictation session

`lib/voice-session.ts` records one dictation and returns its text. It never
submits the text or touches the editor; the caller decides what to do with it.

- **Separate process.** `start()` runs `scripts/voice-worker.cjs` with the same
  Node executable, from the runtime directory, with no shell. Microphone
  capture, the model load and the decode all happen in that process, so a
  native crash or a long decode cannot freeze Gentle AI. Importing the module or
  creating a session does nothing until `start()`.
- **Checked before loading.** `start()` first requires both components to be
  reported installed. The worker then checks the files again before it loads
  any native code: every entry in the runtime and model directories must be a
  plain directory or regular file, owned by the current user and not writable
  by everyone (ownership and modes are not checked on Windows). Each required
  runtime file must be present, and each model file must match its pinned size
  and SHA-256. The digests are recomputed on every session, which reads the
  whole model (about 670 MB) before recording starts. Directories above the
  voice home are not checked. These checks catch broken or swapped installs;
  they cannot stop someone with the same user account from replacing the files,
  which is the same as running code as that user.
- **Lifecycle.** A session is used once: `start()` resolves when recording
  begins, `stop()` resolves with `{ text, truncated }`, and `cancel()` (or
  `dispose()`) discards everything, including a transcript that arrives late.
  `start()` resolves while the worker keeps recording; `stop()`, `cancel()` and
  a failed `start()` settle only after the worker has exited. A worker that does
  not exit within 2 seconds of finishing or being cancelled is killed. If the parent
  disappears, the worker sees its input close and stops capturing.
- **Bounds.** Recording stops by itself after 120 seconds, and the worker then
  transcribes what it has (`truncated: true`). Starting (file checks and model
  load) and transcribing each have a 120-second limit. Audio is kept in memory
  only up to the recording limit. All of these are options.
- **Audio.** The worker opens the default input device through node-cpal,
  preferring 32-bit float samples and otherwise using the device's default
  integer or float format. It mixes all channels down to mono and resamples to
  16 kHz in JavaScript (averaging when downsampling, linear interpolation when
  upsampling). No SoX or FFmpeg is used. Less than 0.1 seconds of audio is
  reported as empty, and a blank transcript as no speech.
- **Errors.** The worker reports a fixed code only, and the session turns it
  into a fixed message. Native error text, file paths and environment values
  are never included, and the worker's stderr is discarded.
- **Environment.** The worker gets only home, temp, locale and audio-session
  variables (`HOME`, `USERPROFILE`, `SystemRoot`, `windir`, `TEMP`, `TMP`,
  `TMPDIR`, `XDG_RUNTIME_DIR`, `PULSE_SERVER`, `PULSE_COOKIE`, `LANG`, `LC_ALL`,
  `LC_CTYPE`). Credentials, `PATH`, `NODE_OPTIONS` and loader variables are
  dropped.
- **Protocol.** JSON lines with schema `gentle.voice/v1`. The parent sends
  `start` (with paths computed from the pinned manifests), then `stop` or
  `cancel`. The worker answers `recording`, `transcribing`, and one final
  `result` or `error`. Any other message, an unknown field, more than 16 lines
  or a line over 64 KB stops the worker.

The session has been tested only with scripted fake workers and with the real
worker driving fake capture and recognizer modules. It has not loaded the real
native modules, opened a real microphone or transcribed real speech.

## Platform support

All five targets get the pinned runtime and a `node-cpal@1.0.0` capture binary
built for their architecture (checked from the binary headers, not by loading).

| Target | Prerequisites (not checked before loading) |
|--------|--------------------------------------------|
| macOS arm64 | macOS 11 or newer |
| macOS x64 | macOS 10.12 or newer |
| Linux x64, glibc 2.34+ | ALSA `libasound.so.2` |
| Linux arm64, glibc 2.34+ | ALSA `libasound.so.2` |
| Windows x64 | Microsoft Visual C++ runtime (`vcruntime140.dll`) |

node-cpal requires Node 22 or newer, and a dictation session refuses to start
on an older Node. Gentle AI never downloads or installs the Visual C++ runtime;
a missing runtime is expected to surface as a runtime load failure, which has
not been observed on hardware. `/gentle:voice` then names the runtime to install.

None of these targets has been verified on real hardware yet: native loading,
library paths and microphone capture have not been executed. Linux with a glibc
older than 2.34 is unsupported and the diagnosis names the version found.
Windows ARM64 has no native sherpa-onnx package and is unsupported. musl Linux
is unsupported. WSL is reported as unproven.

## Licenses and attribution

- **Model:** Parakeet TDT 0.6B v3 by NVIDIA, licensed under CC-BY-4.0. The int8
  sherpa-onnx export is by csukuangfj. The export repository has no license file
  of its own; its license is taken from the upstream NVIDIA model.
- **Runtime:** sherpa-onnx, Apache-2.0. The npm tarballs ship no LICENSE or
  NOTICE file. The platform packages bundle onnxruntime (MIT) without its
  license text.
- **Capture:** node-cpal 1.0.0, ISC. The tarball ships no LICENSE or NOTICE file. Its prebuilt
  binaries link Rust crates whose notices are not included.

These gaps are unresolved and are listed in `VOICE_NOTICES`.
