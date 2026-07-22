export type CitationTone = 1 | 2 | 3 | 4 | 5;
export type ToneId = "tone-1" | "tone-2" | "tone-3" | "tone-4" | "neutral";
export type SurfaceRealization =
  | "citation"
  | "half-third"
  | "third-tone-sandhi"
  | "yi-sandhi"
  | "bu-sandhi"
  | "neutral-after-1"
  | "neutral-after-2"
  | "neutral-after-3"
  | "neutral-after-4";
export type SurfaceToneClass =
  | "tone-1-level"
  | "tone-2-rising"
  | "tone-3-low"
  | "tone-3-final"
  | "tone-4-falling"
  | "sandhi-rising"
  | "neutral";
export type SpeakerId = string;
export type PlaybackSpeed = "natural" | "slowed";
export type SegmentLevel = "word" | "syllable";
export type AnnotationStatus = "automatic-unreviewed";

export interface PhraseCatalog {
  version: number;
  generatedAt: string;
  annotationNotice: string;
  humanReviewed: false;
  fixture: boolean;
  selection: Record<string, unknown>;
  topics: Topic[];
  phrases: Phrase[];
}

export interface SpeakerCatalog {
  version: number;
  disclosure: string;
  humanReviewed: false;
  speakers: Speaker[];
}

export interface Speaker {
  id: SpeakerId;
  displayName: string;
  model: string;
  modelRevision: string;
  kokoroName: string;
  kokoroSid: number;
  genderGroup: "female" | "male";
  age: null;
  region: null;
  selectionMode: string;
  humanReviewed: false;
  acousticDescription: string;
}

export interface Topic { id: string; label: string; }

export interface PhraseSource {
  provider: string;
  sentenceId: string;
  sentenceAuthor: string;
  translationId: string;
  translationAuthor: string;
  license: string;
  translationLicense?: string;
  url: string;
  modified: boolean;
}

export interface Phrase {
  id: string;
  hanzi: string;
  translation: string;
  topicIds: string[];
  published: boolean;
  annotationStatus: AnnotationStatus;
  pronunciationAgreement: "dual-g2p-agree";
  source: PhraseSource;
  words: PhraseWord[];
  syllableCount: number;
  recordings: Record<SpeakerId, Record<PlaybackSpeed, RecordingLocator>>;
}

export interface PhraseTranscript {
  text: string;
  syllableCount: number;
  words: PhraseWord[];
  recordings: Record<PlaybackSpeed, RecordingLocator>;
}

export interface PhraseWord {
  id: string;
  hanzi: string;
  text: string;
  pinyin: string;
  syllables: PhraseSyllable[];
}

export interface PhraseSyllable {
  id: string;
  hanzi: string;
  text: string;
  pinyin: string;
  citationPinyin: string;
  citationTone: CitationTone;
  lexicalTone: ToneId;
  surfaceRealization: SurfaceRealization;
  surfaceToneClass: SurfaceToneClass;
  annotationStatus: AnnotationStatus;
  explanation: string;
}

export interface RecordingLocator {
  audioUrl: string;
  analysisUrl: string;
  variantKey: string;
  status: "generated" | "pending-generation" | "fixture-pending-generation";
}

export interface RelativePitchPoint { timeSec: number; semitone: number; confidence: number; }
export interface RelativePitchRun { points: RelativePitchPoint[]; }
export interface AlignmentFeature { timeSec: number; energy: number; spectralFlux: number; voicing: number; }

export interface SegmentAnalysis {
  segmentId: string;
  startSec: number;
  endSec: number;
  timingConfidence: number;
  medianRelativeSemitone: number;
  startRelativeSemitone: number;
  endRelativeSemitone: number;
  minRelativeSemitone?: number;
  maxRelativeSemitone?: number;
  excursionSemitone?: number;
  turningPoint?: number | null;
  voicedRatio?: number;
  pitchRuns: RelativePitchRun[];
}

export interface FeatureRange { low: number; median: number; high: number; }
export interface SegmentEnvelope {
  segmentId: string;
  start: FeatureRange;
  end: FeatureRange;
  median: FeatureRange;
  excursion: FeatureRange;
  duration: FeatureRange;
  voicedRatio: FeatureRange;
}

export interface ReferenceRecording {
  audioUrl: string;
  durationSec: number;
  audioStartSec?: number;
  audioEndSec?: number;
  phraseCentreSemitone: number;
  pitchRuns: RelativePitchRun[];
  words: SegmentAnalysis[];
  syllables: SegmentAnalysis[];
  alignmentFeatures: AlignmentFeature[];
  checksum?: string;
  analysisStatus?: "measured" | "fixture-pending-generation";
}

export interface ReferenceShard {
  phraseId: string;
  disclosure: string;
  variants: Record<string, ReferenceRecording>;
  envelopes?: Record<PlaybackSpeed, SegmentEnvelope[]>;
}

export interface PitchFrameSample { timeSec: number; f0: number; confidence: number; energy: number; }
export interface PhraseAudioAnalysis {
  durationSec: number;
  phraseCentreSemitone: number;
  frames: PitchFrameSample[];
  pitchRuns: RelativePitchRun[];
  alignmentFeatures: AlignmentFeature[];
  trimStartSec: number;
  trimEndSec: number;
  voicedRatio: number;
  error: string | null;
}

export interface AlignmentPoint { referenceSec: number; learnerSec: number; }
export interface PhraseAlignment { confidence: number; mapping: AlignmentPoint[]; retryReason: string | null; }
export interface LearnerComparison {
  analysis: PhraseAudioAnalysis;
  alignment: PhraseAlignment;
  alignedPitchRuns: RelativePitchRun[];
  words: SegmentAnalysis[];
  syllables: SegmentAnalysis[];
}
export interface FeedbackHotspot { segmentId: string; level: SegmentLevel; label: string; cue: string; }
export interface RelationalFeedback { retry: boolean; message: string; hotspots: FeedbackHotspot[]; }
export interface QuizQuestion {
  id: string;
  level: SegmentLevel;
  relation: "highest" | "lowest" | "rises-most" | "falls-most";
  prompt: string;
  answerSegmentId: string;
  optionSegmentIds: string[];
}
