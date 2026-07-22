"""Dependency-light helpers shared by the offline content pipeline."""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import wave
from array import array
from pathlib import Path
from typing import Any, Iterable


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def wav_metrics(path: Path) -> dict[str, Any]:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        frame_count = source.getnframes()
        raw = source.readframes(frame_count)
    if channels != 1 or sample_width != 2 or sample_rate <= 0 or not raw:
        raise ValueError(f"Expected non-empty 16-bit mono WAV: {path}")
    samples = array("h")
    samples.frombytes(raw)
    if os.sys.byteorder != "little":
        samples.byteswap()
    scale = 32768.0
    peak = max(abs(value) for value in samples) / scale
    rms = math.sqrt(sum((value / scale) ** 2 for value in samples) / len(samples))
    clipped = sum(abs(value) >= 32760 for value in samples) / len(samples)
    window = max(1, int(sample_rate * 0.02))
    energies = []
    for start in range(0, len(samples), window):
        chunk = samples[start:start + window]
        if chunk:
            energies.append(math.sqrt(sum((value / scale) ** 2 for value in chunk) / len(chunk)))
    threshold = max(0.0025, rms * 0.12)
    voiced = [value >= threshold for value in energies]
    first = next((index for index, value in enumerate(voiced) if value), len(voiced))
    last = len(voiced) - 1 - next((index for index, value in enumerate(reversed(voiced)) if value), len(voiced))
    internal = voiced[first:last + 1] if first <= last else []
    return {
        "sampleRate": sample_rate,
        "channels": channels,
        "durationSec": frame_count / sample_rate,
        "peak": peak,
        "rms": rms,
        "clippedFraction": clipped,
        "leadingSilenceSec": first * 0.02,
        "trailingSilenceSec": max(0, (len(voiced) - 1 - last) * 0.02),
        "internalSilenceRatio": internal.count(False) / max(1, len(internal)),
        "checksum": sha256_file(path),
    }


def character_error(reference: str, hypothesis: str) -> dict[str, float | int]:
    left = [value for value in reference if not value.isspace()]
    right = [value for value in hypothesis if not value.isspace()]
    rows = len(left) + 1
    columns = len(right) + 1
    costs = [[0] * columns for _ in range(rows)]
    operations = [[""] * columns for _ in range(rows)]
    for row in range(1, rows):
        costs[row][0] = row
        operations[row][0] = "delete"
    for column in range(1, columns):
        costs[0][column] = column
        operations[0][column] = "insert"
    for row in range(1, rows):
        for column in range(1, columns):
            choices = [
                (costs[row - 1][column] + 1, "delete"),
                (costs[row][column - 1] + 1, "insert"),
                (costs[row - 1][column - 1] + (left[row - 1] != right[column - 1]), "equal" if left[row - 1] == right[column - 1] else "substitute"),
            ]
            costs[row][column], operations[row][column] = min(choices, key=lambda item: (item[0], item[1]))
    row, column = len(left), len(right)
    counts = {"delete": 0, "insert": 0, "substitute": 0}
    while row or column:
        operation = operations[row][column]
        if operation == "delete":
            counts[operation] += 1; row -= 1
        elif operation == "insert":
            counts[operation] += 1; column -= 1
        else:
            if operation == "substitute":
                counts[operation] += 1
            row -= 1; column -= 1
    errors = sum(counts.values())
    return {**counts, "errors": errors, "referenceLength": len(left), "cer": errors / max(1, len(left))}


def cosine(left: Iterable[float], right: Iterable[float]) -> float:
    left_values, right_values = list(left), list(right)
    dot = sum(a * b for a, b in zip(left_values, right_values))
    denominator = math.sqrt(sum(value * value for value in left_values) * sum(value * value for value in right_values))
    return dot / denominator if denominator else 0.0


def percentile(values: list[float], position: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    point = (len(ordered) - 1) * position
    low = int(math.floor(point))
    high = int(math.ceil(point))
    if low == high:
        return ordered[low]
    return ordered[low] * (high - point) + ordered[high] * (point - low)
