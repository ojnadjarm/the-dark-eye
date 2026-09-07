# The Dark Eye — body

Plain node: the HTTP bridge on `127.0.0.1:8642`, the queue, the intents, the TV
watch, `voice.js` as a forked child (sherpa-onnx — Parakeet STT in, Kokoro TTS
out), `pw-cat` children for speech and mic, and `render/` — `eye-render`, the
Rust overlay on the TV (XWayland) — as the eye. Electron is not resident: it
runs only as `src/canvas-app`, spawned by `src/canvas.js` while he is looking.
Run it with `systemctl --user start dark-eye` (unit: `dark-eye.service`) or
`npm start`; `npm test` runs the node suite, `cd render && cargo test` the
renderer's. Ops: `../RUNBOOK.md`.
