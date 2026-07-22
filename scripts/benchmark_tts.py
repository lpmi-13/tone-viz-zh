#!/usr/bin/env python3
"""Benchmark full/int8 Kokoro on identical diagnostics and compare pitch output."""

from __future__ import annotations

import argparse
import math
import tempfile
import time
from pathlib import Path
from statistics import median

import soundfile as sf

from generate_speaker_screen import load_tts
from measure_speaker_screen import pitch_track, read_audio
from pipeline_common import load_json, wav_metrics, write_json

ROOT = Path(__file__).resolve().parents[1]


def normalized_pitch_difference(left, right) -> float:
    if len(left) < 3 or len(right) < 3:
        return 999.0
    left_pitch = [69 + 12 * math.log2(item[1] / 440) for item in left]
    right_pitch = [69 + 12 * math.log2(item[1] / 440) for item in right]
    left_centre, right_centre = median(left_pitch), median(right_pitch)
    count = min(len(left_pitch), len(right_pitch), 100)
    differences = []
    for index in range(count):
        left_index = round(index * (len(left_pitch) - 1) / max(1, count - 1))
        right_index = round(index * (len(right_pitch) - 1) / max(1, count - 1))
        differences.append(abs((left_pitch[left_index] - left_centre) - (right_pitch[right_index] - right_centre)))
    return median(differences)


def generate_set(model, diagnostics, sid: int, directory: Path, label: str) -> dict:
    records = []
    for phrase in diagnostics:
        output = directory / f"{label}-{phrase['id']}.wav"
        started = time.monotonic()
        audio = model.generate(text=phrase["hanzi"], sid=sid, speed=1.0)
        elapsed = time.monotonic() - started
        sf.write(output, audio.samples, audio.sample_rate, subtype="PCM_16")
        metrics = wav_metrics(output)
        samples, sample_rate = read_audio(output)
        records.append({"phraseId": phrase["id"], "path": output, "elapsedSec": elapsed,
                        "realTimeFactor": elapsed / metrics["durationSec"], "metrics": metrics,
                        "pitch": pitch_track(samples, sample_rate)})
    return {"records": records, "meanRealTimeFactor": sum(item["realTimeFactor"] for item in records) / len(records)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--sid", type=int, default=3)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    config = load_json(ROOT / "config/generation.json")
    diagnostics = load_json(ROOT / "artifacts/speaker-selection/diagnostic-corpus.json")["phrases"][:args.limit]
    threshold = load_json(ROOT / "config/tone-thresholds.json")["analysis"]["slowedContourToleranceSemitone"]
    with tempfile.TemporaryDirectory(prefix="mandarin-tts-benchmark-") as temporary:
        directory = Path(temporary)
        full_model = load_tts(ROOT / config["model"]["modelDirectory"], min(4, args.threads))
        full = generate_set(full_model, diagnostics, args.sid, directory, "full")
        del full_model
        int8_model = load_tts(ROOT / config["model"]["int8ModelDirectory"], min(4, args.threads))
        int8 = generate_set(int8_model, diagnostics, args.sid, directory, "int8")
        comparisons = []
        for left, right in zip(full["records"], int8["records"]):
            difference = normalized_pitch_difference(left["pitch"], right["pitch"])
            comparisons.append({"phraseId": left["phraseId"], "medianRelativePitchDifferenceSemitone": difference,
                                "durationRatio": right["metrics"]["durationSec"] / left["metrics"]["durationSec"],
                                "rmsDifference": abs(right["metrics"]["rms"] - left["metrics"]["rms"])})
    equivalent = all(item["medianRelativePitchDifferenceSemitone"] <= threshold and .92 <= item["durationRatio"] <= 1.08 for item in comparisons)
    report = {"version": "tts-benchmark-v1", "humanReviewed": False, "speakerSid": args.sid,
              "fullMeanRealTimeFactor": full["meanRealTimeFactor"], "int8MeanRealTimeFactor": int8["meanRealTimeFactor"],
              "automatedAcousticEquivalence": equivalent, "comparisons": comparisons,
              "decision": "full-precision" if config["model"]["preferredPrecision"] == "full" or not equivalent else "int8"}
    write_json(ROOT / "artifacts/tts-benchmark.json", report)
    print(f"Benchmark decision: {report['decision']}; int8 acoustic equivalence: {equivalent}")


if __name__ == "__main__":
    main()
