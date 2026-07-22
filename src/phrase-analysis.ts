import type {
  AlignmentFeature,
  AlignmentPoint,
  LearnerComparison,
  PhraseAlignment,
  PhraseAudioAnalysis,
  PhraseTranscript,
  PitchFrameSample,
  QuizQuestion,
  ReferenceRecording,
  RelativePitchPoint,
  RelativePitchRun,
  RelationalFeedback,
  SegmentAnalysis,
  SegmentEnvelope,
  SegmentLevel
} from "./phrase-types.js";

const ANALYSIS_RATE = 16_000;
const WINDOW_SIZE = 640;
const HOP_SIZE = 160;
const MIN_F0 = 70;
const MAX_F0 = 520;
const MAX_RUN_GAP_SEC = 0.075;
const MIN_ALIGNMENT_CONFIDENCE = 0.43;

export function analyzePhraseSamples(input: Float32Array, sampleRate: number): PhraseAudioAnalysis {
  const samples = downsample(input, sampleRate, ANALYSIS_RATE);
  const durationSec = samples.length / ANALYSIS_RATE;
  const frames = extractPitchFrames(samples, ANALYSIS_RATE);
  const centre = robustMedian(frames.map((frame) => hzToSemitone(frame.f0)));
  const pitchRuns = buildRelativePitchRuns(frames, centre);
  const alignmentFeatures = extractAlignmentFeatures(samples, ANALYSIS_RATE, frames);
  const trim = findTrimmedEdges(alignmentFeatures, durationSec);
  const voicedRatio = durationSec > 0
    ? frames.length * (HOP_SIZE / ANALYSIS_RATE) / durationSec
    : 0;
  const error = frames.length < 12 || !Number.isFinite(centre)
    ? "Pitch was unclear. Try again in a quieter room and speak the complete phrase."
    : voicedRatio < 0.06
      ? "Too little voiced speech was detected. Record the complete phrase and stay close to the microphone."
      : null;
  return {
    durationSec,
    phraseCentreSemitone: Number.isFinite(centre) ? centre : 0,
    frames,
    pitchRuns,
    alignmentFeatures,
    trimStartSec: trim.start,
    trimEndSec: trim.end,
    voicedRatio,
    error
  };
}

export function mixAudioBuffer(buffer: AudioBuffer): Float32Array {
  const mixed = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      mixed[index] += data[index] / buffer.numberOfChannels;
    }
  }
  return mixed;
}

export function hzToSemitone(frequency: number): number {
  return 69 + 12 * Math.log2(frequency / 440);
}

export function robustMedian(values: number[]): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return Number.NaN;
  const trim = finite.length >= 20 ? Math.floor(finite.length * 0.08) : 0;
  const core = finite.slice(trim, finite.length - trim || undefined);
  const middle = Math.floor(core.length / 2);
  return core.length % 2 ? core[middle] : (core[middle - 1] + core[middle]) / 2;
}

export function buildRelativePitchRuns(
  frames: PitchFrameSample[],
  phraseCentreSemitone = robustMedian(frames.map((frame) => hzToSemitone(frame.f0))),
  maxGapSec = MAX_RUN_GAP_SEC
): RelativePitchRun[] {
  const runs: RelativePitchRun[] = [];
  let active: RelativePitchPoint[] = [];
  for (const frame of frames) {
    const point = {
      timeSec: frame.timeSec,
      semitone: hzToSemitone(frame.f0) - phraseCentreSemitone,
      confidence: frame.confidence
    };
    const previous = active[active.length - 1];
    if (previous && point.timeSec - previous.timeSec > maxGapSec) {
      if (active.length > 1) runs.push({ points: smoothRun(active) });
      active = [];
    }
    active.push(point);
  }
  if (active.length > 1) runs.push({ points: smoothRun(active) });
  return runs;
}

export function slicePitchRuns(runs: RelativePitchRun[], startSec: number, endSec: number): RelativePitchRun[] {
  return runs
    .map((run) => ({ points: run.points.filter((point) => point.timeSec >= startSec && point.timeSec <= endSec) }))
    .filter((run) => run.points.length > 0);
}

