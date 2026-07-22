import { decodeBlobToAudioBuffer, playAudioSegment, playAudioSource, stopActivePlayback } from "./audio.js";
import {
  analyzePhraseSamples,
  buildQuizQuestions,
  compareLearnerToReference,
  evaluateRelationships,
  mixAudioBuffer
} from "./phrase-analysis.js";
import { canonicalGlyph, toneLabel } from "./mandarin.js";
import { renderExplorerChart, renderPhraseChart } from "./phrase-chart.js";
import type {
  LearnerComparison,
  Phrase,
  PhraseAudioAnalysis,
  PhraseCatalog,
  PhraseSyllable,
  PhraseTranscript,
  PlaybackSpeed,
  QuizQuestion,
  ReferenceRecording,
  ReferenceShard,
  SegmentEnvelope,
  Speaker,
  SpeakerCatalog,
  SpeakerId,
  ToneId
} from "./phrase-types.js";

const RESULT_LIMIT = 80;
const DISCLOSURE = "Voices, pronunciations, tone annotations, alignments, and selections were generated or inferred automatically and have not been reviewed by a Mandarin speaker.";
const configuredAssetBase = document.querySelector<HTMLMetaElement>('meta[name="asset-base"]')?.content || "";
const ASSET_BASE = configuredAssetBase.startsWith("__") ? "" : configuredAssetBase.replace(/\/$/, "");

interface ActiveRecording {
  kind: "practice" | "explore";
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  timeout: number;
}

const state: {
  catalog: PhraseCatalog | null;
  speakers: Speaker[];
  phraseId: string | null;
  speakerId: SpeakerId;
  speed: PlaybackSpeed;
  topic: string;
  tone: ToneId | null;
  query: string;
  revealed: boolean;
  selectedSegmentId: string | null;
  reference: ReferenceRecording | null;
  otherReferences: ReferenceRecording[];
  envelope: SegmentEnvelope[];
  shards: Map<string, ReferenceShard>;
  loadToken: number;
  learner: LearnerComparison | null;
  learnerAudioUrl: string | null;
  explore: PhraseAudioAnalysis | null;
  exploreAudioUrl: string | null;
  recording: ActiveRecording | null;
  quiz: QuizQuestion[];
  quizIndex: number;
  quizAnswered: boolean;
} = {
  catalog: null, speakers: [], phraseId: null, speakerId: "", speed: "natural", topic: "all", tone: null,
  query: "", revealed: false, selectedSegmentId: null, reference: null, otherReferences: [], shards: new Map(),
  envelope: [], loadToken: 0, learner: null, learnerAudioUrl: null, explore: null, exploreAudioUrl: null, recording: null,
  quiz: [], quizIndex: 0, quizAnswered: false
};

