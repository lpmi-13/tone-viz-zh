import type {
  LearnerComparison,
  PhraseTranscript,
  ReferenceRecording,
  RelativePitchRun,
  RelativePitchPoint,
  SegmentAnalysis
} from "./phrase-types.js";

const DISPLAY_MEDIAN_RADIUS_SEC = 0.055;
const DISPLAY_GAUSSIAN_RADIUS_SEC = 0.09;
const DISPLAY_GAUSSIAN_SIGMA_SEC = 0.038;
const DISPLAY_OUTLIER_LIMIT_SEMITONES = 2.25;
const DISPLAY_MIN_POINT_SPACING_SEC = 0.024;

interface PhraseChartOptions {
  reference: ReferenceRecording | null;
  otherReferences?: ReferenceRecording[];
  learner: LearnerComparison | null;
  transcript: PhraseTranscript;
  selectedSegmentId?: string | null;
  playbackTimeSec?: number | null;
  emptyText?: string;
}

export function renderPhraseChart(container: HTMLElement, options: PhraseChartOptions): void {
  const { reference, learner, transcript } = options;
  if (!reference) {
    container.innerHTML = `<div class="chart-empty">${escapeHtml(options.emptyText || "Reference analysis is loading…")}</div>`;
    return;
  }
  const width = 960;
  const height = 430;
  const plotLeft = 64;
  const plotRight = 936;
  const plotWidth = plotRight - plotLeft;
  const referenceTop = 52;
  const learnerTop = 205;
  const laneHeight = 114;
  const relationshipTop = 342;
  const relationshipHeight = 34;
  const overviewTop = 399;
  // Keep a stable vertical scale while zooming so a learner never mistakes
  // magnification for a pitch change.
  const extent = 8;
  const selected = findSelectedSegment(reference, options.selectedSegmentId || null);
  const selectedWordIndex = selected
    ? reference.words.findIndex((word) => selected.startSec >= word.startSec - 0.001 && selected.endSec <= word.endSec + 0.001)
    : -1;
  const x = buildTimeScale(reference.durationSec, plotLeft, plotWidth, selected, reference.words);
  const y = (value: number, top: number) => top + laneHeight / 2 - value / extent * (laneHeight / 2 - 8);
  const lines: string[] = [];

  lines.push(`<svg class="phrase-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chartTitle chartDesc">`);
  lines.push(`<title id="chartTitle">Reference and learner phrase-centred pitch contours</title>`);
  lines.push(`<desc id="chartDesc">Both recordings use the same semitone scale centred on their own robust phrase median. Contours are gently smoothed for readability. Gaps are unvoiced sound, not connected pitch.</desc>`);
  lines.push(`<rect class="chart-lane reference-lane" x="${plotLeft}" y="${referenceTop}" width="${plotWidth}" height="${laneHeight}" rx="14"/>`);
  lines.push(`<rect class="chart-lane learner-lane" x="${plotLeft}" y="${learnerTop}" width="${plotWidth}" height="${laneHeight}" rx="14"/>`);
  lines.push(`<text class="lane-label" x="${plotLeft}" y="28">REFERENCE</text>`);
  lines.push(`<text class="lane-label" x="${plotLeft}" y="199">YOUR PHRASE</text>`);
  lines.push(`<text class="relationship-label" x="${plotLeft}" y="337">RELATIONSHIP</text>`);

  for (let tick = -Math.floor(extent); tick <= Math.floor(extent); tick += 2) {
    for (const top of [referenceTop, learnerTop]) {
      const tickY = y(tick, top);
      lines.push(`<line class="semitone-grid ${tick === 0 ? "zero" : ""}" x1="${plotLeft}" y1="${tickY}" x2="${plotRight}" y2="${tickY}"/>`);
      lines.push(`<text class="semitone-label" x="${plotLeft - 10}" y="${tickY + 4}" text-anchor="end">${tick > 0 ? "+" : ""}${tick}</text>`);
    }
  }

  for (const [index, segment] of reference.words.entries()) {
    if (selected && Math.abs(index - selectedWordIndex) > 1) continue;
    const boundaryX = x(segment.startSec);
    lines.push(`<line class="word-boundary ${segment.timingConfidence < 0.75 ? "approximate" : ""}" x1="${boundaryX}" y1="${referenceTop}" x2="${boundaryX}" y2="${learnerTop + laneHeight}"/>`);
  }
  lines.push(`<line class="word-boundary" x1="${x(reference.durationSec)}" y1="${referenceTop}" x2="${x(reference.durationSec)}" y2="${learnerTop + laneHeight}"/>`);

  for (const other of options.otherReferences || []) {
    const normalizedRuns = other.pitchRuns.map((run) => ({
      points: run.points.map((point) => ({
        ...point,
        timeSec: point.timeSec / Math.max(0.01, other.durationSec) * reference.durationSec
      }))
    }));
    lines.push(...drawRuns(normalizedRuns, x, (value) => y(value, referenceTop), "other-contour"));
  }
  lines.push(...drawRuns(reference.pitchRuns, x, (value) => y(value, referenceTop), "reference-contour"));
  if (learner?.alignedPitchRuns.length) {
    lines.push(...drawRuns(learner.alignedPitchRuns, x, (value) => y(value, learnerTop), "learner-contour"));
  } else {
    lines.push(`<text class="empty-lane-label" x="${(plotLeft + plotRight) / 2}" y="${learnerTop + laneHeight / 2 + 5}" text-anchor="middle">Record the whole phrase to add your lane</text>`);
  }

  if (selected) {
    const selectedStartX = x(selected.startSec);
    const selectedEndX = x(selected.endSec);
    for (const top of [referenceTop, learnerTop]) {
      lines.push(`<rect class="context-fade" x="${plotLeft}" y="${top}" width="${Math.max(0, selectedStartX - plotLeft)}" height="${laneHeight}" rx="14"/>`);
      lines.push(`<rect class="context-fade" x="${selectedEndX}" y="${top}" width="${Math.max(0, plotRight - selectedEndX)}" height="${laneHeight}" rx="14"/>`);
    }
  }

  const transcriptWords = transcript.words;
  reference.words.forEach((segment, index) => {
    if (selected && Math.abs(index - selectedWordIndex) > 1) return;
    const word = transcriptWords[index];
    if (!word) return;
    const centreX = x((segment.startSec + segment.endSec) / 2);
    const isSelected = options.selectedSegmentId === word.id || word.syllables.some((syllable) => syllable.id === options.selectedSegmentId);
    lines.push(`<g class="chart-word ${isSelected ? "selected" : selected ? "context-neighbor" : ""}" data-segment-id="${escapeHtml(word.id)}" role="button" tabindex="0">`);
    lines.push(`<rect x="${x(segment.startSec) + 2}" y="${referenceTop + laneHeight + 7}" width="${Math.max(4, x(segment.endSec) - x(segment.startSec) - 4)}" height="26" rx="8"/>`);
    lines.push(`<text x="${centreX}" y="${referenceTop + laneHeight + 18}" text-anchor="middle">${escapeHtml(word.text)}</text></g>`);
  });

  lines.push(`<rect class="relationship-lane" x="${plotLeft}" y="${relationshipTop}" width="${plotWidth}" height="${relationshipHeight}" rx="10"/>`);
  if (learner?.words.length) {
    reference.words.forEach((target, index) => {
      const attempt = learner.words[index];
      if (!attempt) return;
      const difference = attempt.medianRelativeSemitone - target.medianRelativeSemitone;
      const centreX = x((target.startSec + target.endSec) / 2);
      const barHeight = Math.min(relationshipHeight / 2 - 3, Math.abs(difference) * 4.2);
      const centreY = relationshipTop + relationshipHeight / 2;
      lines.push(`<line class="relationship-mark ${Math.abs(difference) > 1.15 ? "strong" : ""}" x1="${centreX}" y1="${centreY}" x2="${centreX}" y2="${centreY - Math.sign(difference) * barHeight}"/>`);
    });
  } else {
    lines.push(`<text class="relationship-empty" x="${(plotLeft + plotRight) / 2}" y="${relationshipTop + 22}" text-anchor="middle">Differences appear here after alignment</text>`);
  }

  lines.push(`<line class="overview-line" x1="${plotLeft}" y1="${overviewTop}" x2="${plotRight}" y2="${overviewTop}"/>`);
  for (const word of reference.words) {
    const overviewX = plotLeft + word.startSec / reference.durationSec * plotWidth;
    lines.push(`<line class="overview-tick" x1="${overviewX}" y1="${overviewTop - 4}" x2="${overviewX}" y2="${overviewTop + 4}"/>`);
  }
  if (selected) {
    lines.push(`<rect class="overview-viewport" x="${plotLeft + selected.startSec / reference.durationSec * plotWidth}" y="${overviewTop - 8}" width="${Math.max(8, (selected.endSec - selected.startSec) / reference.durationSec * plotWidth)}" height="16" rx="5"/>`);
  }

  if (Number.isFinite(options.playbackTimeSec)) {
    const playheadX = x(options.playbackTimeSec as number);
    lines.push(`<line class="chart-playhead" x1="${playheadX}" y1="${referenceTop - 10}" x2="${playheadX}" y2="${learnerTop + laneHeight}"/>`);
  }
  lines.push(`</svg>`);
  container.innerHTML = lines.join("");
}