export function buildSegmentAnalysis(
  segmentId: string,
  startSec: number,
  endSec: number,
  pitchRuns: RelativePitchRun[],
  timingConfidence = 1
): SegmentAnalysis {
  const runs = slicePitchRuns(pitchRuns, startSec, endSec);
  const points = runs.flatMap((run) => run.points);
  const edgeCount = Math.max(1, Math.floor(points.length * 0.25));
  const pitches = points.map((point) => point.semitone);
  const minimum = pitches.length ? Math.min(...pitches) : 0;
  const maximum = pitches.length ? Math.max(...pitches) : 0;
  const minimumIndex = pitches.indexOf(minimum);
  return {
    segmentId,
    startSec,
    endSec,
    timingConfidence,
    medianRelativeSemitone: finiteOrZero(robustMedian(points.map((point) => point.semitone))),
    startRelativeSemitone: finiteOrZero(robustMedian(points.slice(0, edgeCount).map((point) => point.semitone))),
    endRelativeSemitone: finiteOrZero(robustMedian(points.slice(-edgeCount).map((point) => point.semitone))),
    minRelativeSemitone: minimum,
    maxRelativeSemitone: maximum,
    excursionSemitone: maximum - minimum,
    turningPoint: points.length > 2 ? minimumIndex / (points.length - 1) : null,
    voicedRatio: Math.min(1, points.length * (HOP_SIZE / ANALYSIS_RATE) / Math.max(0.01, endSec - startSec)),
    pitchRuns: runs
  };
}

export function alignPhrase(reference: ReferenceRecording, learner: PhraseAudioAnalysis): PhraseAlignment {
  if (learner.error) return { confidence: 0, mapping: [], retryReason: learner.error };
  const referenceFeatures = normalizeFeatures(reference.alignmentFeatures);
  const learnerFeatures = normalizeFeatures(learner.alignmentFeatures.filter((feature) =>
    feature.timeSec >= learner.trimStartSec && feature.timeSec <= learner.trimEndSec
  ));
  const durationRatio = (learner.trimEndSec - learner.trimStartSec) / Math.max(0.01, reference.durationSec);
  if (durationRatio < 0.52 || durationRatio > 1.72) {
    return retryAlignment("Your pacing was too different from the guide to align the complete phrase. Try again and follow the highlighted words.");
  }
  if (referenceFeatures.length < 4 || learnerFeatures.length < 4) {
    return retryAlignment("The complete phrase could not be aligned. Try again with clear, continuous speech.");
  }

  const rows = referenceFeatures.length;
  const columns = learnerFeatures.length;
  const costs = Array.from({ length: rows }, () => new Float64Array(columns).fill(Number.POSITIVE_INFINITY));
  const previous = Array.from({ length: rows }, () => new Int8Array(columns).fill(-1));
  costs[0][0] = featureDistance(referenceFeatures[0], learnerFeatures[0]);
  const band = 0.38;
  for (let row = 0; row < rows; row += 1) {
    const expected = rows === 1 ? 0 : row / (rows - 1);
    const from = Math.max(0, Math.floor((expected - band) * columns));
    const to = Math.min(columns - 1, Math.ceil((expected + band) * columns));
    for (let column = from; column <= to; column += 1) {
      if (row === 0 && column === 0) continue;
      const own = featureDistance(referenceFeatures[row], learnerFeatures[column]);
      let best = Number.POSITIVE_INFINITY;
      let direction = -1;
      if (row > 0 && column > 0 && costs[row - 1][column - 1] < best) {
        best = costs[row - 1][column - 1]; direction = 0;
      }
      if (row > 0 && costs[row - 1][column] + 0.08 < best) {
        best = costs[row - 1][column] + 0.08; direction = 1;
      }
      if (column > 0 && costs[row][column - 1] + 0.08 < best) {
        best = costs[row][column - 1] + 0.08; direction = 2;
      }
      costs[row][column] = own + best;
      previous[row][column] = direction;
    }
  }
  if (!Number.isFinite(costs[rows - 1][columns - 1])) {
    return retryAlignment("The recording did not follow the phrase order closely enough. Try the whole phrase again.");
  }

  let row = rows - 1;
  let column = columns - 1;
  const path: Array<[number, number]> = [];
  while (row > 0 || column > 0) {
    path.push([row, column]);
    const direction = previous[row][column];
    if (direction === 0) { row -= 1; column -= 1; }
    else if (direction === 1) row -= 1;
    else if (direction === 2) column -= 1;
    else break;
  }
  path.push([0, 0]);
  path.reverse();
  const mapping = compressMapping(path.map(([referenceIndex, learnerIndex]) => ({
    referenceSec: referenceFeatures[referenceIndex].timeSec,
    learnerSec: learnerFeatures[learnerIndex].timeSec
  })));
  const averageCost = costs[rows - 1][columns - 1] / Math.max(rows, columns);
  const coveragePenalty = Math.abs(1 - durationRatio) * 0.18;
  const confidence = clamp(Math.exp(-(averageCost + coveragePenalty) * 1.9), 0, 1);
  if (confidence < MIN_ALIGNMENT_CONFIDENCE) {
    return { confidence, mapping, retryReason: "The words could not be aligned confidently. Record every word in order and stay with the pacing guide." };
  }
  return { confidence, mapping, retryReason: null };
}

