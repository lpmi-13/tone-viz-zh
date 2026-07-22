# Standard Mandarin Tone Visualizer Implementation Plan

## Goal

Build a static, single-page Standard Mandarin web application derived from the existing Thai application in `../tone-viz`. The app should help learners listen to tones in complete phrases, inspect the tones that speakers actually produce in context, record their own attempts, and compare pitch relationships without presenting connected speech as a sequence of idealized textbook curves.

The proof of concept (PoC) will:

- Run its complete build and content-generation pipeline on the current CPU-only machine.
- Use an open-weight, Apache-2.0 Mandarin TTS model without voice cloning.
- Select exactly six fixed model speakers automatically: three female and three male.
- Generate all pronunciations, annotations, alignments, reference analyses, and speaker selections without manual review.
- Clearly identify all generated and inferred content as automatic and not human reviewed.
- Ship only static audio, metadata, and browser code; the deployed application will not run a TTS or ASR model.

Human review may be added later, but it is not a PoC release gate and must not be required by the initial architecture.

## Current Context and Constraints

The sibling Thai application already provides the main product and technical foundation:

- A dependency-light TypeScript single-page application.
- Static phrase audio and lazy per-phrase analysis shards.
- Browser microphone recording and upload fallback.
- YIN-style pitch extraction with unvoiced-run preservation.
- Phrase-relative semitone normalization.
- Non-pitch phrase alignment and relational feedback.
- Word and syllable zoom, perception questions, free-form exploration, and mobile browser tests.

The current machine has:

- Intel Core i5-8365U: four physical cores and eight threads with AVX2.
- Approximately 15 GiB RAM.
- Approximately 30 GB free disk space at planning time.
- Python 3.10 and Node.js 24.
- FFmpeg and Docker.
- No GPU and no local Conda installation.

Inference speed is therefore a build-time concern, not an interactive product concern. The static application must remain fast regardless of how long offline corpus generation takes.

## Product Principles

### Use measured speech, not a fabricated ideal contour

Mandarin tones in connected speech are affected by coarticulation, speech rate, focus, phrase position, intonation, segmental context, and tone sandhi. A non-final third tone commonly lacks the final rise associated with its isolated citation form. The UI must distinguish:

- The lexical or citation tone.
- The expected contextual surface realization.
- The contour measured from the selected speaker's recording.

Canonical contours should appear only as small explanatory glyphs. They must not be rendered as though they were measured targets.

### Compare relationships and features, not an exact line

Production feedback should use a tolerant envelope derived from the six selected speakers and features such as direction, register, excursion, turning point, and duration. It should not require the learner to reproduce one model speaker's exact curve.

### Keep uncertainty visible

Pitch tracking can become unreliable during low, creaky, or irregular voicing. Unvoiced and low-confidence regions must remain visible as gaps or reduced-opacity regions. The app should decline to make strong claims when the evidence is weak.

### Keep the PoC fully automatic

The PoC may reject low-confidence phrases or speakers, but it must not pause for a human approval step. Every automated decision should be reproducible, versioned, and auditable.

## Recommended TTS Stack

### Primary model

