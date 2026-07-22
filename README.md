# Mandarin Phrase Tones

A static, local-first Standard Mandarin tone visualizer for complete phrases. It distinguishes lexical tone, automatically inferred contextual realization, and measured model output; it never presents citation glyphs as measured targets or gives a numerical pronunciation score.

## Current checkout

The application and offline pipeline are implemented, and this checkout contains a completed automatic production run: a 100-speaker screen, three selected `zf` voices and three selected `zm` voices, 60 live-G2P phrases, 720 generated audio variants, 360 forced alignments, and 60 measured multi-speaker reference shards. All generated and inferred material remains explicitly marked `humanReviewed: false`.

The repository does **not** substitute textbook curves or oscillator data for measured speech. `npm run content:validate:release` verifies the generated selection, live pronunciation evidence, audio checksums, alignments, and pitch analyses before deployment.

## Develop and verify

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Microphone capture needs localhost or HTTPS; upload is always available as a fallback.

```bash
npm test
npm run content:validate
npm run build
```

The build is written to `dist/`. The deployed browser only serves static content and performs learner pitch extraction and non-pitch alignment locally.

## Offline production pipeline

Install Python dependencies into an isolated environment, then download checksum-pinned CPU models:

```bash
python3 -m venv .venv-pipeline
.venv-pipeline/bin/pip install -r requirements-pipeline.txt
npm run models:download
npm run diagnostics:build
```

MFA 3.3.8 also needs its Conda-provided Kaldi/OpenFST binaries, Python 3.11,
and the optional Chinese tokenizers. For example, using a local Conda or
micromamba prefix:

```bash
micromamba create -p .mfa -c conda-forge python=3.11 montreal-forced-aligner=3.3.8 -y
.mfa/bin/pip install spacy-pkuseg dragonmapper hanziconv
MFA_ROOT_DIR="$PWD/.mfa-data" .mfa/bin/mfa model download dictionary mandarin_china_mfa
MFA_ROOT_DIR="$PWD/.mfa-data" .mfa/bin/mfa model download acoustic mandarin_mfa
```

The pipeline stages are intentionally resumable and fail closed. Run `npm run tts:benchmark` first to compare full/int8 RTF and normalized pitch on identical diagnostics; production remains pinned to full precision unless the committed configuration and automatic equivalence report explicitly change that decision.

1. `npm run speakers:screen` generates the same 20 diagnostic phrases for all 100 mapped Chinese voices, validates WAVs immediately, and records deterministic reruns.
2. `MFA_ROOT_DIR="$PWD/.mfa-data" .venv-pipeline/bin/python scripts/measure_speaker_screen.py --mfa .mfa/bin/mfa` loads pinned Paraformer and CAM++ once, validates and runs MFA, then extracts aligned pitch landmarks, ASR results, identity embeddings, and acoustic profiles for every clip. Add `--download-mfa-models` when the local MFA model cache has not been populated yet.
3. `npm run speakers:score` applies technical, intelligibility, contextual-tone, identity-stability, and evidence-completeness gates. Its versioned RBF-SVC tone checks use leave-phrase-out predictions and fixed regularization for each published model category. Missing evidence rejects a candidate.
4. `npm run speakers:select` enumerates valid low/middle/high-register trios independently within the model’s published `zf` and `zm` categories, writes the top six, any compatible quality-passing alternates, a deterministic acoustic map, and an audit report. An alternate shortfall is recorded rather than weakening a quality gate or blocking a valid six-speaker selection.
5. `.venv-pipeline/bin/python scripts/import_corpus.py --live-g2p` requires independent installed pronunciation paths, rejects disagreements, applies sandhi rules, and rebuilds the 60-phrase catalog against the generated selection.
6. `npm run audio:generate` loads full-precision Kokoro once, writes natural 24 kHz mono audio, derives a pitch-preserving 0.78× slowed variant with FFmpeg, and resumes from checksums.
7. `MFA_ROOT_DIR="$PWD/.mfa-data" npm run references:align -- --mfa "$PWD/.mfa/bin/mfa"` validates dictionary coverage and runs the pinned Mandarin MFA models. It selects dictionary-supported character or authored-word tokens and maps them back to syllables. Use `--prepare-only` to inspect its temporary corpus.
8. `npm run references:analyze` uses the browser-compatible pitch core, preserves unvoiced gaps, calculates per-syllable features and six-model envelopes, verifies slowed/natural pitch equivalence, and removes staging WAVs only after success.
9. `npm run content:validate:release` verifies the complete 60 × 6 × 2 asset set before deployment.

The automatic measurement stage writes these scorer contracts:

- `asr.json`: `entries[]` with `speaker`, `phraseId`, `reference`, `hypothesis`, `diagnosticTargetsCorrect`, and `alignmentConfidence`;
- `pitch-features.json`: `syllables[]` with aligned surface class, phrase ID, pitch landmarks, duration, and voiced ratio;
- `embeddings.json`: `entries[]` with one normalized `vector` per `speaker` and diagnostic phrase;
- `acoustic-features.json`: `speakers[]` with `medianLogF0`, pitch percentiles, `spectralVector`, speaking rate, pause ratio, and tone-excursion profile.

No threshold is lowered automatically. Fewer than three passing voices in either published model category produces `failure-report.json` and stops the build.

## Content and UI guarantees

- Search works across Hanzi, marked pinyin, and English, with topic and citation-tone filters.
- Speaker identities come from `public/content/speakers.json`; no TypeScript speaker union exists.
- Labels and contour are hidden for audio-first listening, then reveal aligned Hanzi, pinyin, citation number/name/shape, and contextual explanations.
- The solid line is the selected model recording. Thin lines show the other five selected recordings. Learner audio uses a separate lane and the same fixed phrase-relative semitone scale.
- Pitch confidence changes line opacity and unvoiced regions remain open gaps.
- Feedback uses contextual surface classes and declines strong claims when pitch evidence is weak.
- The About view carries the required automatic/unreviewed disclosure and avoids age or region inference.

## Primary model references

- [Kokoro-82M-v1.1-zh model card](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)
- [sherpa-onnx Kokoro v1.1 mapping and CPU usage](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)
- [sherpa-onnx Paraformer model](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/paraformer-models.html)
- [sherpa-onnx speaker-embedding API](https://k2-fsa.github.io/sherpa/onnx/c-api/html/speaker_embedding.html)

All model-generated and inferred content remains `humanReviewed: false` in the PoC.