export function compareLearnerToReference(
  reference: ReferenceRecording,
  transcript: PhraseTranscript,
  analysis: PhraseAudioAnalysis
): LearnerComparison {
  const alignment = alignPhrase(reference, analysis);
  if (!alignment.mapping.length) {
    return { analysis, alignment, alignedPitchRuns: [], words: [], syllables: [] };
  }
  const words = reference.words.map((segment) => learnerSegment(segment, analysis.pitchRuns, alignment.mapping));
  const syllables = reference.syllables.map((segment) => learnerSegment(segment, analysis.pitchRuns, alignment.mapping));
  const alignedPitchRuns = analysis.pitchRuns.map((run) => ({
    points: run.points.map((point) => ({ ...point, timeSec: mapLearnerToReference(point.timeSec, alignment.mapping) }))
  }));
  const expectedWords = transcript.words.length;
  const usableWords = words.filter((word) => word.pitchRuns.some((run) => run.points.length >= 2)).length;
  if (!alignment.retryReason && usableWords < Math.max(1, Math.ceil(expectedWords * 0.72))) {
    alignment.confidence = Math.min(alignment.confidence, 0.35);
    alignment.retryReason = "Some words appear to be missing or unclear. Record the complete phrase before asking for tone feedback.";
  }
  return { analysis, alignment, alignedPitchRuns, words, syllables };
}