export function renderExplorerChart(container: HTMLElement, runs: RelativePitchRun[], durationSec: number): void {
  if (!runs.length) {
    container.innerHTML = `<div class="chart-empty">Record any short phrase to see phrase-centred voiced pitch runs.</div>`;
    return;
  }
  const width = 960;
  const height = 300;
  const left = 60;
  const right = 938;
  const top = 32;
  const laneHeight = 220;
  const extent = getSymmetricExtent(runs);
  const x = (time: number) => left + clamp(time / Math.max(0.01, durationSec), 0, 1) * (right - left);
  const y = (value: number) => top + laneHeight / 2 - value / extent * (laneHeight / 2 - 12);
  const lines = [
    `<svg class="phrase-chart-svg explorer-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Phrase-centred semitone contour">`,
    `<rect class="chart-lane learner-lane" x="${left}" y="${top}" width="${right - left}" height="${laneHeight}" rx="14"/>`
  ];
  for (let tick = -Math.floor(extent); tick <= Math.floor(extent); tick += 2) {
    lines.push(`<line class="semitone-grid ${tick === 0 ? "zero" : ""}" x1="${left}" y1="${y(tick)}" x2="${right}" y2="${y(tick)}"/>`);
    lines.push(`<text class="semitone-label" x="${left - 10}" y="${y(tick) + 4}" text-anchor="end">${tick > 0 ? "+" : ""}${tick}</text>`);
  }
  lines.push(...drawRuns(runs, x, y, "learner-contour"));
  lines.push(`<text class="axis-caption" x="${left}" y="${height - 14}">semitones from this phrase’s centre · gently smoothed · unvoiced gaps stay open</text></svg>`);
  container.innerHTML = lines.join("");
}