const elements = {
  modeButtons: [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")],
  panels: {
    practice: document.querySelector<HTMLElement>("#practiceMode")!,
    quiz: document.querySelector<HTMLElement>("#quizMode")!,
    explore: document.querySelector<HTMLElement>("#exploreMode")!
  },
  annotationNotice: document.querySelector<HTMLElement>("#annotationNotice")!,
  phraseSearch: document.querySelector<HTMLInputElement>("#phraseSearch")!,
  topicFilters: document.querySelector<HTMLElement>("#topicFilters")!,
  toneFilters: document.querySelector<HTMLElement>("#toneFilters")!,
  phraseResults: document.querySelector<HTMLElement>("#phraseResults")!,
  resultCount: document.querySelector<HTMLElement>("#resultCount")!,
  phraseTitle: document.querySelector<HTMLElement>("#phraseTitle")!,
  phraseTranslation: document.querySelector<HTMLElement>("#phraseTranslation")!,
  topicLabel: document.querySelector<HTMLElement>("#topicLabel")!,
  sourceLabel: document.querySelector<HTMLElement>("#sourceLabel")!,
  speakerSelect: document.querySelector<HTMLSelectElement>("#speakerSelect")!,
  randomSpeaker: document.querySelector<HTMLButtonElement>("#randomSpeaker")!,
  speedButtons: [...document.querySelectorAll<HTMLButtonElement>("[data-speed]")],
  playPhrase: document.querySelector<HTMLButtonElement>("#playPhrase")!,
  compareSpeakers: document.querySelector<HTMLButtonElement>("#compareSpeakers")!,
  toggleLabels: document.querySelector<HTMLButtonElement>("#toggleLabels")!,
  practiceStatus: document.querySelector<HTMLElement>("#practiceStatus")!,
  transcript: document.querySelector<HTMLElement>("#transcript")!,
  chartConcealment: document.querySelector<HTMLElement>("#chartConcealment")!,
  phraseChart: document.querySelector<HTMLElement>("#phraseChart")!,
  clearZoom: document.querySelector<HTMLButtonElement>("#clearZoom")!,
  detailTitle: document.querySelector<HTMLElement>("#detailTitle")!,
  detailHint: document.querySelector<HTMLElement>("#detailHint")!,
  playContext: document.querySelector<HTMLButtonElement>("#playContext")!,
  recordPhrase: document.querySelector<HTMLButtonElement>("#recordPhrase")!,
  practiceUpload: document.querySelector<HTMLInputElement>("#practiceUpload")!,
  playAttempt: document.querySelector<HTMLButtonElement>("#playAttempt")!,
  phraseFeedback: document.querySelector<HTMLOutputElement>("#phraseFeedback")!,
  hotspots: document.querySelector<HTMLElement>("#hotspots")!,
  quizProgress: document.querySelector<HTMLElement>("#quizProgress")!,
  quizPrompt: document.querySelector<HTMLElement>("#quizPrompt")!,
  quizHiddenText: document.querySelector<HTMLElement>("#quizHiddenText")!,
  playQuiz: document.querySelector<HTMLButtonElement>("#playQuiz")!,
  quizOptions: document.querySelector<HTMLElement>("#quizOptions")!,
  quizFeedback: document.querySelector<HTMLOutputElement>("#quizFeedback")!,
  nextQuestion: document.querySelector<HTMLButtonElement>("#nextQuestion")!,
  recordExplore: document.querySelector<HTMLButtonElement>("#recordExplore")!,
  exploreUpload: document.querySelector<HTMLInputElement>("#exploreUpload")!,
  playExplore: document.querySelector<HTMLButtonElement>("#playExplore")!,
  exploreStatus: document.querySelector<HTMLElement>("#exploreStatus")!,
  exploreChart: document.querySelector<HTMLElement>("#exploreChart")!,
  aboutButton: document.querySelector<HTMLButtonElement>("#aboutButton")!,
  aboutDialog: document.querySelector<HTMLDialogElement>("#aboutDialog")!,
  creditDetails: document.querySelector<HTMLElement>("#creditDetails")!
};

bindEvents();
renderExplorerChart(elements.exploreChart, [], 0);
void init();

async function init(): Promise<void> {
  try {
    const [phraseResponse, speakerResponse] = await Promise.all([
      fetch(assetUrl("/content/phrases.json")), fetch(assetUrl("/content/speakers.json"))
    ]);
    if (!phraseResponse.ok || !speakerResponse.ok) throw new Error("Static content could not be loaded.");
    state.catalog = await phraseResponse.json() as PhraseCatalog;
    const speakerCatalog = await speakerResponse.json() as SpeakerCatalog;
    state.speakers = speakerCatalog.speakers;
    state.phraseId = state.catalog.phrases[0]?.id || null;
    state.speakerId = state.speakers[0]?.id || "";
    elements.annotationNotice.textContent = state.catalog.annotationNotice || DISCLOSURE;
    renderSpeakerOptions(); renderTopics(); renderPhraseList(); renderSelectedPhrase(); renderAbout();
    await loadReference();
  } catch (error) {
    elements.practiceStatus.textContent = error instanceof Error ? error.message : "Content loading failed.";
    elements.phraseResults.innerHTML = `<p>Run <code>npm run corpus:import</code>, then reload.</p>`;
  }
}

function bindEvents(): void {
  elements.modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode as keyof typeof elements.panels)));
  elements.phraseSearch.addEventListener("input", () => { state.query = elements.phraseSearch.value.trim().toLocaleLowerCase(); renderPhraseList(); });
  elements.topicFilters.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-topic]");
    if (!button) return; state.topic = button.dataset.topic || "all"; renderTopics(); renderPhraseList();
  });
  elements.toneFilters.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-tone]");
    if (!button) return; const tone = button.dataset.tone as ToneId; state.tone = state.tone === tone ? null : tone;
    renderToneButtons(); renderPhraseList();
  });
  elements.phraseResults.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-phrase]");
    if (button?.dataset.phrase) void selectPhrase(button.dataset.phrase);
  });
  elements.speakerSelect.addEventListener("change", () => { state.speakerId = elements.speakerSelect.value; void changeVariant(); });
  elements.randomSpeaker.addEventListener("click", () => { chooseRandomSpeaker(); void changeVariant(); });
  elements.speedButtons.forEach((button) => button.addEventListener("click", () => {
    state.speed = button.dataset.speed as PlaybackSpeed; void changeVariant();
  }));
  elements.playPhrase.addEventListener("click", () => void playReference());
  elements.compareSpeakers.addEventListener("click", () => void playAcrossSpeakers());
  elements.toggleLabels.addEventListener("click", toggleReveal);
  elements.transcript.addEventListener("click", selectSegmentFromEvent);
  elements.phraseChart.addEventListener("click", selectSegmentFromEvent);
  elements.clearZoom.addEventListener("click", () => selectSegment(null));
  elements.playContext.addEventListener("click", () => void playContext());
  elements.recordPhrase.addEventListener("click", () => void toggleRecording("practice"));
  elements.recordExplore.addEventListener("click", () => void toggleRecording("explore"));
  elements.practiceUpload.addEventListener("change", () => void processFile(elements.practiceUpload.files?.[0], "practice"));
  elements.exploreUpload.addEventListener("change", () => void processFile(elements.exploreUpload.files?.[0], "explore"));
  elements.playAttempt.addEventListener("click", () => state.learnerAudioUrl && void playAudioSource(state.learnerAudioUrl));
  elements.playExplore.addEventListener("click", () => state.exploreAudioUrl && void playAudioSource(state.exploreAudioUrl));
  elements.playQuiz.addEventListener("click", () => void playQuizAudio());
  elements.quizOptions.addEventListener("click", answerQuiz);
  elements.nextQuestion.addEventListener("click", nextQuiz);
  elements.aboutButton.addEventListener("click", () => elements.aboutDialog.showModal());
}

