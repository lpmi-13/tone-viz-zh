#!/usr/bin/env python3
"""Generate a resumable all-candidate Kokoro diagnostic screen on CPU."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from pipeline_common import load_json, wav_metrics, write_json

ROOT = Path(__file__).resolve().parents[1]


def spectral_profile(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    frame_size = int(sample_rate * .04)
    hop_size = frame_size // 2
    spectra = []
    window = np.hanning(frame_size)
    for start in range(0, max(0, len(samples) - frame_size), hop_size):
        frame = samples[start:start + frame_size] * window
        if np.sqrt(np.mean(frame ** 2)) >= .006:
            spectra.append(np.log1p(np.abs(np.fft.rfft(frame))))
    return np.mean(spectra, axis=0) if spectra else np.zeros(frame_size // 2 + 1)


def load_tts(model_dir: Path, threads: int):
    try:
        import sherpa_onnx  # type: ignore
    except ImportError as error:
        raise SystemExit("Install requirements-pipeline.txt before speaker screening") from error
    model_path = model_dir / "model.onnx"
    if not model_path.exists():
        model_path = model_dir / "model.int8.onnx"
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=str(model_path), voices=str(model_dir / "voices.bin"),
                tokens=str(model_dir / "tokens.txt"), data_dir=str(model_dir / "espeak-ng-data"),
                lexicon=f"{model_dir / 'lexicon-us-en.txt'},{model_dir / 'lexicon-zh.txt'}",
            ), num_threads=threads, debug=False,
        )
    )
    if not config.validate():
        raise SystemExit(f"Invalid Kokoro model directory: {model_dir}")
    return sherpa_onnx.OfflineTts(config)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--limit-speakers", type=int)
    parser.add_argument("--limit-phrases", type=int)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--skip-rerun", action="store_true")
    args = parser.parse_args()
    generation = load_json(ROOT / "config/generation.json")
    model_dir = args.model_dir or ROOT / generation["model"]["modelDirectory"]
    candidates = load_json(ROOT / "config/speakers.json")["candidates"]
    diagnostics = load_json(ROOT / "artifacts/speaker-selection/diagnostic-corpus.json")["phrases"]
    if args.limit_speakers:
        candidates = candidates[:args.limit_speakers]
    if args.limit_phrases:
        diagnostics = diagnostics[:args.limit_phrases]
    output_dir = ROOT / "artifacts/speaker-selection/screening-audio"
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = ROOT / "artifacts/speaker-selection/screening-manifest.json"
    manifest = load_json(manifest_path) if manifest_path.exists() else {
        "version": "screen-v1", "modelRevision": generation["model"]["revision"], "humanReviewed": False, "entries": {}
    }
    tts = load_tts(model_dir, max(1, min(4, args.threads)))
    try:
        import soundfile as sf  # type: ignore
    except ImportError as error:
        raise SystemExit("soundfile is required to write screening WAVs") from error

    for sid, name, gender in candidates:
        for phrase in diagnostics:
            key = f"{name}/{phrase['id']}"
            output = output_dir / name / f"{phrase['id']}.wav"
            previous = manifest["entries"].get(key)
            if (previous and output.exists() and previous.get("input") == phrase["hanzi"]
                    and previous.get("sid") == sid and manifest.get("modelRevision") == generation["model"]["revision"]
                    and wav_metrics(output)["checksum"] == previous.get("checksum")):
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            started = time.monotonic()
            audio = tts.generate(text=phrase["hanzi"], sid=sid, speed=1.0)
            sf.write(output, audio.samples, audio.sample_rate, subtype="PCM_16")
            metrics = wav_metrics(output)
            manifest["entries"][key] = {
                "speaker": name, "sid": sid, "genderGroup": gender, "phraseId": phrase["id"],
                "input": phrase["hanzi"], "generationSec": time.monotonic() - started, **metrics,
            }
            write_json(manifest_path, manifest)
        if not args.skip_rerun and diagnostics:
            phrase = diagnostics[0]
            output = output_dir / name / f"{phrase['id']}-rerun.wav"
            audio = tts.generate(text=phrase["hanzi"], sid=sid, speed=1.0)
            sf.write(output, audio.samples, audio.sample_rate, subtype="PCM_16")
            rerun_metrics = wav_metrics(output)
            base_key = f"{name}/{phrase['id']}"
            base_samples, base_rate = sf.read(output_dir / name / f"{phrase['id']}.wav", dtype="float32", always_2d=True)
            rerun_samples, rerun_rate = sf.read(output, dtype="float32", always_2d=True)
            shared_length = min(len(base_samples), len(rerun_samples))
            left = base_samples[:shared_length, 0].astype(np.float64)
            right = rerun_samples[:shared_length, 0].astype(np.float64)
            denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
            waveform_cosine = float(np.dot(left, right) / denominator) if denominator else 0.0
            base_spectrum = spectral_profile(left, base_rate)
            rerun_spectrum = spectral_profile(right, rerun_rate)
            spectral_denominator = float(np.linalg.norm(base_spectrum) * np.linalg.norm(rerun_spectrum))
            spectral_cosine = float(np.dot(base_spectrum, rerun_spectrum) / spectral_denominator) if spectral_denominator else 0.0
            manifest["entries"][base_key]["deterministicRerun"] = {
                **rerun_metrics,
                "checksumMatch": rerun_metrics["checksum"] == manifest["entries"][base_key]["checksum"],
                "sampleRateMatch": base_rate == rerun_rate,
                "lengthRatio": shared_length / max(1, max(len(base_samples), len(rerun_samples))),
                "waveformCosine": waveform_cosine,
                "spectralCosine": spectral_cosine,
            }
            write_json(manifest_path, manifest)
    print(f"Screen manifest contains {len(manifest['entries'])} valid entries")


if __name__ == "__main__":
    main()