function drawRuns(
  runs: RelativePitchRun[],
  x: (time: number) => number,
  y: (semitone: number) => number,
  className: string
): string[] {
  return runs.flatMap((run) => {
    if (run.points.length < 2) return [];
    const points = downsampleDisplayPoints(smoothPitchRunForDisplay(run));
    const confidence = clamp(points.reduce((total, point) => total + point.confidence, 0) / points.length, 0.22, 1);
    return [`<path class="pitch-run ${className}" opacity="${confidence.toFixed(2)}" d="${buildCurvePath(points, x, y)}"/>`];
  });
}

export function smoothPitchRunForDisplay(run: RelativePitchRun): RelativePitchPoint[] {
  if (run.points.length < 3) return run.points.map((point) => ({ ...point }));
  const medianFiltered = run.points.map((point) => {
    const neighborhood = run.points.filter((candidate) =>
      Math.abs(candidate.timeSec - point.timeSec) <= DISPLAY_MEDIAN_RADIUS_SEC
    );
    const median = getMedian(neighborhood.map((candidate) => candidate.semitone));
    return {
      ...point,
      semitone: clamp(
        point.semitone,
        median - DISPLAY_OUTLIER_LIMIT_SEMITONES,
        median + DISPLAY_OUTLIER_LIMIT_SEMITONES
      )
    };
  });
  return medianFiltered.map((point, index) => {
    let weightedPitch = 0;
    let totalWeight = 0;
    for (const candidate of medianFiltered) {
      const distance = candidate.timeSec - point.timeSec;
      if (Math.abs(distance) > DISPLAY_GAUSSIAN_RADIUS_SEC) continue;
      const weight = Math.exp(-(distance * distance) / (2 * DISPLAY_GAUSSIAN_SIGMA_SEC ** 2));
      weightedPitch += candidate.semitone * weight;
      totalWeight += weight;
    }
    const smoothed = totalWeight ? weightedPitch / totalWeight : point.semitone;
    const endpointBlend = index === 0 || index === medianFiltered.length - 1 ? 0.32 : 0;
    return {
      ...point,
      semitone: smoothed * (1 - endpointBlend) + point.semitone * endpointBlend
    };
  });
}