function setMode(mode: keyof typeof elements.panels): void {
  stopActivePlayback();
  Object.entries(elements.panels).forEach(([id, panel]) => panel.classList.toggle("is-hidden", id !== mode));
  elements.modeButtons.forEach((button) => {
    const active = button.dataset.mode === mode; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active));
  });
  if (mode === "quiz") renderQuiz();
}

function selectedPhrase(): Phrase | null { return state.catalog?.phrases.find((phrase) => phrase.id === state.phraseId) || null; }
function transcript(): PhraseTranscript | null {
  const phrase = selectedPhrase(); if (!phrase) return null;
  return { text: phrase.hanzi, words: phrase.words, syllableCount: phrase.syllableCount, recordings: phrase.recordings[state.speakerId] };
}
function locator(speakerId = state.speakerId) { return selectedPhrase()?.recordings[speakerId]?.[state.speed] || null; }

function filteredPhrases(): Phrase[] {
  return (state.catalog?.phrases || []).filter((phrase) => {
    const pinyin = phrase.words.flatMap((word) => word.syllables.map((syllable) => syllable.pinyin)).join(" ");
    const matchesQuery = !state.query || `${phrase.hanzi} ${pinyin} ${phrase.translation}`.toLocaleLowerCase().includes(state.query);
    const matchesTopic = state.topic === "all" || phrase.topicIds.includes(state.topic);
    const matchesTone = !state.tone || phrase.words.some((word) => word.syllables.some((syllable) => syllable.lexicalTone === state.tone));
    return phrase.published && matchesQuery && matchesTopic && matchesTone;
  });
}