Use [`hexgrad/Kokoro-82M-v1.1-zh`](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) through [`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx).

Reasons:

- Apache-2.0 model licence.
- 82 million parameters.
- 100 fixed Chinese speaker identities.
- 55 female (`zf_*`) and 45 male (`zm_*`) speaker IDs.
- 24 kHz output in the sherpa-onnx conversion.
- Offline CPU inference.
- No prompt audio, reference recording, speaker enrolment, or cloning workflow.

The model and speaker mapping are documented in the [sherpa-onnx Kokoro v1.1 page](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html).

### Quality challengers

- Use the single-speaker Chinese MeloTTS model as an optional independent intelligibility baseline. It cannot satisfy the six-speaker requirement.
- Consider the 174-speaker AISHELL-3 VITS model only if Kokoro fails the PoC tone gates. Its documented sherpa-onnx output is 8 kHz, and its complete distribution terms must be audited before it is shipped.

The initial implementation should not include ChatTTS, XTTS, F5-TTS, or other cloning-oriented or substantially heavier model stacks.

## Proposed Repository Structure

```text
config/
  speakers.json
  speaker-selection.json
  tone-thresholds.json
  generation.json

content/
  corpus-source.json
  pronunciation-overrides.json
  timing-overrides.json

models/
  README.md

scripts/
  import_corpus.py
  build_diagnostic_corpus.py
  generate_speaker_screen.py
  score_speakers.py
  select_speakers.py
  generate_phrase_audio.py
  align_references.py
  analyze_references.mjs
  validate_content.mjs

src/
  app.ts
  audio.ts
  mandarin.ts
  phrase-analysis.ts
  phrase-chart.ts
  phrase-types.ts
  pitch.ts
  styles.css
  index.html

public/
  content/phrases.json
  content/speakers.json
  references/
  audio/phrases/

artifacts/
  speaker-selection/

tests/
  content/
  unit/
  browser/
```

Downloaded models, full-resolution intermediate WAV files, temporary alignment corpora, and derived screening clips should be ignored by Git. Model IDs, revisions, licences, checksums, and generation parameters must remain committed in manifests.

## Data Model

### Speaker metadata

Speakers must be data-driven from the beginning rather than represented by a TypeScript union.

```json
{
  "id": "speaker-f1",
  "displayName": "Speaker F1",
  "model": "hexgrad/Kokoro-82M-v1.1-zh",
  "modelRevision": "<pinned revision>",
  "kokoroName": "zf_000",
  "kokoroSid": 0,
  "genderGroup": "female",
  "selectionMode": "fully-automated-poc-v1",
  "humanReviewed": false,
  "acousticDescription": "lower register, measured pace, darker spectrum"
}
```

`genderGroup` comes from the model's published `zf` and `zm` categories. Age and region must remain `null` unless trustworthy source metadata becomes available. Acoustic properties must not be presented as inferred demographic facts.

### Phrase and syllable metadata

```json
{
  "id": "phrase-example",
  "hanzi": "你好",
  "translation": "Hello",
  "annotationStatus": "automatic-unreviewed",
  "words": [
    {
      "id": "w1",
      "hanzi": "你好",
      "syllables": [
        {
          "id": "w1s1",
          "hanzi": "你",
          "pinyin": "nǐ",
          "citationTone": 3,
          "surfaceRealization": "third-tone-sandhi",
          "surfaceToneClass": "sandhi-rising",
          "annotationStatus": "automatic-unreviewed"
        },
        {
          "id": "w1s2",
          "hanzi": "好",
          "pinyin": "hǎo",
          "citationTone": 3,
          "surfaceRealization": "citation",
          "surfaceToneClass": "tone-3-final",
          "annotationStatus": "automatic-unreviewed"
        }
      ]
    }
  ]
}
```

Required surface-realization categories include:

- `citation`
- `half-third`
- `third-tone-sandhi`
- `yi-sandhi`
- `bu-sandhi`
- `neutral-after-1`
- `neutral-after-2`
- `neutral-after-3`
- `neutral-after-4`

## Corpus Strategy

### PoC corpus

Begin with 60 phrases of approximately 3-10 syllables. The set should contain:

- Balanced occurrences of all four full tones.
- Neutral tones after each full-tone category.
- Third tones before T1, T2, T3, T4, and pauses.
- Examples of third-tone sandhi, 一 sandhi, and 不 sandhi.
- Tones in phrase-initial, medial, and final positions.
- Statements, questions, common requests, and short conversational phrases.
- Enough lexical and segmental variety to prevent the speaker selector from optimizing for a small set of vowels or consonants.

Scale to 250 and then 500 phrases only after the 60-phrase pipeline passes its automated gates.

### Automatic pronunciation and annotation

Use two independent pronunciation paths, initially Misaki's Chinese G2P and pypinyin.

1. Segment the sentence into words and Hanzi syllables.
2. Generate citation pinyin with both systems.
3. Accept syllables where the systems agree after normalization.
4. Apply deterministic third-tone, 一, and 不 sandhi rules.
5. Resolve neutral-tone forms through an allowlisted lexicon.
6. Reject a phrase automatically when unresolved polyphonic readings or segmentation disagreements remain.
7. Store tool versions, rule versions, and `automatic-unreviewed` status.

For the PoC, conservative exclusion is preferable to silently guessing an ambiguous reading.

## Fully Automated Six-Speaker Selection

### Objective

Select exactly three female and three male voices from all 100 Chinese Kokoro speakers. Selected voices must first pass technical, intelligibility, tone, and identity-stability gates. Diversity is optimized only among passing speakers.

### Diagnostic corpus

Build 16-24 controlled phrases specifically for screening. They should cover:

- T1-T4 in multiple phrase positions.
- Neutral tones.
- T2/T3 contrasts.
- Full and half third tones.
- Third-tone, 一, and 不 sandhi.
- Questions and statements.
- Short and long utterances.
- Balanced initials, finals, and vowel nuclei.

Every candidate must synthesize the same text with the same generation parameters.

### Screening generation

`generate_speaker_screen.py` should:

1. Load the Kokoro model once.
2. Generate every diagnostic phrase for all 55 `zf_*` and 45 `zm_*` speakers.
3. Record generation time, duration, sample rate, peak, RMS, clipping, checksum, and exact input.
4. Resume from valid manifest entries.
5. Use bounded CPU concurrency.

This produces approximately 1,600-2,400 short clips. Screening WAV files can be removed after their measurements and hashes are recorded.

### Technical quality gates

Reject a speaker for:

- Missing, empty, truncated, or repeated output.
- Clipping or invalid sample values.
- Excessive leading, trailing, or internal silence.
- Implausible duration relative to the cohort and text.
- Insufficient voiced-frame coverage.
- Failed forced alignment on any critical diagnostic phrase.
- Unstable output across deterministic reruns.

### Automated intelligibility gate

Use a pinned CPU Mandarin ASR model, initially `sherpa-onnx-paraformer-zh-small-2024-03-09`.

For each speaker calculate:

- Aggregate character error rate.
- Deletions, insertions, and repetitions.
- Exact recognition of every tone-diagnostic target word.
- Alignment success and confidence.

ASR is an intelligibility check, not evidence of tone correctness.

### Automated tone-fidelity gate

After syllable alignment, calculate for each diagnostic syllable:

- Start, end, minimum, maximum, and median F0 in semitones.
- Net movement and excursion.
- Turning-point position.
- Register relative to the phrase median.
- Duration, voiced ratio, and pitch confidence.

Train a small deterministic classifier per speaker to predict the expected contextual surface-tone class. Use leave-phrase-out cross-validation.

Record:

- Balanced four-tone classification accuracy.
- T2 versus T3 separation.
- T1 levelness and relative register.
- T2 rise magnitude and timing.
- T3 low-target depth.
- T4 fall magnitude.
- Neutral-tone duration and prominence.
- Expected movement in each sandhi context.

Reject speakers with missing essential tone evidence, poor cross-validated separation, or performance below a versioned threshold for any required tone category. Cohort percentiles may help set initial PoC thresholds, but basic directional requirements must remain absolute.

### Speaker-identity stability

Use the Mandarin CAM++ speaker embedding model available through sherpa-onnx's CPU speaker-embedding extractor.

For each candidate:

1. Extract one embedding per diagnostic phrase.
2. L2-normalize and average the embeddings.
3. Measure within-speaker cosine consistency.
4. Compare within-speaker variation with distances to other candidates.
5. Reject candidates whose apparent identity changes excessively across phrases.

### Acoustic diversity profile

Build a standardized vector for every passing speaker containing:

- Mean speaker embedding, reduced deterministically with PCA.
- Median log-F0 and pitch percentiles.
- Phrase-level pitch range and variability.
- Spectral centroid and spectral tilt.
- MFCC statistics.
- Harmonic-to-noise ratio, cepstral prominence, and aperiodicity.
- Speaking rate, pause ratio, and duration variability.
- Tone-excursion profile.

Age-related acoustic properties may contribute to diversity, but they must be labelled only as measured traits such as lower pitch, greater aperiodicity, or slower pace. They must not be converted into an asserted age. Speaker embeddings may reflect accent differences, but they must not be converted into a region label.

### Constrained selection algorithm

Run selection independently for the female and male cohorts.

1. Divide passing speakers into low-, middle-, and high-median-pitch thirds.
2. Require one selected speaker from each third.
3. Enumerate every valid three-speaker combination.
4. Reject combinations with a pair below the minimum speaker-embedding distance.
5. Rank the remaining combinations with:
   - 55% minimum pairwise speaker-embedding distance.
   - 20% pitch and register coverage.
   - 15% spectral and voice-quality diversity.
   - 10% speaking-rate diversity.
6. Select the highest-ranked trio.
7. Retain two compatible alternates for each gender.

All selected speakers must already pass the quality gates. A highly unusual voice cannot trade diversity against poor tone quality.

### Failure policy

- If at least three speakers of each gender pass, select and publish the optimal six.
- If fewer than three pass in either group, stop the content build and emit a machine-readable failure report.
- Do not silently lower thresholds.
- Threshold changes require a versioned configuration update and a new selection manifest.
- Do not require or wait for human approval.

### Selection artifacts

```text
artifacts/speaker-selection/
  screening-manifest.json
  features.json
  quality-gates.json
  ranking.json
  selected-speakers.json
  alternates.json
  acoustic-map.svg
  report.html
```

`selected-speakers.json` must contain the selection algorithm version, model revisions, feature normalization statistics, thresholds, input hashes, and `humanReviewed: false`.

## Full Audio Generation

`generate_phrase_audio.py` should:

1. Load the pinned full-precision Kokoro ONNX model once.
2. Iterate the selected six speakers and accepted corpus phrases.
3. Generate natural-speed 24 kHz mono WAV.
4. Validate each output immediately.
5. Write or update a resumable checksum manifest.
6. Encode the accepted result to a browser-compatible compressed format.
7. Delete full-resolution staging audio only after analysis and checksums succeed.

Benchmark full-precision and int8 inference on the diagnostic set. Prefer full precision unless int8 is perceptually proxied and acoustically equivalent under the automated measures. Initial resource targets are:

- Peak resident memory below 6 GiB.
- Mean real-time factor below 2.
- At most four physical-core-equivalent inference threads in use.
- Temporary storage below 5 GiB through incremental cleanup.

### Slowed playback

Create slowed playback from each accepted natural recording with FFmpeg using pitch-preserving time stretching around 0.75-0.8x.

- Label it `slowed`, not natural slow speech.
- Scale accepted natural boundaries by the exact duration ratio.
- Verify that time-normalized natural and slowed pitch tracks remain within a configured semitone tolerance.
- Do not use a second TTS pass for the default slowed variant.

## Forced Alignment

Kokoro does not provide word-boundary events. Use Montreal Forced Aligner with its Mandarin acoustic model and dictionary in a pinned CPU environment or container.

The alignment pipeline should:

1. Construct a space-delimited transcript from the accepted word segmentation.
2. Validate dictionary coverage before alignment.
3. Align each natural WAV.
4. Map word and phone intervals to Hanzi syllables.
5. Validate monotonicity, duration, coverage, and confidence.
6. Scale timings for the derived slowed variant.
7. Reject clips that cannot be aligned automatically.

Manual timing overrides may remain supported by the schema for future work, but the PoC must neither require nor create them.

## Reference Pitch Analysis

Reuse the Thai application's browser-compatible core where practical:

- Convert F0 to semitones.
- Centre each phrase on its robust median.
- Preserve separate voiced runs and unvoiced gaps.
- Store confidence and energy alongside pitch.
- Align learner recordings using energy, voicing, and spectral change rather than pitch.

Add Mandarin-specific per-syllable features:

- Relative start, end, minimum, maximum, and median pitch.
- Excursion, slope, and turning point.
- Duration and voiced ratio.
- Surface-tone class and sandhi rule.
- Cross-speaker feature envelope.

The six-speaker envelope is a collection of selected model examples, not a native-speaker population norm, and the UI must label it accordingly.

## UI and Interaction Design

### Primary modes

1. **Listen and imitate**: phrase browsing, contextual playback, syllable zoom, recording, and comparison.
2. **Hear the contrast**: audio-first perception questions with randomized speakers.
3. **Explore**: record or upload an arbitrary short phrase and visualize it without correctness claims.

### Phrase presentation

Show aligned rows for:

- Simplified Chinese characters.
- Pinyin with tone marks.
- Tone number or neutral marker plus a small contour glyph.
- English translation.

Tone colour must be supplemented by number, name, and shape. Selecting a character or word highlights the matching chart interval and opens its contextual explanation.

Example:

> Underlying Tone 3; automatically classified as a low half-third here because another syllable follows.

### Audio controls

- Speaker selector populated from `public/content/speakers.json`.
- Natural and slowed playback.
- Whole-phrase play and syllable/word loop.
- Random-speaker mode.
- Optional comparison of the same phrase across all six speakers.

### Chart layers

- Selected speaker's measured contour as the primary solid line.
- Optional thin lines or a shaded range for the other five speakers.
- Citation-tone glyphs as schematic annotations.
- Learner contour as a distinct overlay.
- Explicit word and syllable boundaries.
- Confidence-dependent opacity and open unvoiced gaps.
- Fixed phrase-relative semitone ticks.

Zoom may magnify time but must not silently rescale pitch. If a different vertical scale is ever used, the UI must label the magnification explicitly.

### Learning flow

1. Play the phrase with labels and chart hidden.
2. Answer a perception question.
3. Reveal the measured contour.
4. Select and loop a word or syllable in context.
5. Record the complete phrase.
6. Align and compare locally.
7. Show one actionable cue and at most two segments to inspect.

### Feedback rules

Feedback must use the annotated contextual realization and six-speaker envelope. Examples:

- "The Tone 2 rise started later than these model references."
- "Keep this non-final Tone 3 low; it does not need a final rise."
- "The Tone 4 began low, leaving little room for the fall."
- "This neutral syllable was longer and more prominent than the references."
- "Pitch was irregular here, so the app cannot make a confident comparison."

Do not show numerical pronunciation scores or claim that the learner produced a different lexical tone.

### Perception questions

- Which syllable rises, falls, or sits lowest?
- Which of two tone sequences was spoken?
- Are two productions the same or different after changing speaker?
- Identify a target with Hanzi and chart hidden.
- Compare natural and slowed playback.

Only generate a question when the measured references make its answer unambiguous under configured margins.

### Disclosure

The Credits/About view and content metadata must state:

> Voices, pronunciations, tone annotations, alignments, and selections were generated or inferred automatically and have not been reviewed by a Mandarin speaker.

## Implementation Phases

### Phase 1: Scaffold and generalize

- Port the static build, recording, playback, charting, analysis, and tests from `../tone-viz`.
- Replace Thai-specific types and hardcoded speakers.
- Add Mandarin language configuration and data-driven tone categories.
- Verify a content-free production build.

Exit criterion: the shell app builds and renders from a small fixture with dynamic speakers.

### Phase 2: Automatic annotation and diagnostic corpus

- Implement word segmentation, dual G2P comparison, sandhi rules, and ambiguity rejection.
- Create the diagnostic set and 60-phrase PoC corpus.
- Add annotation and corpus validation tests.

Exit criterion: all published fixture phrases have complete automatic annotations and no unresolved pronunciation conflicts.

### Phase 3: CPU model benchmark and speaker selection

- Pin and download Kokoro, speaker-embedding, ASR, and alignment models.
- Generate all 100 diagnostic voice sets.
- Run technical, ASR, tone, stability, and diversity scoring.
- Select exactly three female and three male speakers automatically.

Exit criterion: a reproducible six-speaker manifest and two alternates per gender are produced without human input.

### Phase 4: Audio generation and alignment pilot

- Generate the 60 phrases for all six speakers.
- Create pitch-preserved slowed variants.
- Run MFA and produce syllable boundaries.
- Analyze references and validate every recording.

Exit criterion: 720 recordings exist: 60 phrases x 6 speakers x 2 playback variants, all with valid checksums, timings, and analysis.

### Phase 5: Mandarin UI and learner analysis

- Implement Hanzi/pinyin/tone rows.
- Add contextual realization explanations.
- Add multi-speaker measured contours and envelopes.
- Adapt perception questions and production feedback.
- Retain recording, upload fallback, and free-form exploration.

Exit criterion: the full PoC learning flow works on desktop and mobile browser tests.

### Phase 6: Scale and deploy

- Expand first to 250 and then 500 phrases if automated validation remains reliable.
- Generate only the selected six speakers.
- Decide whether production audio remains inside the static deployment or uses a versioned asset host.
- Preserve local paths and an optional deploy-time asset base URL.

At 500 phrases, six speakers, and two variants, the corpus contains 6,000 recordings. Based on the sibling application, final audio and reference assets may approach 0.8-1.0 GB.

## Verification

### Unit tests

- Pinyin normalization and dual-G2P agreement.
- Third-tone, 一, 不, and neutral-tone rules.
- Speaker feature normalization and PCA determinism.
- Quality-gate decisions.
- Exact constrained selection on fixed fixtures.
- Phrase-relative pitch invariance.
- Unvoiced-gap preservation.
- Surface-tone-aware feedback.

### Pipeline tests

- `--limit` smoke generation on one speaker and phrase.
- Resumption without overwriting valid audio.
- Checksum failure detection.
- Rejection of clipping, silence, truncation, and repetition fixtures.
- ASR normalization and character-error calculation.
- Alignment rejection and success fixtures.
- Natural/slowed contour equivalence.
- Reproducible selection from a frozen feature fixture.

### Browser tests

- Dynamic six-speaker selector.
- Search by Hanzi, pinyin, and English.
- Topic and tone filters.
- Lazy reference-shard loading.
- Natural/slowed playback and contextual loops.
- Chart hiding and reveal flow.
- Perception questions across speakers.
- Microphone permission denial and upload fallback.
- Recording, alignment, feedback, and free-form exploration.
- Narrow mobile layout, keyboard use, and reduced-motion behaviour.

### Content validation

Fail the build when any published item has:

- Missing source attribution or translation.
- Unresolved automatic pronunciation disagreement.
- Missing citation or surface-tone metadata.
- Missing speaker recording or slowed variant.
- Invalid checksum or audio metadata.
- Failed alignment or non-monotonic timing.
- No usable pitch evidence where full-tone evidence is required.
- Missing automatic/unreviewed disclosure.
- A speaker manifest other than exactly three female and three male selections.

## PoC Acceptance Criteria

- The complete pipeline runs on the current machine without a GPU.
- Exactly six speakers are selected automatically: three `zf_*` and three `zm_*`.
- No prompt audio, reference recording, voice cloning, or runtime synthesis is used.
- Speaker selection is reproducible from pinned inputs and configuration.
- The PoC contains 60 phrases and 720 validated recordings.
- Every phrase has automatic Hanzi segmentation, pinyin, citation tone, surface realization, translation, and attribution.
- Every recording has validated audio, timings, pitch analysis, and checksums.
- The app never demands a full rising third-tone contour in a context where the expected realization is low or sandhi-modified.
- Low-confidence pitch produces cautious feedback rather than a false judgment.
- The deployed application performs all learner recording and pitch analysis locally.
- The deployed application makes no network request to a TTS, ASR, or alignment service.
- Unit, pipeline, content, and browser test suites pass.
- The UI clearly states that the PoC has not been reviewed by a Mandarin speaker.

## Main Risks and Mitigations

### The entire model cohort may share systematic tone errors

Cross-speaker agreement cannot prove correctness if every speaker shares the same model bias. Mitigate this with absolute movement requirements, diagnostic minimal contexts, a surface-tone classifier, and an optional independent single-speaker model as an automated challenger.

### ASR may accept contextually predictable words despite weak tones

Treat ASR only as an intelligibility gate. Tone gates must use aligned F0, duration, and voicing features independently.

### Forced alignment may fail on synthetic pronunciation

Validate dictionary coverage before synthesis, use conservative phrase exclusion, retain confidence scores, and prove alignment on the 60-phrase pilot before scaling.

### Pitch detection may fail on low or irregular Tone 3

Preserve gaps, use voiced ratio and confidence, add an autocorrelation fallback, and avoid rejecting a Tone 3 solely because the lowest region becomes aperiodic.

### Acoustic diversity may be mistaken for demographic diversity

Expose only measured acoustic descriptions. Do not infer or display age or region without source metadata.

### Six speakers substantially increase static assets

Generate and analyze incrementally, delete staging WAVs after validation, lazy-load one reference shard at a time, and support an optional versioned asset host for the 500-phrase deployment.

## Optional Post-PoC Work

Manual review can later be added as metadata rather than as an architectural dependency:

- Review status per speaker, phrase, pronunciation, or alignment.
- Verified age or regional metadata when supplied by a trustworthy source.
- Human approval or exclusion lists layered over the automated ranking.
- Comparison between automatically selected and reviewer-selected cohorts.
- Native-speaker recordings as additional references without replacing the fixed synthetic speakers.

The initial PoC remains complete and deployable without any of these additions.

## Technical References

- [Kokoro-82M-v1.1-zh model card](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)
- [sherpa-onnx Kokoro v1.1 speaker mapping and CPU examples](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)
- [sherpa-onnx speaker embedding extraction](https://k2-fsa.github.io/sherpa/onnx/c-api/html/speaker_embedding.html)
- [sherpa-onnx offline Paraformer ASR](https://k2-fsa.github.io/sherpa/onnx/c-api/html/offline_asr.html)
- [Montreal Forced Aligner](https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner)
- [Mandarin MFA acoustic models](https://mfa-models.readthedocs.io/en/latest/acoustic/Mandarin/index.html)
- [Contextual tonal variations in Mandarin](https://www.sciencedirect.com/science/article/pii/S0095447096900340)
- [Characterizing the distinctive acoustic cues of Mandarin tones](https://kuppl.ku.edu/sites/kuppl/files/documents/publications/Tupper_et_al._JASA_2020_Mandarin_tones.pdf)
- [Production and perception of Tone 3 focus in Mandarin](https://pmc.ncbi.nlm.nih.gov/articles/PMC4960255/)
