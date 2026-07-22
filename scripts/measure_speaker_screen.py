#!/usr/bin/env python3
"""Measure the complete diagnostic screen with pinned CPU models.

This stage loads Paraformer and CAM++ once, prepares/runs MFA, extracts aligned
F0 landmarks and acoustic traits, and writes every manifest consumed by the
speaker scorer. No human decision or demographic inference is involved.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import shutil
import subprocess
from collections import defaultdict
from pathlib import Path
from statistics import median
from typing import Any

import numpy as np
import soundfile as sf

from pipeline_common import load_json, percentile, wav_metrics, write_json

ROOT = Path(__file__).resolve().parents[1]


def build_engines(config: dict[str, Any], threads: int):
    try:
        import sherpa_onnx  # type: ignore
    except ImportError as error:
        raise SystemExit("Install requirements-pipeline.txt before measurement") from error
    asr_dir = ROOT / config["asr"]["modelDirectory"]
    recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
        paraformer=str(asr_dir / "model.int8.onnx"), tokens=str(asr_dir / "tokens.txt"),
        num_threads=threads, sample_rate=16000, feature_dim=80, decoding_method="greedy_search", debug=False,
    )
    embedding_config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(ROOT / config["speakerEmbedding"]["path"]), num_threads=threads, debug=False, provider="cpu",
    )
    if not embedding_config.validate():
        raise SystemExit("Invalid CAM++ speaker-embedding configuration")
    return recognizer, sherpa_onnx.SpeakerEmbeddingExtractor(embedding_config)


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    samples, sample_rate = sf.read(path, always_2d=True, dtype="float32")
    return np.ascontiguousarray(samples[:, 0]), sample_rate


def recognize(recognizer, samples: np.ndarray, sample_rate: int) -> str:
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    recognizer.decode_stream(stream)
    return re.sub(r"[\s，。！？、,.!?]", "", stream.result.text)


def embedding(extractor, samples: np.ndarray, sample_rate: int) -> list[float]:
    if len(samples) < int(sample_rate * 1.5):
        samples = np.pad(samples, (0, int(sample_rate * 1.5) - len(samples)))
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=sample_rate, waveform=samples)
    stream.input_finished()
    if not extractor.is_ready(stream):
        raise ValueError("Insufficient audio for a speaker embedding")
    vector = np.asarray(extractor.compute(stream), dtype=np.float64)
    norm = np.linalg.norm(vector)
    if not norm:
        raise ValueError("Zero speaker embedding")
    return (vector / norm).tolist()


def prepare_mfa(manifest: dict[str, Any], diagnostics: dict[str, dict[str, Any]], workspace: Path) -> None:
    corpus = workspace / "corpus"
    if workspace.exists():
        shutil.rmtree(workspace)
    corpus.mkdir(parents=True)
    for entry in manifest["entries"].values():
        speaker_dir = corpus / entry["speaker"]
        speaker_dir.mkdir(exist_ok=True)
        source = ROOT / "artifacts/speaker-selection/screening-audio" / entry["speaker"] / f"{entry['phraseId']}.wav"
        shutil.copy2(source, speaker_dir / f"{entry['phraseId']}.wav")
        # One Hanzi token per syllable makes the word tier directly mappable.
        (speaker_dir / f"{entry['phraseId']}.lab").write_text(" ".join(diagnostics[entry["phraseId"]]["hanzi"]) + "\n")


def run_mfa(workspace: Path, executable: str, threads: int, download_models: bool) -> None:
    resolved_executable = shutil.which(executable)
    if not resolved_executable:
        raise SystemExit("MFA executable not found. Install the pinned MFA environment first.")
    mfa_environment = os.environ.copy()
    mfa_environment["PATH"] = f"{Path(resolved_executable).resolve().parent}{os.pathsep}{mfa_environment.get('PATH', '')}"
    if download_models:
        subprocess.run([resolved_executable, "model", "download", "acoustic", "mandarin_mfa"], check=True, env=mfa_environment)
        subprocess.run([resolved_executable, "model", "download", "dictionary", "mandarin_china_mfa"], check=True, env=mfa_environment)
    corpus, output = workspace / "corpus", workspace / "output"
    subprocess.run([resolved_executable, "validate", str(corpus), "mandarin_china_mfa", "--acoustic_model", "mandarin_mfa", "--clean", "--num_jobs", str(threads)], check=True, env=mfa_environment)
    subprocess.run([resolved_executable, "align", str(corpus), "mandarin_china_mfa", "mandarin_mfa", str(output), "--clean", "--num_jobs", str(threads)], check=True, env=mfa_environment)


def parse_word_intervals(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(errors="replace")
    tier = re.search(r'name\s*=\s*"(?:words|word)"(.*?)(?=\n\s*item \[|\Z)', text, re.S)
    if not tier:
        return []
    pattern = re.compile(r'intervals \[\d+\]:\s*xmin = ([\d.eE+-]+)\s*xmax = ([\d.eE+-]+)\s*text = "(.*?)"', re.S)
    return [{"startSec": float(start), "endSec": float(end), "text": label} for start, end, label in pattern.findall(tier.group(1)) if label.strip()]


def surface_classes(hanzi: str, tones: list[int]) -> list[str]:
    classes = []
    for index, (character, tone) in enumerate(zip(hanzi, tones)):
        following = tones[index + 1] if index + 1 < len(tones) else None
        if tone == 5:
            classes.append("neutral")
        elif character == "一" and following:
            classes.append("tone-2-rising" if following == 4 else "tone-4-falling")
        elif character == "不" and following == 4:
            classes.append("tone-2-rising")
        elif tone == 3 and following == 3:
            classes.append("sandhi-rising")
        elif tone == 3 and following:
            classes.append("tone-3-low")
        else:
            classes.append({1: "tone-1-level", 2: "tone-2-rising", 3: "tone-3-final", 4: "tone-4-falling"}[tone])
    return classes


def pitch_track(samples: np.ndarray, sample_rate: int) -> list[tuple[float, float, float]]:
    window_size, hop = int(sample_rate * .04), int(sample_rate * .01)
    minimum_lag, maximum_lag = int(sample_rate / 500), int(sample_rate / 60)
    output = []
    for start in range(0, max(0, len(samples) - window_size), hop):
        frame = samples[start:start + window_size].astype(np.float64)
        rms = float(np.sqrt(np.mean(frame ** 2)))
        if rms < .006:
            continue
        frame -= np.mean(frame)
        correlation = np.correlate(frame, frame, mode="full")[len(frame) - 1:]
        maximum = min(maximum_lag, len(correlation) - 2)
        lags = np.arange(minimum_lag, maximum + 1)
        if not len(lags):
            continue
        energy = np.concatenate(([0.0], np.cumsum(frame ** 2)))
        left_energy = energy[window_size - lags]
        right_energy = energy[window_size] - energy[lags]
        normalized = correlation[lags] / np.sqrt(np.maximum(1e-12, left_energy * right_energy))
        best_position = int(np.argmax(normalized))
        best_correlation = float(normalized[best_position])
        if best_correlation < .32:
            continue
        local_peaks = [
            index for index in range(1, len(normalized) - 1)
            if normalized[index] >= normalized[index - 1]
            and normalized[index] >= normalized[index + 1]
            and normalized[index] >= best_correlation * .92
        ]
        position = local_peaks[0] if local_peaks else best_position
        lag = float(lags[position])
        if 0 < position < len(normalized) - 1:
            left, centre, right = normalized[position - 1:position + 2]
            divisor = left + right - 2 * centre
            if abs(divisor) > 1e-8:
                lag += float((left - right) / (2 * divisor))
        confidence = float(.5 + .5 * normalized[position])
        frequency = sample_rate / lag
        if confidence >= .32 and 60 <= frequency <= 500:
            output.append(((start + window_size / 2) / sample_rate, frequency, confidence))
    if len(output) < 5:
        return output
    semitones = [69 + 12 * math.log2(item[1] / 440) for item in output]
    return [
        item for index, item in enumerate(output)
        if abs(semitones[index] - median(semitones[max(0, index - 4):index + 5])) < 7.5
    ]


def pitch_features(track: list[tuple[float, float, float]], intervals: list[dict[str, Any]], classes: list[str], phrase_id: str, speaker: str) -> list[dict[str, Any]]:
    phrase_values = [69 + 12 * math.log2(frequency / 440) for _, frequency, _ in track]
    centre = median(phrase_values) if phrase_values else 0
    output = []
    for index, (interval, class_name) in enumerate(zip(intervals, classes)):
        frames = [(time, 69 + 12 * math.log2(frequency / 440) - centre, confidence) for time, frequency, confidence in track if interval["startSec"] <= time <= interval["endSec"]]
        pitches = [item[1] for item in frames]
        edge = max(1, len(pitches) // 4)
        minimum_index = int(np.argmin(pitches)) if pitches else 0
        output.append({
            "speaker": speaker, "phraseId": phrase_id, "syllableIndex": index, "surfaceToneClass": class_name,
            "startSemitone": median(pitches[:edge]) if pitches else 0, "endSemitone": median(pitches[-edge:]) if pitches else 0,
            "minimumSemitone": min(pitches, default=0), "maximumSemitone": max(pitches, default=0),
            "medianSemitone": median(pitches) if pitches else 0,
            "turningPoint": minimum_index / max(1, len(pitches) - 1),
            "durationSec": interval["endSec"] - interval["startSec"],
            "voicedRatio": min(1, len(frames) * .01 / max(.01, interval["endSec"] - interval["startSec"])),
            "pitchConfidence": median([item[2] for item in frames]) if frames else 0,
        })
    return output


def acoustic_vector(samples: np.ndarray, sample_rate: int, track: list[tuple[float, float, float]], syllable_count: int) -> dict[str, Any]:
    frame_size, hop = int(sample_rate * .04), int(sample_rate * .02)
    centroids, tilts, mfccs, hnrs, cpp_values = [], [], [], [], []
    for start in range(0, max(0, len(samples) - frame_size), hop):
        frame = samples[start:start + frame_size].astype(np.float64) * np.hanning(frame_size)
        energy = np.sqrt(np.mean(frame ** 2))
        if energy < .006:
            continue
        spectrum = np.abs(np.fft.rfft(frame)) + 1e-9
        frequencies = np.fft.rfftfreq(frame_size, 1 / sample_rate)
        centroids.append(float(np.sum(frequencies * spectrum) / np.sum(spectrum)))
        usable = (frequencies >= 100) & (frequencies <= 5000)
        tilts.append(float(np.polyfit(np.log(frequencies[usable]), np.log(spectrum[usable]), 1)[0]))
        bands = np.array_split(np.log(spectrum[1:]), 16)
        log_bands = np.array([np.mean(band) for band in bands])
        mfccs.append([float(np.sum(log_bands * np.cos(np.pi * coefficient * (np.arange(16) + .5) / 16))) for coefficient in range(1, 7)])
        correlation = np.correlate(frame, frame, mode="full")[frame_size - 1:]
        correlation /= max(1e-12, correlation[0])
        peak = float(np.max(correlation[int(sample_rate / 500):int(sample_rate / 60)]))
        hnrs.append(10 * math.log10(max(1e-6, peak) / max(1e-6, 1 - peak)))
        cepstrum = np.fft.irfft(np.log(spectrum))
        cpp_values.append(float(np.max(cepstrum[int(sample_rate / 500):int(sample_rate / 60)])))
    f0 = [frequency for _, frequency, _ in track]
    voiced_duration = len(track) * .01
    duration = len(samples) / sample_rate
    mfcc_matrix = np.asarray(mfccs) if mfccs else np.zeros((1, 6))
    spectral = [median(centroids) if centroids else 0, median(tilts) if tilts else 0,
                *np.mean(mfcc_matrix, axis=0).tolist(), *np.std(mfcc_matrix, axis=0).tolist(),
                median(hnrs) if hnrs else 0, median(cpp_values) if cpp_values else 0,
                1 - median([confidence for _, _, confidence in track]) if track else 1]
    return {
        "medianLogF0": math.log(median(f0)) if f0 else 0,
        "pitchPercentiles": [percentile(f0, value) for value in (.1, .5, .9)],
        "spectralVector": spectral, "speakingRate": syllable_count / max(.1, voiced_duration),
        "pauseRatio": max(0, 1 - voiced_duration / max(.1, duration)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mfa", default="mfa")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--download-mfa-models", action="store_true")
    parser.add_argument("--skip-mfa", action="store_true", help="Reuse an existing measurement-work/output directory")
    parser.add_argument("--limit-speakers", type=int)
    args = parser.parse_args()
    threads = max(1, min(4, args.threads))
    artifacts = ROOT / "artifacts/speaker-selection"
    manifest = load_json(artifacts / "screening-manifest.json")
    diagnostic_list = load_json(artifacts / "diagnostic-corpus.json")["phrases"]
    diagnostics = {item["id"]: item for item in diagnostic_list}
    entries = list(manifest["entries"].values())
    if args.limit_speakers:
        names = sorted({item["speaker"] for item in entries})[:args.limit_speakers]
        entries = [item for item in entries if item["speaker"] in names]
        manifest = {**manifest, "entries": {f"{item['speaker']}/{item['phraseId']}": item for item in entries}}
    workspace = ROOT / "artifacts/speaker-selection/measurement-work"
    if not args.skip_mfa:
        prepare_mfa(manifest, diagnostics, workspace)
        run_mfa(workspace, args.mfa, threads, args.download_mfa_models)
    recognizer, extractor = build_engines(load_json(ROOT / "config/generation.json"), threads)
    asr_entries, embedding_entries, pitch_entries = [], [], []
    acoustic_by_speaker: dict[str, list[dict[str, Any]]] = defaultdict(list)
    tone_excursions: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for entry in entries:
        phrase = diagnostics[entry["phraseId"]]
        wav = artifacts / "screening-audio" / entry["speaker"] / f"{entry['phraseId']}.wav"
        samples, sample_rate = read_audio(wav)
        hypothesis = recognize(recognizer, samples, sample_rate)
        reference = re.sub(r"\s", "", phrase["hanzi"])
        textgrid = workspace / "output" / entry["speaker"] / f"{entry['phraseId']}.TextGrid"
        intervals = parse_word_intervals(textgrid)
        aligned = len(intervals) == len(phrase["hanzi"])
        asr_entries.append({"speaker": entry["speaker"], "phraseId": entry["phraseId"], "reference": reference,
                            "hypothesis": hypothesis, "diagnosticTargetsCorrect": phrase["diagnosticTarget"] in hypothesis,
                            "alignmentConfidence": 1 if aligned else 0})
        embedding_entries.append({"speaker": entry["speaker"], "phraseId": entry["phraseId"], "vector": embedding(extractor, samples, sample_rate)})
        if not aligned:
            continue
        track = pitch_track(samples, sample_rate)
        features = pitch_features(track, intervals, surface_classes(phrase["hanzi"], phrase["citationTones"]), entry["phraseId"], entry["speaker"])
        pitch_entries.extend(features)
        acoustic_by_speaker[entry["speaker"]].append(acoustic_vector(samples, sample_rate, track, len(phrase["hanzi"])))
        for feature in features:
            tone_excursions[entry["speaker"]][feature["surfaceToneClass"]].append(feature["maximumSemitone"] - feature["minimumSemitone"])
    acoustic_speakers = []
    candidate_map = {name: (sid, gender) for sid, name, gender in load_json(ROOT / "config/speakers.json")["candidates"]}
    for speaker, values in acoustic_by_speaker.items():
        acoustic_speakers.append({
            "speaker": speaker, "sid": candidate_map[speaker][0], "genderGroup": candidate_map[speaker][1],
            "medianLogF0": median(item["medianLogF0"] for item in values),
            "pitchPercentiles": [median(item["pitchPercentiles"][index] for item in values) for index in range(3)],
            "spectralVector": [median(item["spectralVector"][index] for item in values) for index in range(len(values[0]["spectralVector"]))],
            "speakingRate": median(item["speakingRate"] for item in values), "pauseRatio": median(item["pauseRatio"] for item in values),
            "toneExcursionProfile": [median(amounts) for _, amounts in sorted(tone_excursions[speaker].items())],
        })
    write_json(artifacts / "asr.json", {"version": "paraformer-screen-v1", "humanReviewed": False, "entries": asr_entries})
    write_json(artifacts / "embeddings.json", {"version": "campplus-screen-v1", "humanReviewed": False, "entries": embedding_entries})
    write_json(artifacts / "pitch-features.json", {"version": "aligned-pitch-v1", "humanReviewed": False, "syllables": pitch_entries})
    write_json(artifacts / "acoustic-features.json", {"version": "acoustic-profile-v1", "humanReviewed": False, "speakers": acoustic_speakers})
    print(f"Measured {len(entries)} clips for {len(acoustic_speakers)} candidate speakers")


if __name__ == "__main__":
    main()