function downsampleDisplayPoints(points: RelativePitchPoint[]): RelativePitchPoint[] {
  if (points.length <= 3) return points;
  const output = [points[0]];
  for (const point of points.slice(1, -1)) {
    if (point.timeSec - output[output.length - 1].timeSec >= DISPLAY_MIN_POINT_SPACING_SEC) output.push(point);
  }
  output.push(points[points.length - 1]);
  return output;
}

function buildCurvePath(
  points: RelativePitchPoint[],
  x: (time: number) => number,
  y: (semitone: number) => number
): string {
  const coordinates = points.map((point) => ({ x: x(point.timeSec), y: y(point.semitone) }));
  if (coordinates.length === 2) {
    return `M ${format(coordinates[0].x)} ${format(coordinates[0].y)} L ${format(coordinates[1].x)} ${format(coordinates[1].y)}`;
  }
  const commands = [`M ${format(coordinates[0].x)} ${format(coordinates[0].y)}`];
  const tension = 0.72;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const before = coordinates[Math.max(0, index - 1)];
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const after = coordinates[Math.min(coordinates.length - 1, index + 2)];
    const minimumY = Math.min(start.y, end.y);
    const maximumY = Math.max(start.y, end.y);
    const control1 = {
      x: start.x + (end.x - before.x) / 6 * tension,
      y: clamp(start.y + (end.y - before.y) / 6 * tension, minimumY, maximumY)
    };
    const control2 = {
      x: end.x - (after.x - start.x) / 6 * tension,
      y: clamp(end.y - (after.y - start.y) / 6 * tension, minimumY, maximumY)
    };
    commands.push(`C ${format(control1.x)} ${format(control1.y)} ${format(control2.x)} ${format(control2.y)} ${format(end.x)} ${format(end.y)}`);
  }
  return commands.join(" ");
}

function getSymmetricExtent(runs: RelativePitchRun[]): number {
  const maximum = Math.max(0, ...runs.flatMap((run) => run.points.map((point) => Math.abs(point.semitone))));
  return Math.max(4, Math.ceil((maximum + 0.75) / 2) * 2);
}

function getMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function format(value: number): string {
  return value.toFixed(2);
}

function findSelectedSegment(reference: ReferenceRecording, id: string | null): SegmentAnalysis | null {
  if (!id) return null;
  return [...reference.words, ...reference.syllables].find((segment) => segment.segmentId === id) || null;
}

function buildTimeScale(
  duration: number,
  left: number,
  width: number,
  selected: SegmentAnalysis | null,
  words: SegmentAnalysis[]
): (time: number) => number {
  if (!selected) return (time) => left + clamp(time / Math.max(0.01, duration), 0, 1) * width;
  const wordIndex = words.findIndex((word) => selected.startSec >= word.startSec - 0.001 && selected.endSec <= word.endSec + 0.001);
  const viewStart = words[Math.max(0, wordIndex - 1)]?.startSec ?? 0;
  const viewEnd = words[Math.min(words.length - 1, wordIndex + 1)]?.endSec ?? duration;
  return (time) => {
    if (time <= selected.startSec) {
      return left + clamp((time - viewStart) / Math.max(0.001, selected.startSec - viewStart), 0, 1) * width * 0.18;
    }
    if (time <= selected.endSec) {
      return left + width * (0.18 + clamp((time - selected.startSec) / Math.max(0.001, selected.endSec - selected.startSec), 0, 1) * 0.64);
    }
    return left + width * (0.82 + clamp((time - selected.endSec) / Math.max(0.001, viewEnd - selected.endSec), 0, 1) * 0.18);
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
