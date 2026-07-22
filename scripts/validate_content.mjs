#!/usr/bin/env node
/** Fail closed on incomplete metadata; --release additionally requires all 720 measured recordings. */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const selectionArgument = process.argv.find((value) => value.startsWith("--selection="));
const readJson = async (...parts) => JSON.parse(await fs.readFile(path.join(root, ...parts), "utf8"));
const generatedSelectionExists = await fs.access(path.join(root, "artifacts/speaker-selection/selected-speakers.json")).then(() => true, () => false);
const readSelection = selectionArgument
  ? fs.readFile(path.resolve(root, selectionArgument.split("=")[1]), "utf8").then(JSON.parse)
  : generatedSelectionExists
    ? readJson("artifacts", "speaker-selection", "selected-speakers.json")
    : readJson("config", "speaker-selection.json");
const [catalog, speakers, source, selection] = await Promise.all([
  readJson("public", "content", "phrases.json"), readJson("public", "content", "speakers.json"),
  readJson("content", "corpus-source.json"), readSelection
]);
const errors = [];
const requiredDisclosure = "Voices, pronunciations, tone annotations, alignments, and selections were generated or inferred automatically and have not been reviewed by a Mandarin speaker.";
if (catalog.annotationNotice !== requiredDisclosure || speakers.disclosure !== requiredDisclosure) errors.push("The exact automatic/unreviewed disclosure is missing.");
if (catalog.humanReviewed !== false || speakers.humanReviewed !== false) errors.push("PoC metadata must explicitly set humanReviewed to false.");
if (catalog.phrases.length !== 60) errors.push(`Expected exactly 60 phrases, found ${catalog.phrases.length}.`);
if (speakers.speakers.length !== 6) errors.push(`Expected exactly six speakers, found ${speakers.speakers.length}.`);
const selectedModelNames = new Set((selection.selected || []).map((speaker) => speaker.kokoroName));
if (selectedModelNames.size !== 6 || speakers.speakers.some((speaker) => !selectedModelNames.has(speaker.kokoroName))) errors.push("Published speakers do not match the active six-speaker selection manifest.");
for (const gender of ["female", "male"]) {
  const count = speakers.speakers.filter((speaker) => speaker.genderGroup === gender).length;
  if (count !== 3) errors.push(`Expected three ${gender} model-category speakers, found ${count}.`);
}
const ids = new Set();
const requiredRealizations = new Set(["citation", "half-third", "third-tone-sandhi", "yi-sandhi", "bu-sandhi", "neutral-after-1", "neutral-after-2", "neutral-after-3", "neutral-after-4"]);
const foundRealizations = new Set();
const fullToneCounts = new Map([[1, 0], [2, 0], [3, 0], [4, 0]]);
const thirdToneContexts = new Set();
for (const phrase of catalog.phrases) {
  if (ids.has(phrase.id)) errors.push(`Duplicate phrase ID: ${phrase.id}`); ids.add(phrase.id);
  if (!phrase.hanzi || !phrase.translation || !phrase.source?.provider || !phrase.source?.license) errors.push(`${phrase.id}: incomplete text, translation, or attribution.`);
  if (phrase.annotationStatus !== "automatic-unreviewed" || phrase.pronunciationAgreement !== "dual-g2p-agree") errors.push(`${phrase.id}: automatic dual-G2P status missing.`);
  const syllables = phrase.words.flatMap((word) => word.syllables);
  if (syllables.length !== phrase.syllableCount || syllables.length < 2 || syllables.length > 10) errors.push(`${phrase.id}: invalid syllable count.`);
  for (const syllable of syllables) {
    foundRealizations.add(syllable.surfaceRealization);
    if (!syllable.hanzi || !syllable.pinyin || ![1, 2, 3, 4, 5].includes(syllable.citationTone)
        || !syllable.surfaceRealization || !syllable.surfaceToneClass || syllable.annotationStatus !== "automatic-unreviewed") {
      errors.push(`${phrase.id}/${syllable.id}: incomplete citation or surface-tone annotation.`);
    }
    if (syllable.citationTone <= 4) fullToneCounts.set(syllable.citationTone, fullToneCounts.get(syllable.citationTone) + 1);
  }
  syllables.forEach((syllable, index) => { if (syllable.citationTone === 3) thirdToneContexts.add(syllables[index + 1]?.citationTone || "pause"); });
  for (const speaker of speakers.speakers) for (const speed of ["natural", "slowed"]) {
    const locator = phrase.recordings?.[speaker.id]?.[speed];
    if (!locator?.audioUrl || !locator?.analysisUrl || locator.variantKey !== `${speaker.id}-${speed}`) errors.push(`${phrase.id}: missing ${speaker.id}-${speed} locator.`);
    if (release && locator?.status !== "generated") errors.push(`${phrase.id}: ${speaker.id}-${speed} is not generated.`);
  }
  await validateShard(phrase, speakers.speakers, errors, release);
}
for (const name of requiredRealizations) if (!foundRealizations.has(name)) errors.push(`Corpus has no ${name} example.`);
const fullCounts = [...fullToneCounts.values()];
if (Math.min(...fullCounts) < 50 || Math.max(...fullCounts) / Math.min(...fullCounts) > 1.35) errors.push(`Full-tone corpus counts are not balanced enough: ${JSON.stringify(Object.fromEntries(fullToneCounts))}.`);
for (const context of [1, 2, 3, 4, "pause"]) if (!thirdToneContexts.has(context)) errors.push(`Corpus has no Tone 3 before ${context}.`);
for (const topic of catalog.topics) if (catalog.phrases.filter((phrase) => phrase.topicIds.includes(topic.id)).length !== 10) errors.push(`Topic ${topic.id} does not contain ten PoC phrases.`);
for (const sourcePhrase of source.phrases) {
  const left = sourcePhrase.g2p?.misaki || [], right = sourcePhrase.g2p?.pypinyin || [];
  if (left.length !== right.length || left.some((value, index) => normalizePinyin(value) !== normalizePinyin(right[index]))) errors.push(`${sourcePhrase.id}: unresolved frozen G2P disagreement.`);
  if (release && sourcePhrase.g2p?.mode !== "live") errors.push(`${sourcePhrase.id}: release requires live independent G2P output.`);
}
if (release && (catalog.fixture || speakers.fixture || source.fixture || selection.fixture)) errors.push("Release validation rejects fixture content or selection metadata.");
if (release) await validateReleaseAudio(catalog, speakers.speakers, errors);

