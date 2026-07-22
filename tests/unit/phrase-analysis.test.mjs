import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRelativePitchRuns,
  buildSegmentAnalysis,
  evaluateRelationships,
  hzToSemitone,
  robustMedian
} from "../../.build/assets/phrase-analysis.js";

const frames = (frequencies, offset = 0) => frequencies.map((f0, index) => ({ timeSec: offset + index * .03, f0, confidence: .94, energy: .2 }));

test("phrase-relative pitch is invariant under transposition", () => {
  const original = frames([160, 165, 171, 180, 190, 198]);
  const shifted = frames(original.map((item) => item.f0 * 1.5));
  const a = buildRelativePitchRuns(original, robustMedian(original.map((item) => hzToSemitone(item.f0))))[0].points;
  const b = buildRelativePitchRuns(shifted, robustMedian(shifted.map((item) => hzToSemitone(item.f0))))[0].points;
  a.forEach((point, index) => assert.ok(Math.abs(point.semitone - b[index].semitone) < 1e-9));
});

test("unvoiced intervals remain separate runs", () => {
  const input = [...frames([180, 182, 184]), ...frames([190, 192, 194], .5)];
  assert.equal(buildRelativePitchRuns(input, 60).length, 2);
});

test("segment features include excursion, turning point, and voiced evidence", () => {
  const run = { points: [
    { timeSec: .1, semitone: 1, confidence: .9 }, { timeSec: .2, semitone: -2, confidence: .9 },
    { timeSec: .3, semitone: 2, confidence: .9 }
  ] };
  const segment = buildSegmentAnalysis("s1", 0, .4, [run]);
  assert.equal(segment.excursionSemitone, 4);
  assert.equal(segment.turningPoint, .5);
  assert.ok(segment.voicedRatio > 0);
});

test("surface-aware feedback keeps a non-final third tone low", () => {
  const target = segment("w1s1", 0, .5, -1, -1, -1.2);
  const attempt = segment("w1s1", 0, .5, 0, -1, 2.5);
  const transcript = { text: "你来", syllableCount: 2, recordings: {}, words: [
    { id: "w1", text: "你", hanzi: "你", pinyin: "nǐ", syllables: [{ id: "w1s1", text: "你", hanzi: "你", pinyin: "nǐ", citationPinyin: "ni3", citationTone: 3, lexicalTone: "tone-3", surfaceRealization: "half-third", surfaceToneClass: "tone-3-low", annotationStatus: "automatic-unreviewed", explanation: "" }] },
    { id: "w2", text: "来", hanzi: "来", pinyin: "lái", syllables: [{ id: "w2s1", text: "来", hanzi: "来", pinyin: "lái", citationPinyin: "lai2", citationTone: 2, lexicalTone: "tone-2", surfaceRealization: "citation", surfaceToneClass: "tone-2-rising", annotationStatus: "automatic-unreviewed", explanation: "" }] }
  ] };
  const quiet = segment("w2s1", .5, 1, 0, 0, .5);
  const feedback = evaluateRelationships(
    { audioUrl: "", durationSec: 1, phraseCentreSemitone: 0, pitchRuns: [], words: [], syllables: [target, quiet], alignmentFeatures: [] },
    { analysis: {}, alignment: { confidence: .9, mapping: [], retryReason: null }, alignedPitchRuns: [], words: [], syllables: [attempt, quiet] },
    transcript
  );
  assert.match(feedback.message, /non-final Tone 3/);
  assert.match(feedback.message, /does not need a final rise/);
});

test("weak pitch evidence produces cautious feedback", () => {
  const weak = { ...segment("w1s1", 0, .5, 0, 0, 0), voicedRatio: .05, pitchRuns: [] };
  const syllable = { id: "w1s1", text: "好", hanzi: "好", pinyin: "hǎo", citationTone: 3, surfaceRealization: "citation", surfaceToneClass: "tone-3-final" };
  const feedback = evaluateRelationships(
    { audioUrl: "", durationSec: .5, phraseCentreSemitone: 0, pitchRuns: [], words: [], syllables: [weak], alignmentFeatures: [] },
    { analysis: {}, alignment: { confidence: .9, mapping: [], retryReason: null }, alignedPitchRuns: [], words: [], syllables: [weak] },
    { text: "好", syllableCount: 1, recordings: {}, words: [{ id: "w1", text: "好", hanzi: "好", syllables: [syllable] }] }
  );
  assert.match(feedback.message, /cannot make a confident comparison/);
});

function segment(id, startSec, endSec, median, start, end) {
  return { segmentId: id, startSec, endSec, timingConfidence: 1, medianRelativeSemitone: median,
    startRelativeSemitone: start, endRelativeSemitone: end, voicedRatio: .8,
    pitchRuns: [{ points: [
      { timeSec: startSec + .1, semitone: start, confidence: 1 },
      { timeSec: (startSec + endSec) / 2, semitone: median, confidence: 1 },
      { timeSec: endSec - .1, semitone: end, confidence: 1 }
    ] }] };
}
