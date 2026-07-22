export interface PlaybackProgress {
  progress: number;
  currentTime: number;
  duration: number;
  done: boolean;
}

export interface PlaybackOptions {
  onProgress?: (progress: PlaybackProgress) => void;
}

type AudioContextConstructor = new () => AudioContext;

let sharedAudioContext: AudioContext | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeAudioDone: (() => void) | null = null;

export function getAudioContext(): AudioContext {
  const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext) as AudioContextConstructor | undefined;
  if (!AudioContextClass) throw new Error("This browser does not expose the Web Audio API.");
  if (!sharedAudioContext) sharedAudioContext = new AudioContextClass();
  return sharedAudioContext;
}

export async function playAudioSource(src: string, options: PlaybackOptions = {}): Promise<void> {
  stopActivePlayback();
  const audio = new Audio(src);
  activeAudio = audio;
  audio.preload = "auto";
  await new Promise<void>((resolve, reject) => {
    let stopProgress = () => {};
    let settled = false;
    const finish = (done: boolean, error: Error | null = null) => {
      if (settled) return;
      settled = true;
      stopProgress();
      emitAudioProgress(audio, options, done);
      if (activeAudio === audio) {
        activeAudio = null;
        activeAudioDone = null;
      }
      error ? reject(error) : resolve();
    };
    activeAudioDone = () => finish(false);
    audio.addEventListener("ended", () => finish(true), { once: true });
    audio.addEventListener("error", () => finish(false, new Error("Audio playback failed.")), { once: true });
    stopProgress = startAudioProgress(audio, options);
    audio.play().catch((error) => finish(false, error instanceof Error ? error : new Error("Audio playback failed.")));
  });
}

export async function playAudioSegment(
  src: string,
  startSec: number,
  endSec: number,
  options: PlaybackOptions = {}
): Promise<void> {
  stopActivePlayback();
  const audio = new Audio(src);
  activeAudio = audio;
  audio.preload = "auto";
  const start = Math.max(0, startSec);
  const end = Math.max(start + 0.05, endSec);
  await new Promise<void>((resolve, reject) => {
    let frameId = 0;
    let settled = false;
    const finish = (done: boolean, error: Error | null = null) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frameId);
      audio.pause();
      options.onProgress?.({
        progress: done ? 1 : clamp((audio.currentTime - start) / (end - start), 0, 1),
        currentTime: clamp(audio.currentTime - start, 0, end - start),
        duration: end - start,
        done
      });
      if (activeAudio === audio) {
        activeAudio = null;
        activeAudioDone = null;
      }
      error ? reject(error) : resolve();
    };
    const tick = () => {
      options.onProgress?.({
        progress: clamp((audio.currentTime - start) / (end - start), 0, 1),
        currentTime: clamp(audio.currentTime - start, 0, end - start),
        duration: end - start,
        done: false
      });
      if (audio.currentTime >= end) finish(true);
      else if (!settled) frameId = requestAnimationFrame(tick);
    };
    activeAudioDone = () => finish(false);
    audio.addEventListener("loadedmetadata", () => {
      audio.currentTime = Math.min(start, Math.max(0, audio.duration - 0.05));
      audio.play().then(() => { frameId = requestAnimationFrame(tick); }).catch((error) => finish(false, error));
    }, { once: true });
    audio.addEventListener("ended", () => finish(true), { once: true });
    audio.addEventListener("error", () => finish(false, new Error("Audio playback failed.")), { once: true });
  });
}

export function stopActivePlayback(): void {
  if (!activeAudio) return;
  const done = activeAudioDone;
  activeAudio.pause();
  activeAudio = null;
  activeAudioDone = null;
  done?.();
}

export async function decodeBlobToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  const context = getAudioContext();
  if (context.state !== "running") await context.resume();
  const arrayBuffer = await blob.arrayBuffer();
  return context.decodeAudioData(arrayBuffer.slice(0));
}

function startAudioProgress(audio: HTMLAudioElement, options: PlaybackOptions): () => void {
  if (!options.onProgress) return () => {};
  let frameId = 0;
  let stopped = false;
  let startedAt = performance.now();
  const syncStartedAt = () => { startedAt = performance.now() - (audio.currentTime || 0) * 1000; };
  const tick = () => {
    emitAudioProgress(audio, options, false, startedAt);
    if (!stopped) frameId = requestAnimationFrame(tick);
  };
  audio.addEventListener("playing", syncStartedAt);
  emitAudioProgress(audio, options, false);
  frameId = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    audio.removeEventListener("playing", syncStartedAt);
    cancelAnimationFrame(frameId);
  };
}

function emitAudioProgress(audio: HTMLAudioElement, options: PlaybackOptions, done: boolean, startedAt = 0): void {
  if (!options.onProgress) return;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const mediaTime = duration ? clamp(audio.currentTime || 0, 0, duration) : 0;
  const elapsedTime = duration && startedAt && !audio.paused ? clamp((performance.now() - startedAt) / 1000, 0, duration) : 0;
  const currentTime = !done && duration && mediaTime < 0.05 && elapsedTime > 0.12 ? elapsedTime : mediaTime;
  options.onProgress({
    progress: done ? 1 : duration ? clamp(currentTime / duration, 0, 1) : 0,
    currentTime: done && duration ? duration : currentTime,
    duration,
    done
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