export function evaluateRelationships(
  reference: ReferenceRecording,
  learner: LearnerComparison,
  transcript: PhraseTranscript,
  envelope: SegmentEnvelope[] = []
): RelationalFeedback {
  if (learner.alignment.retryReason || learner.alignment.confidence < MIN_ALIGNMENT_CONFIDENCE) {
    return { retry: true, message: learner.alignment.retryReason || "The phrase could not be aligned confidently. Try again.", hotspots: [] };
  }
  const transcriptSyllables = transcript.words.flatMap((word) => word.syllables);
  const differences = reference.syllables.map((target, index) => {
    const attempt = learner.syllables[index];
    const accepted = envelope.find((item) => item.segmentId === target.segmentId);
    const attemptMedian = attempt?.medianRelativeSemitone || 0;
    const register = accepted ? signedDistanceFromRange(attemptMedian, accepted.median.low, accepted.median.high) : attemptMedian - target.medianRelativeSemitone;
    const targetMovement = target.endRelativeSemitone - target.startRelativeSemitone;
    const learnerMovement = (attempt?.endRelativeSemitone || 0) - (attempt?.startRelativeSemitone || 0);
    const movement = accepted
      ? signedDistanceFromRange(learnerMovement, accepted.end.low - accepted.start.high, accepted.end.high - accepted.start.low)
      : learnerMovement - targetMovement;
    const previousTarget = reference.syllables[index - 1];
    const previousLearner = learner.syllables[index - 1];
    const relation = previousTarget && previousLearner
      ? ((attempt?.medianRelativeSemitone || 0) - previousLearner.medianRelativeSemitone)
        - (target.medianRelativeSemitone - previousTarget.medianRelativeSemitone)
      : 0;
    const uncertain = !attempt || (attempt.voicedRatio ?? 0) < 0.28 || attempt.pitchRuns.flatMap((run) => run.points).length < 3;
    return { index, register, movement, relation, uncertain, severity: uncertain ? 0 : Math.abs(register) + Math.abs(movement) * 0.7 + Math.abs(relation) * 0.8 };
  }).sort((a, b) => b.severity - a.severity);

  const uncertain = differences.find((difference) => difference.uncertain);
  if (uncertain && differences.every((difference) => difference.severity < 1.05)) {
    const syllable = transcriptSyllables[uncertain.index];
    return {
      retry: false,
      message: `Pitch was irregular around ${syllable?.hanzi || "this syllable"}, so the app cannot make a confident comparison.`,
      hotspots: syllable ? [{ segmentId: syllable.id, level: "syllable", label: syllable.hanzi, cue: "inspect confidence" }] : []
    };
  }

  const strongest = differences[0];
  if (!strongest || strongest.severity < 1.05) {
    return { retry: false, message: "Your pitch relationships sit within the tolerance of this selected model reference. Listen across speakers before refining further.", hotspots: [] };
  }
  const syllable = transcriptSyllables[strongest.index];
  const previous = transcriptSyllables[strongest.index - 1];
  let message: string;
  if (syllable?.surfaceRealization === "half-third" && strongest.movement > 0.8) {
    message = `Keep ${syllable.hanzi}, a non-final Tone 3, low; it does not need a final rise here.`;
  } else if ((syllable?.surfaceToneClass === "tone-2-rising" || syllable?.surfaceToneClass === "sandhi-rising") && strongest.movement < -0.8) {
    message = `The expected rise on ${syllable.hanzi} started later or moved less than this model reference.`;
  } else if (syllable?.surfaceToneClass === "tone-4-falling" && strongest.register < -1 && strongest.movement > 0.6) {
    message = `${syllable.hanzi} began low, leaving little room for the Tone 4 fall.`;
  } else if (syllable?.surfaceToneClass === "neutral" && (learner.syllables[strongest.index]?.endSec || 0) - (learner.syllables[strongest.index]?.startSec || 0) > (envelope.find((item) => item.segmentId === syllable.id)?.duration.high || (reference.syllables[strongest.index].endSec - reference.syllables[strongest.index].startSec) * 1.3)) {
    message = `${syllable.hanzi}, a neutral syllable here, was longer and more prominent than this model reference.`;
  } else if (Math.abs(strongest.relation) >= Math.abs(strongest.register) && previous) {
    message = strongest.relation > 0
      ? `${syllable.hanzi} sat high relative to ${previous.hanzi}; listen across the model references before adjusting it.`
      : `${syllable.hanzi} sat low relative to ${previous.hanzi}; compare their relationship with the model references.`;
  } else if (Math.abs(strongest.movement) > Math.abs(strongest.register)) {
    message = strongest.movement > 0
      ? `Your pitch moved more inside ${syllable?.hanzi || "this syllable"} than in the model references.`
      : `Your pitch stayed more even through ${syllable?.hanzi || "this syllable"} than in the model references.`;
  } else {
    message = strongest.register > 0
      ? `${syllable?.hanzi || "This syllable"} was high relative to the centre of your phrase.`
      : `${syllable?.hanzi || "This syllable"} was low relative to the centre of your phrase.`;
  }
  const hotspots = differences.filter((difference) => difference.severity >= 1.05).slice(0, 2).map((difference) => {
    const item = transcriptSyllables[difference.index];
    return {
      segmentId: item.id,
      level: "syllable" as const,
      label: item.hanzi,
      cue: Math.abs(difference.movement) > Math.abs(difference.register)
        ? (difference.movement > 0 ? "reduce movement" : "shape movement")
        : (difference.register > 0 ? "lower in phrase" : "lift in phrase")
    };
  });
  return { retry: false, message, hotspots };
}

function signedDistanceFromRange(value: number, low: number, high: number): number {
  if (value < low) return value - low;
  if (value > high) return value - high;
  return 0;
}