function renderSpeakerOptions(): void {
  elements.speakerSelect.innerHTML = state.speakers.map((speaker) =>
    `<option value="${escapeHtml(speaker.id)}">${escapeHtml(speaker.displayName)} · ${speaker.genderGroup === "female" ? "F" : "M"}</option>`
  ).join("");
  elements.speakerSelect.value = state.speakerId;
}
function renderTopics(): void {
  const topics = [{ id: "all", label: "All" }, ...(state.catalog?.topics || [])];
  elements.topicFilters.innerHTML = topics.map((topic) => `<button class="${topic.id === state.topic ? "is-active" : ""}" data-topic="${escapeHtml(topic.id)}">${escapeHtml(topic.label)}</button>`).join("");
  renderToneButtons();
}
function renderToneButtons(): void { elements.toneFilters.querySelectorAll("[data-tone]").forEach((button) => button.classList.toggle("is-active", (button as HTMLElement).dataset.tone === state.tone)); }
function renderPhraseList(): void {
  const phrases = filteredPhrases(); elements.resultCount.textContent = String(phrases.length);
  elements.phraseResults.innerHTML = phrases.slice(0, RESULT_LIMIT).map((phrase) => `<button class="phrase-result ${phrase.id === state.phraseId ? "is-active" : ""}" data-phrase="${escapeHtml(phrase.id)}" role="option" aria-selected="${phrase.id === state.phraseId}"><strong lang="zh-Hans">${escapeHtml(phrase.hanzi)}</strong><span>${escapeHtml(phrase.translation)}</span></button>`).join("") || "<p>No phrases match.</p>";
}

function renderSelectedPhrase(): void {
  const phrase = selectedPhrase(); if (!phrase || !state.catalog) return;
  elements.phraseTitle.textContent = phrase.hanzi; elements.phraseTranslation.textContent = phrase.translation;
  elements.topicLabel.textContent = state.catalog.topics.find((topic) => topic.id === phrase.topicIds[0])?.label || "Phrase";
  elements.sourceLabel.textContent = `${phrase.source.provider} · ${phrase.source.license}`;
  elements.speakerSelect.value = state.speakerId;
  elements.speedButtons.forEach((button) => {
    const active = button.dataset.speed === state.speed; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active));
  });
  elements.transcript.innerHTML = phrase.words.flatMap((word) => word.syllables).map(renderSyllable).join("");
  elements.transcript.classList.toggle("is-concealed", !state.revealed);
  elements.chartConcealment.classList.toggle("is-hidden", state.revealed);
  elements.phraseChart.classList.toggle("is-hidden", !state.revealed);
  elements.toggleLabels.textContent = state.revealed ? "Hide labels & contour" : "Reveal labels & contour";
  renderDetail(); renderChart();
}

function renderSyllable(syllable: PhraseSyllable): string {
  const glyph = canonicalGlyph(syllable.citationTone); const points = glyph.map((value, index) => `${3 + index * 18},${15 - value * 2.4}`).join(" ");
  return `<button class="syllable-card ${syllable.id === state.selectedSegmentId ? "is-selected" : ""}" data-segment-id="${escapeHtml(syllable.id)}" title="${escapeHtml(syllable.explanation)}"><span class="hanzi" lang="zh-Hans">${escapeHtml(syllable.hanzi)}</span><span class="pinyin">${escapeHtml(syllable.pinyin)}</span><span class="tone-meta">${syllable.citationTone === 5 ? "· neutral" : `${syllable.citationTone} · ${toneLabel(syllable.citationTone).split("(")[1]?.replace(")", "") || "tone"}`}</span><svg class="tone-glyph" viewBox="0 0 42 17" aria-label="Schematic citation-tone glyph"><path d="M ${points.replaceAll(" ", " L ")}"/></svg></button>`;
}

