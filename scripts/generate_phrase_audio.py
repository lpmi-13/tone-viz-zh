#!/usr/bin/env python3
"""Generate six-speaker natural audio plus pitch-preserving slowed variants."""

from __future__ import annotations

import argparse
import os
import resource
import shutil
import subprocess
import time
from pathlib import Path

from generate_speaker_screen import load_tts
from pipeline_common import load_json, sha256_file, wav_metrics, write_json

ROOT = Path(__file__).resolve().parents[1]


def run_ffmpeg(arguments: list[str]) -> None:
    executable = shutil.which("ffmpeg")
    if not executable:
        raise SystemExit("FFmpeg is required for slowed and compressed audio")
    subprocess.run([executable, "-hide_banner", "-loglevel", "error", "-y", *arguments], check=True)


def valid_manifest_entry(entry: dict | None, natural_mp3: Path, slowed_mp3: Path, phrase: dict, speaker: dict, model_revision: str) -> bool:
    return bool(entry and natural_mp3.exists() and slowed_mp3.exists()
                and entry.get("input") == phrase["hanzi"] and entry.get("kokoroSid") == speaker["kokoroSid"]
                and entry.get("modelRevision") == model_revision
                and sha256_file(natural_mp3) == entry.get("natural", {}).get("checksum")
                and sha256_file(slowed_mp3) == entry.get("slowed", {}).get("checksum"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--selection", type=Path, default=ROOT / "artifacts/speaker-selection/selected-speakers.json")
    parser.add_argument("--limit-speakers", type=int)
    parser.add_argument("--limit-phrases", type=int)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    generation = load_json(ROOT / "config/generation.json")
    quality = load_json(ROOT / "config/tone-thresholds.json")["technical"]
    selection_path = args.selection if args.selection.exists() else ROOT / "config/speaker-selection.json"
    selection = load_json(selection_path)
    if selection.get("fixture"):
        raise SystemExit("Refusing release audio generation from the placeholder selection. Run speakers:select first.")
    speakers = selection["selected"][:args.limit_speakers] if args.limit_speakers else selection["selected"]
    catalog = load_json(ROOT / "public/content/phrases.json")
    phrases = catalog["phrases"][:args.limit_phrases] if args.limit_phrases else catalog["phrases"]
    model_dir = args.model_dir or ROOT / generation["model"]["modelDirectory"]
    tts = load_tts(model_dir, max(1, min(4, args.threads)))
    try:
        import soundfile as sf  # type: ignore
    except ImportError as error:
        raise SystemExit("soundfile is required for generation") from error
    staging = ROOT / "audio-staging"
    public = ROOT / "public/audio/phrases"
    manifest_path = public / "manifest.json"
    manifest = load_json(manifest_path) if manifest_path.exists() else {
        "version": "phrase-audio-v1", "modelRevision": generation["model"]["revision"],
        "selectionVersion": selection["version"], "humanReviewed": False, "entries": {},
    }
    slowed_factor = generation["audio"]["slowedFactor"]
    for speaker in speakers:
        for phrase in phrases:
            key = f"{speaker['id']}/{phrase['id']}"
            stage_dir = staging / speaker["id"]
            public_dir = public / speaker["id"]
            stage_dir.mkdir(parents=True, exist_ok=True)
            public_dir.mkdir(parents=True, exist_ok=True)
            natural_wav = stage_dir / f"{phrase['id']}-natural.wav"
            slowed_wav = stage_dir / f"{phrase['id']}-slowed.wav"
            natural_mp3 = public_dir / f"{phrase['id']}-natural.mp3"
            slowed_mp3 = public_dir / f"{phrase['id']}-slowed.mp3"
            if valid_manifest_entry(manifest["entries"].get(key), natural_mp3, slowed_mp3, phrase, speaker, generation["model"]["revision"]):
                phrase["recordings"][speaker["id"]]["natural"]["status"] = "generated"
                phrase["recordings"][speaker["id"]]["slowed"]["status"] = "generated"
                continue
            started = time.monotonic()
            audio = tts.generate(text=phrase["hanzi"], sid=speaker["kokoroSid"], speed=generation["model"]["speed"])
            sf.write(natural_wav, audio.samples, audio.sample_rate, subtype="PCM_16")
            natural_metrics = wav_metrics(natural_wav)
            if (natural_metrics["sampleRate"] != generation["model"]["sampleRate"]
                    or natural_metrics["clippedFraction"] > quality["maxClippedFraction"]
                    or natural_metrics["rms"] < quality["minimumRms"]
                    or natural_metrics["internalSilenceRatio"] > quality["maximumSilenceRatio"]
                    or natural_metrics["durationSec"] < phrase["syllableCount"] * .12):
                raise RuntimeError(f"Immediate audio validation failed: {key}")
            run_ffmpeg(["-i", str(natural_wav), "-filter:a", f"atempo={slowed_factor}", str(slowed_wav)])
            slowed_metrics = wav_metrics(slowed_wav)
            run_ffmpeg(["-i", str(natural_wav), "-codec:a", "libmp3lame", "-b:a", generation["audio"]["naturalBitrate"], str(natural_mp3)])
            run_ffmpeg(["-i", str(slowed_wav), "-codec:a", "libmp3lame", "-b:a", generation["audio"]["naturalBitrate"], str(slowed_mp3)])
            manifest["entries"][key] = {
                "speakerId": speaker["id"], "kokoroName": speaker["kokoroName"], "kokoroSid": speaker["kokoroSid"],
                "phraseId": phrase["id"], "input": phrase["hanzi"], "modelRevision": generation["model"]["revision"],
                "generationSec": time.monotonic() - started,
                "natural": {**natural_metrics, "path": str(natural_mp3.relative_to(ROOT)), "checksum": sha256_file(natural_mp3)},
                "slowed": {**slowed_metrics, "path": str(slowed_mp3.relative_to(ROOT)), "checksum": sha256_file(slowed_mp3),
                            "sourceVariant": "natural", "requestedFactor": slowed_factor,
                            "exactDurationRatio": slowed_metrics["durationSec"] / natural_metrics["durationSec"]},
            }
            write_json(manifest_path, manifest)
            phrase["recordings"][speaker["id"]]["natural"]["status"] = "generated"
            phrase["recordings"][speaker["id"]]["slowed"]["status"] = "generated"
            write_json(ROOT / "public/content/phrases.json", catalog)
            temporary_bytes = sum(path.stat().st_size for path in staging.rglob("*") if path.is_file())
            if temporary_bytes > generation["audio"]["maxTemporaryBytes"]:
                raise RuntimeError("Temporary audio exceeded the configured 5 GiB limit")
    write_json(ROOT / "public/content/phrases.json", catalog)
    relevant = [entry for entry in manifest["entries"].values() if entry["speakerId"] in {item["id"] for item in speakers} and entry["phraseId"] in {item["id"] for item in phrases}]
    mean_rtf = sum(entry["generationSec"] / entry["natural"]["durationSec"] for entry in relevant) / max(1, len(relevant))
    peak_rss_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1024 if os.name != "darwin" else 1)
    manifest["resources"] = {"meanRealTimeFactor": mean_rtf, "peakResidentBytes": peak_rss_bytes, "threadLimit": max(1, min(4, args.threads))}
    write_json(manifest_path, manifest)
    if mean_rtf > 2:
        raise RuntimeError(f"Mean real-time factor {mean_rtf:.2f} exceeded 2.0")
    if peak_rss_bytes > 6 * 1024 ** 3:
        raise RuntimeError("Peak resident memory exceeded 6 GiB")
    for speaker in speakers:
        checksums = [entry["natural"]["checksum"] for entry in relevant if entry["speakerId"] == speaker["id"]]
        if len(checksums) != len(set(checksums)):
            raise RuntimeError(f"Repeated phrase output detected for {speaker['id']}")
    print(f"Audio manifest contains {len(manifest['entries'])} speaker/phrase pairs")


if __name__ == "__main__":
    main()