export function buildQuizQuestions(
  recording: ReferenceRecording,
  transcript: PhraseTranscript,
  level: SegmentLevel = "word"
): QuizQuestion[] {
  const segments = level === "word" ? recording.words : recording.syllables;
  if (segments.length < 2) return [];
  const labels = level === "word"
    ? transcript.words.map((word) => ({ id: word.id, text: word.text }))
    : transcript.words.flatMap((word) => word.syllables.map((syllable) => ({ id: syllable.id, text: syllable.text })));
  const metrics = {
    highest: (segment: SegmentAnalysis) => segment.medianRelativeSemitone,
    lowest: (segment: SegmentAnalysis) => -segment.medianRelativeSemitone,
    "rises-most": (segment: SegmentAnalysis) => segment.endRelativeSemitone - segment.startRelativeSemitone,
    "falls-most": (segment: SegmentAnalysis) => segment.startRelativeSemitone - segment.endRelativeSemitone
  } as const;
  const prompts = {
    highest: `Which ${level} is highest relative to the phrase?`,
    lowest: `Which ${level} is lowest relative to the phrase?`,
    "rises-most": `Which ${level} rises most?`,
    "falls-most": `Which ${level} falls most?`
  } as const;
  return (Object.keys(metrics) as Array<keyof typeof metrics>).flatMap((relation) => {
    const ranked = [...segments].sort((a, b) => metrics[relation](b) - metrics[relation](a));
    const margin = metrics[relation](ranked[0]) - metrics[relation](ranked[1]);
    if (margin < 0.85 || ranked[0].timingConfidence < 0.55) return [];
    return [{
      id: `${level}-${relation}`,
      level,
      relation,
      prompt: prompts[relation],
      answerSegmentId: ranked[0].segmentId,
      optionSegmentIds: labels.map((label) => label.id)
    }];
  });
}

export function mapReferenceToLearner(referenceSec: number, mapping: AlignmentPoint[]): number {
  return interpolateMapping(referenceSec, mapping, "referenceSec", "learnerSec");
}

export function mapLearnerToReference(learnerSec: number, mapping: AlignmentPoint[]): number {
  return interpolateMapping(learnerSec, mapping, "learnerSec", "referenceSec");
}

function extractPitchFrames(samples: Float32Array, sampleRate: number): PitchFrameSample[] {
  const frames: PitchFrameSample[] = [];
  for (let start = 0; start + WINDOW_SIZE < samples.length; start += HOP_SIZE) {
    const window = samples.subarray(start, start + WINDOW_SIZE);
    const energy = rms(window);
    if (energy < 0.0075) continue;
    const pitch = yin(window, sampleRate);
    if (!pitch || pitch.confidence < 0.68) continue;
    frames.push({
      timeSec: (start + WINDOW_SIZE / 2) / sampleRate,
      f0: pitch.frequency,
      confidence: pitch.confidence,
      energy
    });
  }
  return removeOctaveOutliers(frames);
}

function yin(window: Float32Array, sampleRate: number): { frequency: number; confidence: number } | null {
  const minimumLag = Math.floor(sampleRate / MAX_F0);
  const maximumLag = Math.min(Math.floor(sampleRate / MIN_F0), window.length - 2);
  const length = window.length - maximumLag;
  const difference = new Float32Array(maximumLag + 1);
  const normalized = new Float32Array(maximumLag + 1);
  for (let lag = 1; lag <= maximumLag; lag += 1) {
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      const delta = window[index] - window[index + lag];
      total += delta * delta;
    }
    difference[lag] = total;
  }
  let running = 0;
  let estimate = -1;
  for (let lag = 1; lag <= maximumLag; lag += 1) {
    running += difference[lag];
    normalized[lag] = running ? difference[lag] * lag / running : 1;
    if (lag >= minimumLag && normalized[lag] < 0.18) {
      while (lag + 1 <= maximumLag && normalized[lag + 1] < normalized[lag]) lag += 1;
      estimate = lag;
      break;
    }
  }
  if (estimate < 0) return autocorrelationPitch(window, sampleRate, minimumLag, maximumLag);
  const left = normalized[estimate - 1];
  const centre = normalized[estimate];
  const right = normalized[estimate + 1];
  const divisor = left + right - 2 * centre;
  const refined = Math.abs(divisor) > 1e-7 ? estimate + (left - right) / (2 * divisor) : estimate;
  const frequency = sampleRate / refined;
  return frequency >= MIN_F0 && frequency <= MAX_F0
    ? { frequency, confidence: clamp(1 - centre, 0, 1) }
    : null;
}