async function selectPhrase(id: string): Promise<void> {
  if (id === state.phraseId) return; stopActivePlayback(); clearLearner(); state.phraseId = id; state.selectedSegmentId = null; state.revealed = false;
  state.reference = null; state.otherReferences = []; state.envelope = []; renderPhraseList(); renderSelectedPhrase(); await loadReference();
}
async function changeVariant(): Promise<void> {
  stopActivePlayback(); clearLearner(); state.selectedSegmentId = null; state.reference = null; state.otherReferences = [];
  state.envelope = []; renderSelectedPhrase(); renderPhraseList(); await loadReference();
}

async function loadReference(): Promise<void> {
  const phrase = selectedPhrase(); const currentLocator = locator(); if (!phrase || !currentLocator) return;
  const token = ++state.loadToken; elements.practiceStatus.textContent = "Loading this phrase’s automatic reference shard…";
  try {
    let shard = state.shards.get(currentLocator.analysisUrl);
    if (!shard) { const response = await fetch(assetUrl(currentLocator.analysisUrl)); if (!response.ok) throw new Error("Reference shard is not installed."); shard = await response.json() as ReferenceShard; state.shards.set(currentLocator.analysisUrl, shard); }
    if (token !== state.loadToken) return;
    state.reference = shard.variants[currentLocator.variantKey] || null;
    state.otherReferences = state.speakers.filter((speaker) => speaker.id !== state.speakerId).map((speaker) => shard!.variants[`${speaker.id}-${state.speed}`]).filter(Boolean);
    state.envelope = shard.envelopes?.[state.speed] || [];
    if (!state.reference) throw new Error("This speaker variant is missing from the reference shard.");
    elements.practiceStatus.textContent = state.reference.analysisStatus === "measured"
      ? "Ready. The solid line is measured from this selected model recording."
      : "Pipeline fixture: model audio and measured contours are pending offline generation; correctness feedback is disabled.";
    state.quiz = buildQuizQuestions(state.reference, transcript()!, "syllable"); state.quizIndex = 0; state.quizAnswered = false;
  } catch (error) { state.reference = null; elements.practiceStatus.textContent = error instanceof Error ? error.message : "Reference load failed."; }
  renderChart(); renderQuiz();
}

function renderChart(): void {
  const currentTranscript = transcript(); if (!currentTranscript) return;
  renderPhraseChart(elements.phraseChart, {
    reference: state.reference, learner: state.learner, transcript: currentTranscript,
    selectedSegmentId: state.selectedSegmentId, emptyText: "No measured contour is installed for this fixture yet.",
    otherReferences: state.otherReferences
  } as any);
  elements.clearZoom.classList.toggle("is-hidden", !state.selectedSegmentId);
}
function toggleReveal(): void { state.revealed = !state.revealed; renderSelectedPhrase(); }
function chooseRandomSpeaker(): void {
  if (!state.speakers.length) return; const choices = state.speakers.filter((speaker) => speaker.id !== state.speakerId);
  state.speakerId = (choices[Math.floor(Math.random() * choices.length)] || state.speakers[0]).id; elements.speakerSelect.value = state.speakerId;
}

