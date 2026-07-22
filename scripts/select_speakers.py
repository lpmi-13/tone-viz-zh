#!/usr/bin/env python3
"""Deterministically select three passing voices per model gender category."""

from __future__ import annotations

import argparse
import hashlib
import html
import itertools
import math
from pathlib import Path
from typing import Any

from pipeline_common import cosine, load_json, write_json

ROOT = Path(__file__).resolve().parents[1]


def euclidean(left: list[float], right: list[float]) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right)))


def spread(values: list[float], cohort: list[float]) -> float:
    denominator = max(cohort) - min(cohort) if cohort else 0
    return (max(values) - min(values)) / denominator if denominator else 0


def thirds(speakers: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    ordered = sorted(speakers, key=lambda item: (item["medianLogF0"], item["speaker"]))
    return [ordered[index * len(ordered) // 3:(index + 1) * len(ordered) // 3] for index in range(3)]


def rank_gender(speakers: list[dict[str, Any]], thresholds: dict[str, Any]) -> list[dict[str, Any]]:
    buckets = thirds(speakers)
    if any(not bucket for bucket in buckets):
        return []
    rates = [item["speakingRate"] for item in speakers]
    pitches = [item["medianLogF0"] for item in speakers]
    rankings = []
    seen = set()
    for raw in itertools.product(*buckets):
        trio = tuple(sorted(raw, key=lambda item: item["speaker"]))
        names = tuple(item["speaker"] for item in trio)
        if names in seen or len(set(names)) != 3:
            continue
        seen.add(names)
        pair_distances = [1 - cosine(left["embedding"], right["embedding"]) for left, right in itertools.combinations(trio, 2)]
        if not pair_distances or min(pair_distances) < thresholds["minimumPairwiseEmbeddingDistance"]:
            continue
        pitch_score = spread([item["medianLogF0"] for item in trio], pitches)
        rate_score = spread([item["speakingRate"] for item in trio], rates)
        spectral = [euclidean(left["spectralVector"], right["spectralVector"]) for left, right in itertools.combinations(trio, 2)]
        spectral_score = sum(spectral) / max(1, len(spectral))
        score = (thresholds["embeddingWeight"] * min(pair_distances)
                 + thresholds["pitchCoverageWeight"] * pitch_score
                 + thresholds["voiceQualityWeight"] * spectral_score
                 + thresholds["speakingRateWeight"] * rate_score)
        rankings.append({"speakers": list(names), "score": score, "minimumEmbeddingDistance": min(pair_distances),
                         "pitchCoverage": pitch_score, "spectralDiversity": spectral_score, "speakingRateDiversity": rate_score})
    return sorted(rankings, key=lambda item: (-item["score"], item["speakers"]))


def acoustic_description(item: dict[str, Any], cohort: list[dict[str, Any]]) -> str:
    ordered_pitch = sorted(record["medianLogF0"] for record in cohort)
    ordered_rate = sorted(record["speakingRate"] for record in cohort)
    pitch_rank = ordered_pitch.index(item["medianLogF0"]) / max(1, len(ordered_pitch) - 1)
    rate_rank = ordered_rate.index(item["speakingRate"]) / max(1, len(ordered_rate) - 1)
    register = "lower" if pitch_rank < .34 else "higher" if pitch_rank > .66 else "middle"
    pace = "slower" if rate_rank < .34 else "quicker" if rate_rank > .66 else "measured"
    return f"{register} measured register, {pace} measured pace; automatic acoustic profile"


def normalize_spectral(speakers: list[dict[str, Any]]) -> dict[str, list[float]]:
    width = max((len(item["spectralVector"]) for item in speakers), default=0)
    columns = [[item["spectralVector"][index] if index < len(item["spectralVector"]) else 0 for item in speakers] for index in range(width)]
    means = [sum(column) / len(column) for column in columns]
    scales = [math.sqrt(sum((value - means[index]) ** 2 for value in column) / max(1, len(column))) or 1 for index, column in enumerate(columns)]
    for item in speakers:
        item["spectralVector"] = [((item["spectralVector"][index] if index < len(item["spectralVector"]) else 0) - means[index]) / scales[index] / math.sqrt(max(1, width)) for index in range(width)]
    return {"mean": means, "scale": scales}


def acoustic_coordinates(speakers: list[dict[str, Any]]) -> dict[str, tuple[float, float]]:
    # Deterministic two-component PCA through the sample Gram matrix. This is
    # sufficient for the auditable map and avoids a platform-dependent solver.
    matrix = [item["embedding"] + [item["medianLogF0"], item["speakingRate"], *item["spectralVector"]] for item in speakers]
    if not matrix:
        return {}
    width = max(map(len, matrix))
    matrix = [row + [0] * (width - len(row)) for row in matrix]
    for column in range(width):
        values = [row[column] for row in matrix]
        mean = sum(values) / len(values)
        scale = math.sqrt(sum((value - mean) ** 2 for value in values) / max(1, len(values))) or 1
        for row in matrix:
            row[column] = (row[column] - mean) / scale
    gram = [[sum(a * b for a, b in zip(left, right)) for right in matrix] for left in matrix]
    vectors = []
    for component in range(2):
        vector = [1 + ((index + component) % 3) * .17 for index in range(len(matrix))]
        for _ in range(100):
            candidate = [sum(gram[row][column] * vector[column] for column in range(len(vector))) for row in range(len(vector))]
            for previous in vectors:
                projection = sum(a * b for a, b in zip(candidate, previous))
                candidate = [value - projection * previous[index] for index, value in enumerate(candidate)]
            norm = math.sqrt(sum(value * value for value in candidate)) or 1
            candidate = [value / norm for value in candidate]
            if sum(abs(a - b) for a, b in zip(candidate, vector)) < 1e-10:
                vector = candidate; break
            vector = candidate
        pivot = max(range(len(vector)), key=lambda index: abs(vector[index]))
        if vector[pivot] < 0:
            vector = [-value for value in vector]
        vectors.append(vector)
    return {item["speaker"]: (vectors[0][index], vectors[1][index] if len(vectors) > 1 else 0) for index, item in enumerate(speakers)}


def write_reports(directory: Path, speakers: list[dict[str, Any]], selected: list[dict[str, Any]], rankings: dict[str, Any]) -> None:
    coordinates = acoustic_coordinates(speakers)
    selected_names = {item["kokoroName"] for item in selected}
    xs = [value[0] for value in coordinates.values()] or [0]
    ys = [value[1] for value in coordinates.values()] or [0]
    scale = lambda value, values, start, size: start + ((value - min(values)) / (max(values) - min(values)) if max(values) != min(values) else .5) * size
    circles = []
    for item in sorted(speakers, key=lambda value: value["speaker"]):
        x_value, y_value = coordinates[item["speaker"]]
        x, y = scale(x_value, xs, 55, 690), scale(y_value, ys, 35, 430)
        chosen = item["speaker"] in selected_names
        circles.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{8 if chosen else 4}" fill="{"#d45d42" if chosen else "#688b7f"}"><title>{html.escape(item["speaker"])}</title></circle>')
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" role="img" aria-label="Deterministic PCA map of measured acoustic features"><rect width="800" height="500" fill="#f7f3e9"/><text x="30" y="25" font-family="sans-serif" fill="#172824">Automatic acoustic feature map · selected voices in coral</text>' + ''.join(circles) + '</svg>\n'
    (directory / "acoustic-map.svg").write_text(svg)
    rows = ''.join(f'<tr><td>{html.escape(item["displayName"])}</td><td>{html.escape(item["kokoroName"])}</td><td>{html.escape(item["genderGroup"])}</td><td>{html.escape(item["acousticDescription"])}</td></tr>' for item in selected)
    report = f'<!doctype html><meta charset="utf-8"><title>Automatic speaker selection</title><h1>Automatic speaker selection</h1><p>Human reviewed: no. Demographic age and region were not inferred.</p><img src="acoustic-map.svg" alt="Acoustic PCA map"><table><thead><tr><th>Slot</th><th>Model ID</th><th>Published category</th><th>Measured description</th></tr></thead><tbody>{rows}</tbody></table><pre>{html.escape(str({gender: values[:5] for gender, values in rankings.items()}))}</pre>\n'
    (directory / "report.html").write_text(report)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--features", type=Path, default=ROOT / "artifacts/speaker-selection/features.json")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts/speaker-selection")
    parser.add_argument("--model-revision", default=None)
    args = parser.parse_args()
    feature_manifest = load_json(args.features)
    generation = load_json(ROOT / "config/generation.json")
    thresholds_manifest = load_json(ROOT / "config/tone-thresholds.json")
    thresholds = thresholds_manifest["selection"]
    passing = [item for item in feature_manifest["speakers"] if item.get("passed")]
    normalization = normalize_spectral(passing)
    ranked = {gender: rank_gender([item for item in passing if item["genderGroup"] == gender], thresholds) for gender in ("female", "male")}
    if any(not ranked[gender] for gender in ranked):
        failure = {"version": "selection-v1", "status": "failed", "reason": "fewer-than-three-compatible-passing-speakers",
                   "passingCounts": {gender: sum(item["genderGroup"] == gender for item in passing) for gender in ranked},
                   "thresholdVersion": thresholds_manifest["version"], "humanReviewed": False}
        write_json(args.output_dir / "failure-report.json", failure)
        raise SystemExit("Selection failed closed; see failure-report.json")
    chosen_names = {gender: ranked[gender][0]["speakers"] for gender in ranked}
    chosen = [item for gender in ("female", "male") for name in chosen_names[gender] for item in passing if item["speaker"] == name]
    selected = []
    for gender in ("female", "male"):
        cohort = [item for item in passing if item["genderGroup"] == gender]
        for index, item in enumerate([record for name in chosen_names[gender] for record in cohort if record["speaker"] == name], 1):
            selected.append({
                "id": f"speaker-{'f' if gender == 'female' else 'm'}{index}", "displayName": f"Speaker {gender[0].upper()}{index}",
                "kokoroName": item["speaker"], "kokoroSid": item["sid"], "genderGroup": gender,
                "acousticDescription": acoustic_description(item, cohort),
            })
    alternates = {}
    alternate_availability = {}
    for gender in ("female", "male"):
        names = []
        for ranking in ranked[gender][1:]:
            # A compatible alternate occurs in a valid trio with two of the
            # selected speakers, so it can replace one slot without relaxing
            # the pitch-third or embedding-distance constraints.
            if len(set(ranking["speakers"]) & set(chosen_names[gender])) != 2:
                continue
            for name in ranking["speakers"]:
                if name not in chosen_names[gender] and name not in names:
                    names.append(name)
                if len(names) == thresholds["alternatesPerGender"]:
                    break
            if len(names) == thresholds["alternatesPerGender"]:
                break
        alternates[gender] = names
        alternate_availability[gender] = {
            "requested": thresholds["alternatesPerGender"],
            "available": len(names),
            "shortfall": thresholds["alternatesPerGender"] - len(names),
        }
    output = {
        "version": "selection-v2", "fixture": False, "selectionMode": "fully-automated-poc-v1", "humanReviewed": False,
        "modelRevision": args.model_revision or generation["model"]["revision"], "thresholdVersion": thresholds_manifest["version"],
        "featureVersion": feature_manifest["version"], "featureNormalization": {"spectral": normalization},
        "inputHashes": {"featuresSha256": hashlib.sha256(args.features.read_bytes()).hexdigest()},
        "selected": selected, "alternates": alternates, "alternateAvailability": alternate_availability,
    }
    write_json(args.output_dir / "selected-speakers.json", output)
    write_json(args.output_dir / "alternates.json", {"version": "selection-v2", "humanReviewed": False,
                                                       "availability": alternate_availability, **alternates})
    write_json(args.output_dir / "ranking.json", {"version": "selection-v2", "humanReviewed": False, "rankings": ranked})
    (args.output_dir / "failure-report.json").unlink(missing_ok=True)
    write_reports(args.output_dir, passing, selected, ranked)
    print("Selected " + ", ".join(item["kokoroName"] for item in selected))
    if any(item["shortfall"] for item in alternate_availability.values()):
        print("Alternate shortfall recorded: " + ", ".join(
            f"{gender} {item['available']}/{item['requested']}" for gender, item in alternate_availability.items()
        ))


if __name__ == "__main__":
    main()