function autocorrelationPitch(
  window: Float32Array,
  sampleRate: number,
  minimumLag: number,
  maximumLag: number
): { frequency: number; confidence: number } | null {
  let mean = 0;
  for (const sample of window) mean += sample;
  mean /= window.length;
  let bestLag = -1;
  let bestCorrelation = -1;
  const correlations: Array<{ lag: number; value: number }> = [];
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let dot = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    const length = window.length - lag;
    for (let index = 0; index < length; index += 1) {
      const left = window[index] - mean;
      const right = window[index + lag] - mean;
      dot += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const correlation = dot / Math.sqrt(Math.max(1e-12, leftEnergy * rightEnergy));
    correlations.push({ lag, value: correlation });
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  if (bestCorrelation < 0.32 || bestLag < 0) return null;
  const plausibleShorter = correlations.find(({ lag, value }, index) =>
    lag < bestLag && value >= bestCorrelation * 0.92
      && value >= (correlations[index - 1]?.value ?? -1)
      && value >= (correlations[index + 1]?.value ?? -1)
  );
  const lag = plausibleShorter?.lag ?? bestLag;
  return {
    frequency: sampleRate / lag,
    confidence: clamp(0.5 + bestCorrelation * 0.5, 0, 1)
  };
}

function extractAlignmentFeatures(samples: Float32Array, sampleRate: number, pitchFrames: PitchFrameSample[]): AlignmentFeature[] {
  const windowSize = Math.floor(sampleRate * 0.04);
  const hopSize = Math.floor(sampleRate * 0.02);
  let previousSpectrum: Float32Array = new Float32Array(18);
  const output: AlignmentFeature[] = [];
  for (let start = 0; start + windowSize < samples.length; start += hopSize) {
    const window = samples.subarray(start, start + windowSize);
    const timeSec = (start + windowSize / 2) / sampleRate;
    const spectrum = compactSpectrum(window, 18);
    let flux = 0;
    for (let bin = 0; bin < spectrum.length; bin += 1) {
      flux += Math.max(0, spectrum[bin] - previousSpectrum[bin]);
    }
    const nearest = nearestFrame(pitchFrames, timeSec);
    output.push({
      timeSec,
      energy: rms(window),
      spectralFlux: flux / spectrum.length,
      voicing: nearest && Math.abs(nearest.timeSec - timeSec) < 0.035 ? nearest.confidence : 0
    });
    previousSpectrum = spectrum;
  }
  return output;
}

function compactSpectrum(window: Float32Array, bins: number): Float32Array {
  const spectrum = new Float32Array(bins);
  const stride = Math.max(1, Math.floor(window.length / 160));
  for (let bin = 1; bin <= bins; bin += 1) {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < window.length; index += stride) {
      const angle = Math.PI * 2 * bin * index / window.length;
      real += window[index] * Math.cos(angle);
      imaginary -= window[index] * Math.sin(angle);
    }
    spectrum[bin - 1] = Math.hypot(real, imaginary) / (window.length / stride);
  }
  return spectrum;
}

function findTrimmedEdges(features: AlignmentFeature[], durationSec: number): { start: number; end: number } {
  if (!features.length) return { start: 0, end: durationSec };
  const energies = features.map((feature) => feature.energy);
  const threshold = Math.max(0.008, quantile(energies, 0.2) * 2.4, quantile(energies, 0.8) * 0.12);
  const active = features.filter((feature) => feature.energy >= threshold || feature.voicing > 0.55);
  if (!active.length) return { start: 0, end: durationSec };
  return {
    start: Math.max(0, active[0].timeSec - 0.05),
    end: Math.min(durationSec, active[active.length - 1].timeSec + 0.08)
  };
}

function learnerSegment(segment: SegmentAnalysis, runs: RelativePitchRun[], mapping: AlignmentPoint[]): SegmentAnalysis {
  const start = mapReferenceToLearner(segment.startSec, mapping);
  const end = mapReferenceToLearner(segment.endSec, mapping);
  return buildSegmentAnalysis(segment.segmentId, start, end, runs, segment.timingConfidence);
}

