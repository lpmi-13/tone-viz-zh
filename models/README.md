# Offline model inputs

Model binaries are build inputs and are intentionally ignored by Git. Run:

```bash
npm run models:download
```

The downloader reads `config/generation.json`, verifies SHA-256 before extraction, rejects archive path traversal, and installs:

- full-precision and int8 `kokoro-multi-lang-v1_1` at 24 kHz for the diagnostic benchmark (production remains full precision unless the automated equivalence report supports changing it);
- `sherpa-onnx-paraformer-zh-small-2024-03-09` for the intelligibility gate;
- `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` for identity stability and acoustic diversity.

The original Kokoro model revision is pinned to `8c61023a009f8775e2e23c274ff110dff8335480` and is Apache-2.0. The deployed site does not contain or call these models.
