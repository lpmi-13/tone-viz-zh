#!/usr/bin/env python3
"""Combine technical, ASR, aligned-tone, identity, and acoustic measurements."""

from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path
from statistics import median
from typing import Any, Callable

import numpy as np
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from pipeline_common import character_error, cosine, load_json, percentile, write_json

ROOT = Path(__file__).resolve().parents[1]


def group_records(records: list[dict[str, Any]], field: str = "speaker") -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[record[field]].append(record)
    return grouped


def mean_vector(vectors: list[list[float]]) -> list[float]:
    if not vectors:
        return []
    return [sum(vector[index] for vector in vectors) / len(vectors) for index in range(len(vectors[0]))]


def tone_label(record: dict[str, Any]) -> str | None:
    surface = record["surfaceToneClass"]
    if surface in {"tone-3-low", "tone-3-final"}:
        return "tone-3"
    if surface in {"tone-1-level", "tone-2-rising", "tone-4-falling"}:
        return surface
    return None


def tone_contrast_label(record: dict[str, Any]) -> str | None:
    surface = record["surfaceToneClass"]
    if surface == "tone-2-rising":
        return "tone-2"
    if surface == "tone-3-low":
        return "tone-3-low"
    return None


def held_phrase_predictions(
    records: list[dict[str, Any]],
    labeler: Callable[[dict[str, Any]], str | None],
    labels: list[str],
    c_value: float,
    gamma: float,
) -> list[tuple[str, str]]:
    usable = [record for record in records if labeler(record) is not None]
    if not usable:
        return []
    vectors = np.asarray([tone_vector(record) for record in usable], dtype=float)
    expected = np.asarray([labeler(record) for record in usable])
    phrase_ids = np.asarray([record["phraseId"] for record in usable])
    predictions: list[tuple[str, str]] = []
    for held_phrase in sorted(set(phrase_ids)):
        training = phrase_ids != held_phrase
        if set(expected[training]) != set(labels):
            continue
        model = make_pipeline(
            StandardScaler(),
            SVC(C=c_value, gamma=gamma, class_weight="balanced", decision_function_shape="ovr"),
        )
        model.fit(vectors[training], expected[training])
        held_predictions = model.predict(vectors[~training])
        predictions.extend(zip(expected[~training].tolist(), held_predictions.tolist()))
    return predictions


def balanced_recall(predictions: list[tuple[str, str]], labels: list[str]) -> float:
    recalls = []
    for label in labels:
        matching = [(expected, predicted) for expected, predicted in predictions if expected == label]
        recalls.append(sum(expected == predicted for expected, predicted in matching) / max(1, len(matching)))
    return sum(recalls) / len(recalls)


def surface_tone_classifier_score(
    records: list[dict[str, Any]], classifier_config: dict[str, Any], category: str
) -> dict[str, Any]:
    c_value = float(classifier_config[category]["c"])
    gamma = float(classifier_config["gamma"])
    full_classes = ["tone-1-level", "tone-2-rising", "tone-3", "tone-4-falling"]
    contrast_classes = ["tone-2", "tone-3-low"]
    predictions = held_phrase_predictions(records, tone_label, full_classes, c_value, gamma)
    contrast_predictions = held_phrase_predictions(
        records, tone_contrast_label, contrast_classes, c_value, gamma
    )
    return {
        "algorithm": classifier_config["algorithm"],
        "featureVersion": classifier_config["featureVersion"],
        "c": c_value,
        "gamma": gamma,
        "balancedAccuracy": balanced_recall(predictions, full_classes),
        "tone2Tone3Accuracy": balanced_recall(contrast_predictions, contrast_classes),
        "classified": len(predictions),
        "contrastClassified": len(contrast_predictions),
    }


def tone_vector(record: dict[str, Any]) -> list[float]:
    start = float(record["startSemitone"])
    end = float(record["endSemitone"])
    minimum = float(record["minimumSemitone"])
    maximum = float(record["maximumSemitone"])
    return [
        start, end, minimum, maximum, float(record["medianSemitone"]),
        end - start, maximum - minimum,
        float(record.get("turningPoint") or 0.5), float(record["durationSec"]), float(record["voicedRatio"]),
    ]