function normalizeFeatures(features: AlignmentFeature[]): AlignmentFeature[] {
  const energies = features.map((feature) => feature.energy);
  const fluxes = features.map((feature) => feature.spectralFlux);
  const energyLow = quantile(energies, 0.1);
  const energyHigh = quantile(energies, 0.9);
  const fluxLow = quantile(fluxes, 0.1);
  const fluxHigh = quantile(fluxes, 0.9);
  return features.map((feature) => ({
    ...feature,
    energy: clamp((feature.energy - energyLow) / Math.max(1e-7, energyHigh - energyLow), 0, 1),
    spectralFlux: clamp((feature.spectralFlux - fluxLow) / Math.max(1e-7, fluxHigh - fluxLow), 0, 1)
  }));
}

function featureDistance(a: AlignmentFeature, b: AlignmentFeature): number {
  return Math.abs(a.energy - b.energy) * 0.45
    + Math.abs(a.spectralFlux - b.spectralFlux) * 0.35
    + Math.abs(a.voicing - b.voicing) * 0.2;
}

function retryAlignment(reason: string): PhraseAlignment {
  return { confidence: 0, mapping: [], retryReason: reason };
}

function compressMapping(mapping: AlignmentPoint[]): AlignmentPoint[] {
  if (mapping.length <= 2) return mapping;
  const output = [mapping[0]];
  for (let index = 1; index < mapping.length - 1; index += 1) {
    const previous = output[output.length - 1];
    const current = mapping[index];
    if (current.referenceSec - previous.referenceSec >= 0.04 && current.learnerSec - previous.learnerSec >= 0.02) {
      output.push(current);
    }
  }
  output.push(mapping[mapping.length - 1]);
  return output;
}

function interpolateMapping(
  value: number,
  mapping: AlignmentPoint[],
  inputKey: keyof AlignmentPoint,
  outputKey: keyof AlignmentPoint
): number {
  if (!mapping.length) return value;
  if (value <= mapping[0][inputKey]) return mapping[0][outputKey];
  for (let index = 1; index < mapping.length; index += 1) {
    const before = mapping[index - 1];
    const after = mapping[index];
    if (value <= after[inputKey]) {
      const weight = (value - before[inputKey]) / Math.max(1e-6, after[inputKey] - before[inputKey]);
      return before[outputKey] + (after[outputKey] - before[outputKey]) * clamp(weight, 0, 1);
    }
  }
  return mapping[mapping.length - 1][outputKey];
}

function smoothRun(points: RelativePitchPoint[]): RelativePitchPoint[] {
  return points.map((point, index) => {
    const nearby = points.slice(Math.max(0, index - 2), Math.min(points.length, index + 3));
    return { ...point, semitone: finiteOrZero(robustMedian(nearby.map((item) => item.semitone))) };
  });
}

function removeOctaveOutliers(frames: PitchFrameSample[]): PitchFrameSample[] {
  if (frames.length < 5) return frames;
  return frames.filter((frame, index) => {
    const nearby = frames.slice(Math.max(0, index - 4), Math.min(frames.length, index + 5));
    const median = robustMedian(nearby.map((item) => hzToSemitone(item.f0)));
    return Math.abs(hzToSemitone(frame.f0) - median) < 7.5;
  });
}

function nearestFrame(frames: PitchFrameSample[], timeSec: number): PitchFrameSample | null {
  let best: PitchFrameSample | null = null;
  for (const frame of frames) {
    if (!best || Math.abs(frame.timeSec - timeSec) < Math.abs(best.timeSec - timeSec)) best = frame;
    if (frame.timeSec > timeSec + 0.04) break;
  }
  return best;
}

function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate * 1.02) return samples;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const from = Math.floor(index * ratio);
    const to = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let source = from; source < to; source += 1) total += samples[source];
    output[index] = total / Math.max(1, to - from);
  }
  return output;
}

function rms(samples: Float32Array): number {
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / Math.max(1, samples.length));
}

function quantile(values: number[], amount: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * amount;
  const lower = Math.floor(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + (sorted[lower + 1] ?? sorted[lower]) * weight;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
