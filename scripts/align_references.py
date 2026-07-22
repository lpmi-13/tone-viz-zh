#!/usr/bin/env python3
"""Prepare and run pinned Montreal Forced Aligner jobs, then map intervals."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from pipeline_common import load_json, write_json

ROOT = Path(__file__).resolve().parents[1]


def parse_intervals(text: str, tier_name: str) -> list[dict[str, Any]]:
    tier_match = re.search(rf'name\s*=\s*"{re.escape(tier_name)}"(.*?)(?=\n\s*item \[|\Z)', text, re.S)
    if not tier_match:
        return []
    pattern = re.compile(r'intervals \[\d+\]:\s*xmin = ([\d.eE+-]+)\s*xmax = ([\d.eE+-]+)\s*text = "(.*?)"', re.S)
    return [{"startSec": float(start), "endSec": float(end), "text": label} for start, end, label in pattern.findall(tier_match.group(1)) if label.strip()]


def dictionary_vocabulary(dictionary_name: str) -> set[str]:
    roots = []
    if os.environ.get("MFA_ROOT_DIR"):
        roots.append(Path(os.environ["MFA_ROOT_DIR"]))
    roots.append(ROOT / ".mfa-data")
    dictionary_path = next(
        (root / "pretrained_models" / "dictionary" / f"{dictionary_name}.dict" for root in roots
         if (root / "pretrained_models" / "dictionary" / f"{dictionary_name}.dict").exists()),
        None,
    )
    if not dictionary_path:
        raise SystemExit(f"Could not inspect the installed MFA dictionary: {dictionary_name}")
    return {line.split(maxsplit=1)[0] for line in dictionary_path.read_text().splitlines() if line.strip()}


def alignment_units(phrase: dict[str, Any], vocabulary: set[str]) -> list[dict[str, Any]]:
    units = []
    for word in phrase["words"]:
        if all(syllable["hanzi"] in vocabulary for syllable in word["syllables"]):
            units.extend({"text": syllable["hanzi"], "syllables": [syllable]} for syllable in word["syllables"])
        elif word["hanzi"] in vocabulary:
            units.append({"text": word["hanzi"], "syllables": word["syllables"]})
        else:
            raise ValueError(f"{phrase['id']}: neither characters nor authored word are in the MFA dictionary: {word['hanzi']}")
    return units


def map_boundaries(
    phrase: dict[str, Any], textgrid: Path, exact_ratio: float, vocabulary: set[str]
) -> dict[str, Any]:
    text = textgrid.read_text(errors="replace")
    aligned_units = parse_intervals(text, "words") or parse_intervals(text, "word")
    phones = parse_intervals(text, "phones") or parse_intervals(text, "phone")
    units = alignment_units(phrase, vocabulary)
    if len(aligned_units) != len(units):
        raise ValueError(
            f"{phrase['id']}: expected {len(units)} aligned dictionary units, got {len(aligned_units)}"
        )
    syllable_spans = {}
    for unit, interval in zip(units, aligned_units):
        if interval["endSec"] <= interval["startSec"]:
            raise ValueError(f"{phrase['id']}: non-positive aligned interval")
        unit_syllables = unit["syllables"]
        contained = [
            phone for phone in phones
            if phone["startSec"] >= interval["startSec"] - .001
            and phone["endSec"] <= interval["endSec"] + .001
        ]
        for index, syllable in enumerate(unit_syllables):
            if len(unit_syllables) == 1:
                start, end, confidence = interval["startSec"], interval["endSec"], 1
            else:
                start_index = round(index * len(contained) / len(unit_syllables))
                end_index = round((index + 1) * len(contained) / len(unit_syllables))
                phone_group = contained[start_index:end_index]
                if phone_group:
                    start, end, confidence = phone_group[0]["startSec"], phone_group[-1]["endSec"], .8
                else:
                    fraction = (interval["endSec"] - interval["startSec"]) / len(unit_syllables)
                    start, end, confidence = interval["startSec"] + index * fraction, interval["startSec"] + (index + 1) * fraction, .55
            syllable_spans[syllable["id"]] = {
                "segmentId": syllable["id"], "startSec": start, "endSec": end,
                "timingConfidence": confidence,
            }

    words, syllables = [], []
    for word in phrase["words"]:
        word_syllables = [syllable_spans[syllable["id"]] for syllable in word["syllables"]]
        words.append({
            "segmentId": word["id"],
            "startSec": word_syllables[0]["startSec"],
            "endSec": word_syllables[-1]["endSec"],
            "timingConfidence": min(item["timingConfidence"] for item in word_syllables),
        })
        syllables.extend(word_syllables)
    scale = lambda values: [{**item, "startSec": item["startSec"] * exact_ratio, "endSec": item["endSec"] * exact_ratio} for item in values]
    return {"natural": {"words": words, "syllables": syllables}, "slowed": {"words": scale(words), "syllables": scale(syllables)},
            "slowedDurationRatio": exact_ratio, "humanReviewed": False}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--mfa", default="mfa")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    catalog = load_json(ROOT / "public/content/phrases.json")
    audio_manifest = load_json(ROOT / "public/audio/phrases/manifest.json")
    generation = load_json(ROOT / "config/generation.json")
    acoustic = generation["alignment"]["acousticModel"]
    dictionary = generation["alignment"]["dictionary"]
    vocabulary = dictionary_vocabulary(dictionary)
    workspace = ROOT / "alignment-work"
    corpus_dir, output_dir = workspace / "corpus", workspace / "output"
    if workspace.exists():
        shutil.rmtree(workspace)
    corpus_dir.mkdir(parents=True)
    for key, entry in audio_manifest["entries"].items():
        phrase = next(item for item in catalog["phrases"] if item["id"] == entry["phraseId"])
        speaker_dir = corpus_dir / entry["speakerId"]
        speaker_dir.mkdir(exist_ok=True)
        source = ROOT / "audio-staging" / entry["speakerId"] / f"{entry['phraseId']}-natural.wav"
        if not source.exists():
            raise SystemExit(f"Natural staging WAV missing before alignment: {source}")
        shutil.copy2(source, speaker_dir / f"{entry['phraseId']}.wav")
        units = alignment_units(phrase, vocabulary)
        (speaker_dir / f"{entry['phraseId']}.lab").write_text(" ".join(unit["text"] for unit in units) + "\n")
    if args.prepare_only:
        print(f"Prepared MFA corpus at {corpus_dir}")
        return
    resolved_mfa = shutil.which(args.mfa)
    if not resolved_mfa:
        raise SystemExit("Montreal Forced Aligner executable not found; use --prepare-only or install the pinned MFA environment")
    mfa_environment = os.environ.copy()
    mfa_environment["PATH"] = f"{Path(resolved_mfa).resolve().parent}{os.pathsep}{mfa_environment.get('PATH', '')}"
    subprocess.run([resolved_mfa, "validate", str(corpus_dir), dictionary, "--acoustic_model", acoustic, "--clean", "--num_jobs", str(min(4, args.jobs))], check=True, env=mfa_environment)
    subprocess.run([resolved_mfa, "align", str(corpus_dir), dictionary, acoustic, str(output_dir), "--clean", "--num_jobs", str(min(4, args.jobs))], check=True, env=mfa_environment)
    boundary_dir = ROOT / "artifacts/reference-boundaries"
    for key, entry in audio_manifest["entries"].items():
        phrase = next(item for item in catalog["phrases"] if item["id"] == entry["phraseId"])
        textgrid = output_dir / entry["speakerId"] / f"{entry['phraseId']}.TextGrid"
        boundaries = map_boundaries(phrase, textgrid, entry["slowed"]["exactDurationRatio"], vocabulary)
        write_json(boundary_dir / entry["speakerId"] / f"{entry['phraseId']}.json", boundaries)
    print(f"Aligned {len(audio_manifest['entries'])} natural recordings")


if __name__ == "__main__":
    main()