async function playReference(speakerId = state.speakerId): Promise<void> {
  const target = locator(speakerId); if (!target) return;
  try { elements.practiceStatus.textContent = "Playing the complete contextual recording…"; await playAudioSource(assetUrl(target.audioUrl)); elements.practiceStatus.textContent = "Ready."; }
  catch { elements.practiceStatus.textContent = "Audio is not installed for this pipeline fixture. Run audio:generate."; }
}
async function playAcrossSpeakers(): Promise<void> {
  for (const speaker of state.speakers) { elements.practiceStatus.textContent = `Playing ${speaker.displayName}…`; await playReference(speaker.id); }
}

function selectSegmentFromEvent(event: Event): void {
  const target = (event.target as Element).closest<HTMLElement>("[data-segment-id]"); if (target?.dataset.segmentId) selectSegment(target.dataset.segmentId);
}
function selectSegment(id: string | null): void { state.selectedSegmentId = id; renderSelectedPhrase(); }
function selectedSyllable(): PhraseSyllable | null { return selectedPhrase()?.words.flatMap((word) => word.syllables).find((syllable) => syllable.id === state.selectedSegmentId) || null; }
function renderDetail(): void {
  const syllable = selectedSyllable(); elements.playContext.disabled = !syllable || !state.reference;
  elements.detailTitle.textContent = syllable ? `${syllable.hanzi} · ${syllable.pinyin}` : "Select a character";
  elements.detailHint.textContent = syllable?.explanation || "Its lexical label and automatic contextual realization will appear here.";
}
async function playContext(): Promise<void> {
  const segment = state.reference?.syllables.find((item) => item.segmentId === state.selectedSegmentId); const target = locator();
  if (!segment || !target) return; try { await playAudioSegment(assetUrl(target.audioUrl), Math.max(0, segment.startSec - .16), Math.min(state.reference!.durationSec, segment.endSec + .16)); }
  catch { elements.practiceStatus.textContent = "Context audio is not installed yet."; }
}

async function toggleRecording(kind: "practice" | "explore"): Promise<void> {
  if (state.recording) { state.recording.recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setRecordStatus(kind, "Microphone recording is unavailable. Use the upload fallback."); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const mimeType = MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener("stop", () => void finishRecording(kind, recorder, stream, chunks), { once: true });
    const timeout = window.setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 12_000);
    state.recording = { kind, recorder, stream, chunks, timeout }; recorder.start(); setRecordStatus(kind, "Recording… press Stop or finish within 12 seconds.");
    (kind === "practice" ? elements.recordPhrase : elements.recordExplore).textContent = "■ Stop";
  } catch { setRecordStatus(kind, "Microphone permission was denied or unavailable. Use the upload fallback beside Record."); }
}
async function finishRecording(kind: "practice" | "explore", recorder: MediaRecorder, stream: MediaStream, chunks: Blob[]): Promise<void> {
  if (state.recording) window.clearTimeout(state.recording.timeout); stream.getTracks().forEach((track) => track.stop()); state.recording = null;
  (kind === "practice" ? elements.recordPhrase : elements.recordExplore).textContent = "● Record";
  await processBlob(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), kind);
}
async function processFile(file: File | undefined, kind: "practice" | "explore"): Promise<void> { if (file) await processBlob(file, kind); }
async function processBlob(blob: Blob, kind: "practice" | "explore"): Promise<void> {
  setRecordStatus(kind, "Analyzing locally…");
  try {
    const buffer = await decodeBlobToAudioBuffer(blob); if (buffer.duration > 12.5) throw new Error("Use a recording no longer than 12 seconds.");
    const analysis = analyzePhraseSamples(mixAudioBuffer(buffer), buffer.sampleRate); const url = URL.createObjectURL(blob);
    if (kind === "explore") {
      if (state.exploreAudioUrl) URL.revokeObjectURL(state.exploreAudioUrl); state.exploreAudioUrl = url; state.explore = analysis;
      elements.playExplore.disabled = false; renderExplorerChart(elements.exploreChart, analysis.pitchRuns, analysis.durationSec);
      elements.exploreStatus.textContent = analysis.error || "Phrase-centred pitch extracted locally. No correctness claim is made.";
      return;
    }
    if (state.learnerAudioUrl) URL.revokeObjectURL(state.learnerAudioUrl); state.learnerAudioUrl = url; elements.playAttempt.disabled = false;
    if (!state.reference || state.reference.analysisStatus !== "measured") { elements.phraseFeedback.textContent = "Your pitch was extracted locally, but correctness comparison is disabled until measured model references are generated."; return; }
    state.learner = compareLearnerToReference(state.reference, transcript()!, analysis); const feedback = evaluateRelationships(state.reference, state.learner, transcript()!, state.envelope);
    elements.phraseFeedback.textContent = feedback.message; elements.hotspots.innerHTML = feedback.hotspots.map((hotspot) => `<button data-segment-id="${escapeHtml(hotspot.segmentId)}">${escapeHtml(hotspot.label)} · ${escapeHtml(hotspot.cue)}</button>`).join("");
    state.revealed = true; renderSelectedPhrase();
  } catch (error) { setRecordStatus(kind, error instanceof Error ? error.message : "Audio could not be decoded."); }
}
function setRecordStatus(kind: "practice" | "explore", message: string): void { (kind === "practice" ? elements.practiceStatus : elements.exploreStatus).textContent = message; }
function clearLearner(): void {
  state.learner = null; if (state.learnerAudioUrl) URL.revokeObjectURL(state.learnerAudioUrl); state.learnerAudioUrl = null;
  elements.playAttempt.disabled = true; elements.phraseFeedback.textContent = "No numerical pronunciation score will be shown."; elements.hotspots.innerHTML = "";
}