if (errors.length) {
  for (const error of errors.slice(0, 100)) console.error(`- ${error}`);
  if (errors.length > 100) console.error(`- …and ${errors.length - 100} more`);
  process.exitCode = 1;
} else console.log(`Validated ${catalog.phrases.length} phrases, ${speakers.speakers.length} speakers, and ${catalog.phrases.length * speakers.speakers.length * 2} ${release ? "release" : catalog.fixture ? "fixture" : "content"} variants.`);

async function validateShard(phrase, speakerList, output, strict) {
  try {
    const shard = await readJson("public", "references", `${phrase.id}.json`);
    for (const speaker of speakerList) for (const speed of ["natural", "slowed"]) {
      const key = `${speaker.id}-${speed}`, recording = shard.variants?.[key];
      if (!recording) { output.push(`${phrase.id}: missing reference ${key}.`); continue; }
      if (recording.words.length !== phrase.words.length || recording.syllables.length !== phrase.syllableCount) output.push(`${phrase.id}/${key}: segment count mismatch.`);
      for (const segments of [recording.words, recording.syllables]) {
        let previous = -Infinity;
        for (const segment of segments) {
          if (segment.startSec < previous || segment.endSec <= segment.startSec) output.push(`${phrase.id}/${key}: non-monotonic timing.`);
          previous = segment.endSec;
        }
      }
      if (strict && (recording.analysisStatus !== "measured" || !recording.checksum || !recording.pitchRuns.length)) output.push(`${phrase.id}/${key}: measured pitch or checksum missing.`);
    }
  } catch { output.push(`${phrase.id}: reference shard missing or invalid.`); }
}

async function validateReleaseAudio(phraseCatalog, speakerList, output) {
  let manifest;
  try { manifest = await readJson("public", "audio", "phrases", "manifest.json"); }
  catch { output.push("Release audio manifest is missing."); return; }
  const expectedPairs = phraseCatalog.phrases.length * speakerList.length;
  if (Object.keys(manifest.entries || {}).length !== expectedPairs) output.push(`Expected ${expectedPairs} audio pairs in the release manifest.`);
  for (const phrase of phraseCatalog.phrases) for (const speaker of speakerList) {
    const entry = manifest.entries?.[`${speaker.id}/${phrase.id}`];
    if (!entry) { output.push(`${phrase.id}/${speaker.id}: audio manifest entry missing.`); continue; }
    for (const speed of ["natural", "slowed"]) {
      try {
        const bytes = await fs.readFile(path.join(root, entry[speed].path));
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum !== entry[speed].checksum) output.push(`${phrase.id}/${speaker.id}/${speed}: checksum mismatch.`);
        if (entry[speed].sampleRate !== 24000 || entry[speed].channels !== 1) output.push(`${phrase.id}/${speaker.id}/${speed}: audio format mismatch.`);
      } catch { output.push(`${phrase.id}/${speaker.id}/${speed}: audio file missing.`); }
    }
  }
}

function normalizePinyin(value) { return String(value).toLowerCase().replaceAll("u:", "v").replaceAll("ü", "v").replace(/[\s'’-]/g, ""); }
