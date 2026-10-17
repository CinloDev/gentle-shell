# Optional local voice dictation

> **Status: not wired yet.** This page documents the acquisition and status layer
> only. No command, menu, microphone capture or transcription uses it yet; the
> planned entry point is `/gentle:voice`. Nothing described here runs at startup.

Voice dictation is optional. It transcribes speech locally with NVIDIA Parakeet
through sherpa-onnx, with no API key and no cloud inference. The runtime and the
model are downloaded only when explicitly requested.

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

node-cpal requires Node 22 or newer. Gentle AI never downloads or installs the
Visual C++ runtime.

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