function renderQuiz(): void {
  const question = state.quiz[state.quizIndex]; const phrase = selectedPhrase();
  if (!question || !phrase) { elements.quizPrompt.textContent = "This reference does not have an unambiguous automatic question."; elements.quizOptions.innerHTML = ""; return; }
  elements.quizProgress.textContent = `Question ${state.quizIndex + 1} of ${state.quiz.length}`; elements.quizPrompt.textContent = question.prompt;
  elements.quizHiddenText.textContent = state.quizAnswered ? `${phrase.hanzi} · ${phrase.translation}` : "Hanzi and chart stay hidden until you answer.";
  const all = phrase.words.flatMap((word) => word.syllables); elements.quizOptions.innerHTML = question.optionSegmentIds.map((id) => {
    const syllable = all.find((item) => item.id === id); return `<button data-answer="${escapeHtml(id)}">${state.quizAnswered ? escapeHtml(syllable?.hanzi || id) : `Option ${question.optionSegmentIds.indexOf(id) + 1}`}</button>`;
  }).join("");
}
async function playQuizAudio(): Promise<void> { chooseRandomSpeaker(); await changeVariant(); await playReference(); }
function answerQuiz(event: Event): void {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-answer]"); const question = state.quiz[state.quizIndex]; if (!button || !question || state.quizAnswered) return;
  state.quizAnswered = true; elements.quizFeedback.textContent = button.dataset.answer === question.answerSegmentId ? "Yes. Reveal the phrase and listen once more." : "Not this time. Reveal the phrase, then listen for the measured relationship."; renderQuiz();
}
function nextQuiz(): void { if (!state.quiz.length) return; state.quizIndex = (state.quizIndex + 1) % state.quiz.length; state.quizAnswered = false; elements.quizFeedback.textContent = ""; renderQuiz(); }
function renderAbout(): void {
  elements.creditDetails.innerHTML = state.speakers.map((speaker) => `<p><strong>${escapeHtml(speaker.displayName)}</strong> · ${escapeHtml(speaker.kokoroName)} · ${escapeHtml(speaker.acousticDescription)} · human reviewed: no</p>`).join("");
}
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function assetUrl(value: string): string { return ASSET_BASE && value.startsWith("/") ? `${ASSET_BASE}${value}` : value; }