def directional_tone_gates(records: list[dict[str, Any]], thresholds: dict[str, float], phrase_lengths: dict[str, int]) -> tuple[bool, list[str], dict[str, float]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[record["surfaceToneClass"]].append(record)
    reasons = []
    required = ["tone-1-level", "tone-2-rising", "tone-3-low", "tone-4-falling", "neutral"]
    for name in required:
        if len(grouped[name]) < thresholds["minimumEvidencePerClass"]:
            reasons.append(f"insufficient-{name}-evidence")
    movements = {name: median([record["endSemitone"] - record["startSemitone"] for record in values]) if values else 0 for name, values in grouped.items()}
    if abs(movements.get("tone-1-level", 99)) > thresholds["tone1MaximumAbsoluteMovementSemitone"]:
        reasons.append("tone-1-not-level")
    if movements.get("tone-2-rising", -99) < thresholds["tone2MinimumRiseSemitone"]:
        reasons.append("tone-2-rise-too-small")
    if movements.get("tone-4-falling", 99) > -thresholds["tone4MinimumFallSemitone"]:
        reasons.append("tone-4-fall-too-small")
    low_targets = [record["minimumSemitone"] for name in ("tone-3-low", "tone-3-final") for record in grouped[name]]
    if not low_targets or median(low_targets) > thresholds["tone3MinimumLowTargetSemitone"]:
        reasons.append("tone-3-low-target-missing")
    # Phrase-final lengthening can legitimately outweigh neutral-tone shortening,
    # so compare like-for-like non-final positions for this absolute gate.
    neutral_durations = [
        record["durationSec"] for record in grouped["neutral"]
        if record["syllableIndex"] < phrase_lengths[record["phraseId"]] - 1
    ]
    full_durations = [
        record["durationSec"] for name, values in grouped.items() if name != "neutral"
        for record in values if record["syllableIndex"] < phrase_lengths[record["phraseId"]] - 1
    ]
    if neutral_durations and full_durations and median(neutral_durations) / median(full_durations) > thresholds["neutralMaximumDurationRatio"]:
        reasons.append("neutral-duration-too-long")
    if grouped["sandhi-rising"] and movements.get("sandhi-rising", -99) < thresholds["tone2MinimumRiseSemitone"] * .6:
        reasons.append("third-tone-sandhi-rise-missing")
    return not reasons, reasons, movements


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", type=Path, default=ROOT / "artifacts/speaker-selection")
    args = parser.parse_args()
    artifacts = args.artifacts
    thresholds = load_json(ROOT / "config/tone-thresholds.json")
    candidates = load_json(ROOT / "config/speakers.json")["candidates"]
    manifest = load_json(artifacts / "screening-manifest.json")
    screen = group_records(list(manifest["entries"].values()))
    optional = lambda name, key: load_json(artifacts / name).get(key, []) if (artifacts / name).exists() else []
    asr = group_records(optional("asr.json", "entries"))
    tone = group_records(optional("pitch-features.json", "syllables"))
    embeddings = group_records(optional("embeddings.json", "entries"))
    acoustic_records = optional("acoustic-features.json", "speakers")
    acoustics = {record["speaker"]: record for record in acoustic_records}
    diagnostics = load_json(artifacts / "diagnostic-corpus.json")["phrases"]
    phrase_lengths = {item["id"]: len(item["hanzi"]) for item in diagnostics}
    expected_count = len(diagnostics)
    duration_cohorts = group_records(list(manifest["entries"].values()), "phraseId")
    duration_stats = {}
    for phrase_id, records in duration_cohorts.items():
        centre = median(item["durationSec"] for item in records)
        deviation = median(abs(item["durationSec"] - centre) for item in records) or max(.05, centre * .05)
        duration_stats[phrase_id] = (centre, deviation)
    features, decisions = [], []

    for sid, speaker, gender in candidates:
        clips = screen.get(speaker, [])
        reasons = []
        technical = thresholds["technical"]
        if len(clips) != expected_count:
            reasons.append("missing-screening-clips")
        if any(item["clippedFraction"] > technical["maxClippedFraction"] for item in clips):
            reasons.append("clipping")
        if any(item["rms"] < technical["minimumRms"] for item in clips):
            reasons.append("low-rms")
        if any(item["internalSilenceRatio"] > technical["maximumSilenceRatio"] for item in clips):
            reasons.append("excess-silence")
        if any(max(item["leadingSilenceSec"], item["trailingSilenceSec"]) > technical["maximumEdgeSilenceSec"] for item in clips):
            reasons.append("edge-silence")
        if any(abs(item["durationSec"] - duration_stats[item["phraseId"]][0]) / duration_stats[item["phraseId"]][1] > technical["durationCohortZScore"] for item in clips):
            reasons.append("duration-outlier")
        rerun = next((item.get("deterministicRerun") for item in clips if item.get("deterministicRerun")), None)
        if (not rerun or not rerun.get("sampleRateMatch")
                or rerun.get("lengthRatio", 0) < .99
                or rerun.get("spectralCosine", 0) < technical["deterministicRerunMinimumCosine"]):
            reasons.append("deterministic-rerun-mismatch")
        checksums = [item["checksum"] for item in clips]
        if len(checksums) != len(set(checksums)):
            reasons.append("repeated-output")

        asr_records = asr.get(speaker, [])
        errors = [character_error(item["reference"], item["hypothesis"]) for item in asr_records]
        aggregate_cer = sum(item["errors"] for item in errors) / max(1, sum(item["referenceLength"] for item in errors))
        if len(asr_records) != expected_count:
            reasons.append("missing-asr-evidence")
        if aggregate_cer > thresholds["intelligibility"]["maximumCharacterErrorRate"]:
            reasons.append("asr-character-error")
        if any(not item.get("diagnosticTargetsCorrect", False) for item in asr_records):
            reasons.append("asr-diagnostic-target")
        if any(item.get("alignmentConfidence", 0) < thresholds["intelligibility"]["minimumAlignmentConfidence"] for item in asr_records):
            reasons.append("alignment-confidence")

        tone_records = tone.get(speaker, [])
        classifier = surface_tone_classifier_score(tone_records, thresholds["classifier"], gender)
        directional_ok, directional_reasons, movements = directional_tone_gates(tone_records, thresholds["tone"], phrase_lengths)
        reasons.extend(directional_reasons)
        if classifier["balancedAccuracy"] < thresholds["tone"]["minimumBalancedAccuracy"]:
            reasons.append("tone-classification")
        if classifier["tone2Tone3Accuracy"] < thresholds["tone"]["minimumTone2Tone3Accuracy"]:
            reasons.append("tone-2-tone-3-separation")

        vectors = [item["vector"] for item in embeddings.get(speaker, [])]
        embedding = mean_vector(vectors)
        identity_consistency = median([cosine(vector, embedding) for vector in vectors]) if vectors else 0
        if len(vectors) != expected_count:
            reasons.append("missing-identity-evidence")
        if identity_consistency < thresholds["identity"]["minimumWithinSpeakerCosine"]:
            reasons.append("identity-instability")
        acoustic = acoustics.get(speaker, {})
        if not acoustic:
            reasons.append("missing-acoustic-profile")
        passed = not reasons and directional_ok
        decision = {
            "speaker": speaker, "sid": sid, "genderGroup": gender, "passed": passed,
            "reasons": sorted(set(reasons)), "characterErrorRate": aggregate_cer,
            "toneClassifier": classifier, "toneMovement": movements, "identityConsistency": identity_consistency,
        }
        decisions.append(decision)
        features.append({
            "speaker": speaker, "sid": sid, "genderGroup": gender, "passed": passed,
            "embedding": embedding, "medianLogF0": acoustic.get("medianLogF0", 0),
            "pitchPercentiles": acoustic.get("pitchPercentiles", []), "spectralVector": acoustic.get("spectralVector", []),
            "speakingRate": acoustic.get("speakingRate", 0), "pauseRatio": acoustic.get("pauseRatio", 0),
            "toneExcursionProfile": acoustic.get("toneExcursionProfile", []),
        })

    write_json(artifacts / "quality-gates.json", {"version": "quality-gates-v2", "thresholdVersion": thresholds["version"], "humanReviewed": False, "speakers": decisions})
    write_json(artifacts / "features.json", {"version": "speaker-features-v1", "humanReviewed": False, "speakers": features})
    passing = sum(item["passed"] for item in decisions)
    print(f"Scored {len(decisions)} candidates; {passing} passed every gate")


if __name__ == "__main__":
    main()
