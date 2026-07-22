#!/usr/bin/env node
/** Decode every generated recording and build one lazy, multi-speaker shard per phrase. */

import decode from "@audio/decode";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePhraseSamples, buildSegmentAnalysis } from "../.build/assets/phrase-analysis.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(await fs.readFile(path.join(root, "public/content/phrases.json"), "utf8"));
const speakerCatalog = JSON.parse(await fs.readFile(path.join(root, "public/content/speakers.json"), "utf8"));
const thresholds = JSON.parse(await fs.readFile(path.join(root, "config/tone-thresholds.json"), "utf8"));
const audioManifest = JSON.parse(await fs.readFile(path.join(root, "public/audio/phrases/manifest.json"), "utf8"));
const referencesDir = path.join(root, "public/references");
const disclosure = catalog.annotationNotice;
const analysisVersion = "reference-analysis-v2";
const force = process.argv.includes("--force");
const keepWav = process.argv.includes("--keep-wav");
const limitArgument = process.argv.find((value) => value.startsWith("--limit="));
const phrases = limitArgument ? catalog.phrases.slice(0, Number(limitArgument.split("=")[1])) : catalog.phrases;
await fs.mkdir(referencesDir, { recursive: true });

let completed = 0;
const slowedChecks = [];
for (const phrase of phrases) {
  const outputPath = path.join(referencesDir, `${phrase.id}.json`);
  const freshShard = force ? null : await loadFreshShard(outputPath, phrase);
  if (freshShard) {
    for (const speaker of speakerCatalog.speakers) {
      assertSlowedEquivalent(phrase.id, speaker.id, freshShard.variants[`${speaker.id}-natural`], freshShard.variants[`${speaker.id}-slowed`]);
    }
    completed += 1;
    continue;
  }
  const shard = { version: analysisVersion, phraseId: phrase.id, disclosure, variants: {}, envelopes: {} };
  for (const speaker of speakerCatalog.speakers) {
    for (const speed of ["natural", "slowed"]) {
      const variantKey = `${speaker.id}-${speed}`;
      const locator = phrase.recordings[speaker.id][speed];
      const audioPath = path.join(root, "public", locator.audioUrl.replace(/^\//, ""));
      const boundaryPath = path.join(root, "artifacts/reference-boundaries", speaker.id, `${phrase.id}.json`);
      const [audioBytes, boundaryDocument] = await Promise.all([
        fs.readFile(audioPath), fs.readFile(boundaryPath, "utf8").then(JSON.parse)
      ]);
      const decoded = await decode(audioBytes);
      const analysis = analyzePhraseSamples(mixChannels(decoded.channelData), decoded.sampleRate);
      if (analysis.error) throw new Error(`${phrase.id} ${variantKey}: ${analysis.error}`);
      const boundaries = boundaryDocument[speed];
      validateBoundaries(phrase, variantKey, boundaries, analysis.durationSec);
      const relativeRuns = shiftRuns(analysis.pitchRuns, analysis.trimStartSec, analysis.trimEndSec);
      const words = boundaries.words.map((timing) => buildMeasuredSegment(timing, analysis.trimStartSec, relativeRuns));
      const syllables = boundaries.syllables.map((timing) => buildMeasuredSegment(timing, analysis.trimStartSec, relativeRuns));
      assertUsableSyllables(phrase, variantKey, syllables);
      shard.variants[variantKey] = {
        audioUrl: locator.audioUrl,
        durationSec: analysis.trimEndSec - analysis.trimStartSec,
        audioStartSec: analysis.trimStartSec,
        audioEndSec: analysis.trimEndSec,
        phraseCentreSemitone: analysis.phraseCentreSemitone,
        pitchRuns: relativeRuns,
        words,
        syllables,
        alignmentFeatures: analysis.alignmentFeatures
          .filter((feature) => feature.timeSec >= analysis.trimStartSec && feature.timeSec <= analysis.trimEndSec)
          .map((feature) => ({ ...feature, timeSec: feature.timeSec - analysis.trimStartSec })),
        checksum: createHash("sha256").update(audioBytes).digest("hex"),
        analysisStatus: "measured"
      };
    }
    assertSlowedEquivalent(phrase.id, speaker.id, shard.variants[`${speaker.id}-natural`], shard.variants[`${speaker.id}-slowed`]);
  }
  for (const speed of ["natural", "slowed"]) shard.envelopes[speed] = buildEnvelope(phrase, shard, speed);
  await fs.writeFile(outputPath, `${JSON.stringify(shard)}\n`);
  if (!keepWav) await deleteStagingWavs(phrase.id);
  completed += 1;
  if (completed % 10 === 0 || completed === phrases.length) process.stdout.write(`Analyzed ${completed}/${phrases.length} phrase shards\n`);
}
const worstSlowedCheck = slowedChecks.toSorted((left, right) => right.medianDifference - left.medianDifference)[0];
if (worstSlowedCheck) {
  process.stdout.write(`Worst slowed/natural median pitch difference: ${worstSlowedCheck.medianDifference.toFixed(3)} semitones (${worstSlowedCheck.phraseId}, ${worstSlowedCheck.speakerId})\n`);
  if (worstSlowedCheck.medianDifference > thresholds.analysis.slowedContourToleranceSemitone) {
    throw new Error(`Slowed contour tolerance exceeded by ${worstSlowedCheck.medianDifference.toFixed(3)} semitones`);
  }
}

async function loadFreshShard(outputPath, phrase) {
  try {
    const shard = JSON.parse(await fs.readFile(outputPath, "utf8"));
    if (shard.version !== analysisVersion || shard.phraseId !== phrase.id || Object.keys(shard.variants || {}).length !== speakerCatalog.speakers.length * 2) return null;
    for (const speaker of speakerCatalog.speakers) {
      for (const speed of ["natural", "slowed"]) {
        const key = `${speaker.id}-${speed}`;
        const bytes = await fs.readFile(path.join(root, "public", phrase.recordings[speaker.id][speed].audioUrl.replace(/^\//, "")));
        if (createHash("sha256").update(bytes).digest("hex") !== shard.variants[key]?.checksum) return null;
      }
    }
    return shard;
  } catch { return null; }
}

function validateBoundaries(phrase, variantKey, boundaries, duration) {
  if (!boundaries || boundaries.words.length !== phrase.words.length || boundaries.syllables.length !== phrase.syllableCount) {
    throw new Error(`${phrase.id} ${variantKey}: boundary count mismatch`);
  }
  for (const level of ["words", "syllables"]) {
    let previous = -Infinity;
    for (const item of boundaries[level]) {
      if (item.startSec < previous || item.endSec <= item.startSec || item.endSec > duration + .2) throw new Error(`${phrase.id} ${variantKey}: non-monotonic ${level}`);
      previous = item.endSec;
    }
  }
}

function assertUsableSyllables(phrase, variantKey, analyses) {
  const syllables = phrase.words.flatMap((word) => word.syllables);
  for (const [index, analysis] of analyses.entries()) {
    if (syllables[index].citationTone === 5) continue;
    const points = analysis.pitchRuns.flatMap((run) => run.points);
    if (!points.length || !Number.isFinite(analysis.medianRelativeSemitone)) throw new Error(`${phrase.id} ${variantKey}: no usable full-tone pitch for ${analysis.segmentId}`);
  }
}

function assertSlowedEquivalent(phraseId, speakerId, natural, slowed) {
  const differences = natural.syllables.map((segment, index) => Math.abs(segment.medianRelativeSemitone - slowed.syllables[index].medianRelativeSemitone));
  const usable = differences.filter(Number.isFinite).toSorted((left, right) => left - right);
  const medianDifference = quantile(usable, .5);
  slowedChecks.push({ phraseId, speakerId, medianDifference });
}

function buildEnvelope(phrase, shard, speed) {
  return phrase.words.flatMap((word) => word.syllables).map((syllable, index) => {
    const segments = speakerCatalog.speakers.map((speaker) => shard.variants[`${speaker.id}-${speed}`].syllables[index]);
    const range = (selector) => {
      const values = segments.map(selector).filter(Number.isFinite).sort((a, b) => a - b);
      return { low: quantile(values, .1), median: quantile(values, .5), high: quantile(values, .9) };
    };
    return {
      segmentId: syllable.id,
      start: range((item) => item.startRelativeSemitone), end: range((item) => item.endRelativeSemitone),
      median: range((item) => item.medianRelativeSemitone), excursion: range((item) => item.excursionSemitone),
      duration: range((item) => item.endSec - item.startSec), voicedRatio: range((item) => item.voicedRatio)
    };
  });
}

function buildMeasuredSegment(timing, trimStartSec, runs) {
  const exactStart = timing.startSec - trimStartSec;
  const exactEnd = timing.endSec - trimStartSec;
  for (const padding of [0, .025, .05, .08]) {
    const segment = buildSegmentAnalysis(timing.segmentId, Math.max(0, exactStart - padding), exactEnd + padding, runs, timing.timingConfidence);
    if (segment.pitchRuns.some((run) => run.points.length)) { segment.startSec = exactStart; segment.endSec = exactEnd; return segment; }
  }
  return buildSegmentAnalysis(timing.segmentId, exactStart, exactEnd, runs, timing.timingConfidence);
}

function shiftRuns(runs, startSec, endSec) {
  return runs.map((run) => ({ points: run.points.filter((point) => point.timeSec >= startSec && point.timeSec <= endSec).map((point) => ({ ...point, timeSec: point.timeSec - startSec })) })).filter((run) => run.points.length);
}
function mixChannels(channels) {
  if (channels.length === 1) return channels[0];
  const mixed = new Float32Array(channels[0].length);
  for (const channel of channels) for (let index = 0; index < mixed.length; index += 1) mixed[index] += channel[index] / channels.length;
  return mixed;
}
function quantile(values, position) {
  if (!values.length) return 0;
  const point = (values.length - 1) * position, low = Math.floor(point), high = Math.ceil(point);
  return low === high ? values[low] : values[low] * (high - point) + values[high] * (point - low);
}
async function deleteStagingWavs(phraseId) {
  await Promise.all(speakerCatalog.speakers.flatMap((speaker) => ["natural", "slowed"].map((speed) => fs.rm(path.join(root, "audio-staging", speaker.id, `${phraseId}-${speed}.wav`), { force: true }))));
}
