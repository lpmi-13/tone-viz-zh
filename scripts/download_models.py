#!/usr/bin/env python3
"""Download the three pinned CPU model assets and verify them before extraction."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import tarfile
import urllib.request
from pathlib import Path

from pipeline_common import load_json

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


def download(url: str, output: Path, expected: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and digest(output) == expected:
        return
    temporary = output.with_suffix(output.suffix + ".partial")
    with urllib.request.urlopen(url) as response, temporary.open("wb") as target:
        shutil.copyfileobj(response, target, 1024 * 1024)
    actual = digest(temporary)
    if actual != expected:
        temporary.unlink(missing_ok=True)
        raise SystemExit(f"Checksum mismatch for {url}: expected {expected}, got {actual}")
    temporary.replace(output)


def safe_extract(archive: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as source:
        root = target.resolve()
        for member in source.getmembers():
            if member.issym() or member.islnk():
                raise SystemExit(f"Archive links are not accepted: {member.name}")
            destination = (target / member.name).resolve()
            if root not in destination.parents and destination != root:
                raise SystemExit(f"Unsafe archive member: {member.name}")
        source.extractall(target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=ROOT / ".tmp/model-downloads")
    args = parser.parse_args()
    config = load_json(ROOT / "config/generation.json")
    tts_archive = args.cache / "kokoro-multi-lang-v1_1.tar.bz2"
    tts_int8_archive = args.cache / "kokoro-int8-multi-lang-v1_1.tar.bz2"
    asr_archive = args.cache / "sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2"
    download(config["model"]["sherpaOnnxArchive"], tts_archive, config["model"]["archiveSha256"])
    download(config["model"]["int8Archive"], tts_int8_archive, config["model"]["int8ArchiveSha256"])
    download(config["asr"]["archive"], asr_archive, config["asr"]["archiveSha256"])
    safe_extract(tts_archive, ROOT / "models")
    safe_extract(tts_int8_archive, ROOT / "models")
    safe_extract(asr_archive, ROOT / "models")
    embedding = ROOT / config["speakerEmbedding"]["path"]
    download(config["speakerEmbedding"]["url"], embedding, config["speakerEmbedding"]["sha256"])
    print("Downloaded and verified full/int8 Kokoro, Paraformer, and CAM++ assets")


if __name__ == "__main__":
    main()
