#!/usr/bin/env python3
"""Write the frozen, balanced diagnostic set used for every candidate voice."""

from pathlib import Path

from pipeline_common import write_json

ROOT = Path(__file__).resolve().parents[1]
ITEMS = [
    ("d01", "今天天气真好", "statement", [1, 1, 1, 4, 1, 3]),
    ("d02", "明天你有时间吗", "question", [2, 1, 3, 3, 2, 1, 5]),
    ("d03", "我想买一本书", "yi-sandhi", [3, 3, 3, 1, 3, 1]),
    ("d04", "不要忘记带雨伞", "bu-sandhi", [4, 4, 4, 4, 4, 3, 3]),
    ("d05", "请把门打开", "third-sandhi", [3, 3, 2, 3, 1]),
    ("d06", "水果很甜", "tone-2-tone-3", [3, 3, 3, 2]),
    ("d07", "火车马上就到", "statement", [3, 1, 3, 4, 4, 4]),
    ("d08", "这个问题很难", "neutral", [4, 5, 4, 2, 3, 2]),
    ("d09", "妈妈回来了", "neutral-after-1", [1, 5, 2, 2, 5]),
    ("d10", "孩子睡着了", "neutral-after-2", [2, 5, 4, 2, 5]),
    ("d11", "你好吗", "neutral-after-3", [3, 3, 5]),
    ("d12", "这个菜不错", "neutral-after-4", [4, 5, 4, 2, 4]),
    ("d13", "高山白云", "tone-register", [1, 1, 2, 2]),
    ("d14", "老师讲得很快", "mixed", [3, 1, 3, 5, 3, 4]),
    ("d15", "地铁站在哪里", "question", [4, 3, 4, 4, 3, 3]),
    ("d16", "我每天练习中文", "long", [3, 3, 1, 4, 2, 1, 2]),
    ("d17", "请再说一遍", "yi-sandhi", [3, 4, 1, 1, 4]),
    ("d18", "声调不太容易", "bu-sandhi", [1, 4, 4, 4, 2, 4]),
    ("d19", "慢一点说", "yi-sandhi", [4, 1, 3, 1]),
    ("d20", "前面左转然后直走", "long", [2, 4, 3, 3, 2, 4, 2, 3]),
]


def main() -> None:
    corpus = {
        "version": "diagnostic-v1", "humanReviewed": False,
        "notice": "Automatically assembled diagnostic fixture; every candidate receives identical inputs.",
        "phrases": [{"id": item_id, "hanzi": hanzi, "category": category, "citationTones": tones,
                     "diagnosticTarget": hanzi[-2:]} for item_id, hanzi, category, tones in ITEMS],
    }
    path = ROOT / "artifacts/speaker-selection/diagnostic-corpus.json"
    write_json(path, corpus)
    print(f"Wrote {len(ITEMS)} diagnostic phrases to {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
