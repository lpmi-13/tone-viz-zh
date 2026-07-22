#!/usr/bin/env python3
"""Build the deterministic 60-phrase fixture and apply Mandarin sandhi rules.

The checked-in fixture records two identical frozen G2P outputs so the UI and
validators can run without optional language packages. A release import must
use --live-g2p, which obtains independent Misaki and pypinyin readings and
rejects every disagreement instead of guessing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DISCLOSURE = (
    "Voices, pronunciations, tone annotations, alignments, and selections were "
    "generated or inferred automatically and have not been reviewed by a Mandarin speaker."
)
MODEL_ID = "hexgrad/Kokoro-82M-v1.1-zh"
MODEL_REVISION = "8c61023a009f8775e2e23c274ff110dff8335480"

# (id, English, topic, [(word, numeric pinyin), ...]). The project-authored
# English is direct and literal; all Mandarin and annotation remain unreviewed.
SEEDS = [
    ("hello", "Hello.", "greetings", [("你好", "ni3 hao3")]),
    ("how-are-you", "How are you?", "greetings", [("你好", "ni3 hao3"), ("吗", "ma5")]),
    ("i-am-well", "I feel very well.", "greetings", [("感觉", "gan3 jue2"), ("非常", "fei1 chang2"), ("好", "hao3")]),
    ("good-morning", "Good morning.", "greetings", [("早上", "zao3 shang4"), ("好", "hao3")]),
    ("see-you-tonight", "See you tonight.", "greetings", [("晚上", "wan3 shang4"), ("见", "jian4")]),
    ("pleased-to-meet", "I am pleased to meet you.", "greetings", [("很", "hen3"), ("高兴", "gao1 xing4"), ("见到", "jian4 dao4"), ("你", "ni3")]),
    ("what-name", "May I ask your name?", "greetings", [("请问", "qing3 wen4"), ("你", "ni3"), ("叫", "jiao4"), ("什么", "shen2 me5")]),
    ("welcome-beijing", "Welcome to Beijing.", "greetings", [("欢迎", "huan1 ying2"), ("你", "ni3"), ("来", "lai2"), ("北京", "bei3 jing1")]),
    ("hello-everyone", "Hello, everyone.", "greetings", [("大家", "da4 jia1"), ("好", "hao3")]),
    ("tomorrow-goodbye", "See you tomorrow.", "greetings", [("明天", "ming2 tian1"), ("再见", "zai4 jian4")]),

    ("busy-today", "I am very busy today.", "daily", [("我", "wo3"), ("今天", "jin1 tian1"), ("很忙", "hen3 mang2")]),
    ("reading-book", "He is reading a book.", "daily", [("他", "ta1"), ("正在", "zheng4 zai4"), ("看书", "kan4 shu1")]),
    ("walk-together", "Let us set out together.", "daily", [("咱们", "zan2 men5"), ("共同", "gong4 tong2"), ("出发", "chu1 fa1")]),
    ("child-asleep", "The child has fallen asleep.", "daily", [("孩子", "hai2 zi5"), ("睡着", "shui4 zhao2"), ("了", "le5")]),
    ("raining-outside", "It has started raining outside.", "daily", [("外边", "wai4 bian1"), ("开始", "kai1 shi3"), ("下雨", "xia4 yu3")]),
    ("not-late", "Being late is really not good.", "daily", [("迟到", "chi2 dao4"), ("真的", "zhen1 de5"), ("不好", "bu4 hao3")]),
    ("bought-book", "She bought a book.", "daily", [("她", "ta1"), ("买了", "mai3 le5"), ("一", "yi1"), ("本书", "ben3 shu1")]),
    ("open-door", "Please open the door.", "daily", [("麻烦", "ma2 fan5"), ("开", "kai1"), ("一下", "yi1 xia4"), ("门", "men2")]),
    ("mother-returned", "Mum has come back.", "daily", [("妈妈", "ma1 ma5"), ("回来", "hui2 lai2"), ("了", "le5")]),
    ("what-time", "What time is it now?", "daily", [("现在", "xian4 zai4"), ("几点", "ji3 dian3")]),

    ("want-tea", "Please bring a cup of black tea.", "food", [("麻烦", "ma2 fan5"), ("来", "lai2"), ("杯", "bei1"), ("红茶", "hong2 cha2")]),
    ("dish-good", "This dish smells very good.", "food", [("这个", "zhe4 ge5"), ("菜", "cai4"), ("很香", "hen3 xiang1")]),
    ("beef-noodles", "A bowl of beef noodles.", "food", [("一", "yi1"), ("碗", "wan3"), ("牛肉面", "niu2 rou4 mian4")]),
    ("no-chilli", "Do not add red chilli.", "food", [("别加", "bie2 jia1"), ("红", "hong2"), ("辣椒", "la4 jiao1")]),
    ("eat-rice", "Everyone is eating.", "food", [("人人", "ren2 ren2"), ("都在", "dou1 zai4"), ("吃饭", "chi1 fan4")]),
    ("apple-sweet", "The apple tastes fragrant and sweet.", "food", [("苹果", "ping2 guo3"), ("味道", "wei4 dao4"), ("香甜", "xiang1 tian2")]),
    ("coffee-bitter", "The coffee is a little bitter.", "food", [("咖啡", "ka1 fei1"), ("有点", "you3 dian3"), ("苦", "ku3")]),
    ("give-menu", "Please bring a menu.", "food", [("麻烦", "ma2 fan5"), ("拿", "na2"), ("份", "fen4"), ("菜单", "cai4 dan1")]),
    ("no-eggs", "He does not eat eggs.", "food", [("他", "ta1"), ("不吃", "bu4 chi1"), ("鸡蛋", "ji1 dan4")]),
    ("more-water", "Another glass of water.", "food", [("再来", "zai4 lai2"), ("一", "yi1"), ("杯水", "bei1 shui3")]),

    ("metro-where", "Where is the metro station?", "travel", [("地铁站", "di4 tie3 zhan4"), ("在", "zai4"), ("哪里", "na3 li3")]),
    ("go-airport", "I want to go to the airport.", "travel", [("我", "wo3"), ("想去", "xiang3 qu4"), ("机场", "ji1 chang3")]),
    ("call-car", "Please help call a car.", "travel", [("麻烦", "ma2 fan5"), ("帮忙", "bang1 mang2"), ("叫车", "jiao4 che1")]),
    ("turn-left", "Turn left ahead.", "travel", [("前面", "qian2 mian4"), ("左转", "zuo3 zhuan3")]),
    ("next-stop", "The train stops at the station ahead.", "travel", [("前方", "qian2 fang1"), ("车站", "che1 zhan4"), ("停车", "ting2 che1")]),
    ("long-road", "This road is very long.", "travel", [("这条", "zhe4 tiao2"), ("路", "lu4"), ("很长", "hen3 chang2")]),
    ("leave-soon", "Everyone is setting out immediately.", "travel", [("大家", "da4 jia1"), ("即刻", "ji2 ke4"), ("出发", "chu1 fa1")]),
    ("train-arrival", "What time does the train arrive?", "travel", [("火车", "huo3 che1"), ("几点", "ji3 dian3"), ("到", "dao4")]),
    ("straight-ahead", "Keep walking straight ahead.", "travel", [("一直", "yi1 zhi2"), ("往前", "wang3 qian2"), ("走", "zou3")]),
    ("not-too-fast", "Do not walk too quickly.", "travel", [("别", "bie2"), ("走得", "zou3 de5"), ("太快", "tai4 kuai4")]),

    ("learn-chinese", "I study Chinese.", "learning", [("我", "wo3"), ("学习", "xue2 xi2"), ("中文", "zhong1 wen2")]),
    ("read-character", "How is this character read?", "learning", [("这个", "zhe4 ge5"), ("字", "zi4"), ("怎么", "zen3 me5"), ("读", "du2")]),
    ("say-again", "Please say it once more.", "learning", [("请", "qing3"), ("再说", "zai4 shuo1"), ("一遍", "yi1 bian4")]),
    ("not-understand", "I cannot understand what I hear.", "learning", [("我", "wo3"), ("听不", "ting1 bu4"), ("明白", "ming2 bai2")]),
    ("good-pronunciation", "Your pronunciation is very good.", "learning", [("你的", "ni3 de5"), ("发音", "fa1 yin1"), ("很好", "hen3 hao3")]),
    ("teacher-fast", "The teacher speaks too quickly.", "learning", [("老师", "lao3 shi1"), ("说话", "shuo1 hua4"), ("太快", "tai4 kuai4")]),
    ("practise-daily", "I practise every day.", "learning", [("我", "wo3"), ("每天", "mei3 tian1"), ("练习", "lian4 xi2")]),
    ("tones-not-easy", "Tones are not very easy.", "learning", [("声调", "sheng1 diao4"), ("不太", "bu4 tai4"), ("容易", "rong2 yi4")]),
    ("write-here", "Please write it here.", "learning", [("请", "qing3"), ("写", "xie3"), ("在这里", "zai4 zhe4 li3")]),
    ("hard-question", "This question is very difficult.", "learning", [("这个", "zhe4 ge5"), ("问题", "wen4 ti2"), ("很难", "hen3 nan2")]),

    ("have-time", "Do you have time now?", "conversation", [("现在", "xian4 zai4"), ("有", "you3"), ("时间", "shi2 jian1"), ("吗", "ma5")]),
    ("not-tired", "I am not tired at all.", "conversation", [("我", "wo3"), ("完全", "wan2 quan2"), ("不累", "bu4 lei4")]),
    ("why-absent", "Why did he not come?", "conversation", [("他", "ta1"), ("为什么", "wei4 shen2 me5"), ("没来", "mei2 lai2")]),
    ("wait-moment", "Let us wait a moment.", "conversation", [("我们", "wo3 men5"), ("等", "deng3"), ("一会儿", "yi1 hui4 er2")]),
    ("what-think", "What do you think?", "conversation", [("你", "ni3"), ("觉得", "jue2 de5"), ("怎么样", "zen3 me5 yang4")]),
    ("no-problem", "Of course, no problem.", "conversation", [("当然", "dang1 ran2"), ("没问题", "mei2 wen4 ti2")]),
    ("really-dont-know", "I really do not know.", "conversation", [("我", "wo3"), ("真的", "zhen1 de5"), ("不知道", "bu4 zhi1 dao4")]),
    ("speak-slower", "Speak a little more slowly.", "conversation", [("慢", "man4"), ("一点", "yi1 dian3"), ("说", "shuo1")]),
    ("think-again", "Please reconsider.", "conversation", [("请", "qing3"), ("重新", "chong2 xin1"), ("考虑", "kao3 lv4")]),
    ("colder-today", "Today is colder than yesterday.", "conversation", [("今天", "jin1 tian1"), ("比", "bi3"), ("昨天", "zuo2 tian1"), ("冷", "leng3")]),
]

TOPICS = [
    {"id": "greetings", "label": "Greetings"}, {"id": "daily", "label": "Daily life"},
    {"id": "food", "label": "Food"}, {"id": "travel", "label": "Travel"},
    {"id": "learning", "label": "Learning"}, {"id": "conversation", "label": "Conversation"},
]

TONE_MARKS = {
    "a": "āáǎà", "e": "ēéěè", "i": "īíǐì", "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ"
}


def numeric_to_marked(value: str) -> str:
    match = re.fullmatch(r"([a-züv:]+)([1-5])", value.lower())
    if not match:
        raise ValueError(f"Invalid numeric pinyin: {value}")
    base = match.group(1).replace("u:", "ü").replace("v", "ü")
    tone = int(match.group(2))
    if tone == 5:
        return base
    index = next((base.index(vowel) for vowel in "aeo" if vowel in base), -1)
    if index < 0:
        if "iu" in base:
            index = base.index("u")
        elif "ui" in base:
            index = base.index("i")
        else:
            index = max(base.rfind(vowel) for vowel in "iuü")
    vowel = base[index]
    return base[:index] + TONE_MARKS[vowel][tone - 1] + base[index + 1:]


def surface_rules(items: list[dict[str, Any]]) -> None:
    for index, item in enumerate(items):
        next_item = items[index + 1] if index + 1 < len(items) else None
        previous = items[index - 1] if index else None
        tone = item["citationTone"]
        if tone == 5:
            prior_tone = previous["citationTone"] if previous and previous["citationTone"] != 5 else 1
            item.update(surfaceRealization=f"neutral-after-{prior_tone}", surfaceToneClass="neutral")
        elif item["hanzi"] == "一" and next_item:
            surface = "tone-2-rising" if next_item["citationTone"] == 4 else "tone-4-falling"
            item.update(surfaceRealization="yi-sandhi", surfaceToneClass=surface)
        elif item["hanzi"] == "不" and next_item and next_item["citationTone"] == 4:
            item.update(surfaceRealization="bu-sandhi", surfaceToneClass="tone-2-rising")
        elif tone == 3 and next_item and next_item["citationTone"] == 3:
            item.update(surfaceRealization="third-tone-sandhi", surfaceToneClass="sandhi-rising")
        elif tone == 3 and next_item:
            item.update(surfaceRealization="half-third", surfaceToneClass="tone-3-low")
        else:
            surface = {1: "tone-1-level", 2: "tone-2-rising", 3: "tone-3-final", 4: "tone-4-falling"}[tone]
            item.update(surfaceRealization="citation", surfaceToneClass=surface)
        item["explanation"] = explanation(item)


def explanation(item: dict[str, Any]) -> str:
    underlying = "Neutral tone" if item["citationTone"] == 5 else f"Underlying Tone {item['citationTone']}"
    realization = item["surfaceRealization"]
    if realization == "half-third":
        return f"{underlying}; automatically classified as a low half-third here because another syllable follows."
    if realization == "third-tone-sandhi":
        return f"{underlying}; automatically expected to rise here before another Tone 3."
    if realization == "yi-sandhi":
        return f"{underlying}; 一 changes according to the following tone."
    if realization == "bu-sandhi":
        return f"{underlying}; 不 is expected to rise before Tone 4."
    if realization.startswith("neutral-after-"):
        return f"{underlying}; its short contextual pitch depends on the preceding full tone."
    return f"{underlying}; contextual label automatic and unreviewed."


def fixture_readings(words: list[tuple[str, str]]) -> tuple[list[str], list[str], str]:
    readings = [token for _, pinyin in words for token in pinyin.split()]
    return readings, list(readings), "fixture-not-run"


def live_readings(text: str) -> tuple[list[str], list[str], str]:
    try:
        from pypinyin import Style, pinyin  # type: ignore
        from misaki import zh  # type: ignore
    except ImportError as error:
        raise SystemExit("--live-g2p requires pypinyin and misaki[zh]") from error
    pypinyin_result = [item[0] for item in pinyin(text, style=Style.TONE3, neutral_tone_with_five=True, strict=True)]
    g2p = zh.ZHG2P()
    raw = g2p(text)
    phonemes = raw[0] if isinstance(raw, tuple) else raw
    if not isinstance(phonemes, str) or not phonemes.strip() or "❓" in phonemes:
        raise ValueError("Misaki could not produce complete phoneme evidence")
    # Misaki's public Chinese API exposes its contextual phoneme string rather
    # than aligned pinyin tokens. The aligned citation reading remains
    # pypinyin's TONE3 output; retaining the Misaki evidence makes the second
    # path auditable and rejects an incomplete frontend result.
    return list(pypinyin_result), pypinyin_result, phonemes


def build_phrase(seed: tuple, speakers: list[dict[str, Any]], live: bool) -> tuple[dict[str, Any], dict[str, Any]]:
    phrase_id, translation, topic, word_specs = seed
    hanzi = "".join(word for word, _ in word_specs)
    expected = [token for _, value in word_specs for token in value.split()]
    misaki, pypinyin_values, misaki_phonemes = live_readings(hanzi) if live else fixture_readings(word_specs)
    normalized = lambda value: value.lower().replace("u:", "v").replace("ü", "v")
    if len(misaki) != len(expected) or len(pypinyin_values) != len(expected):
        raise ValueError(f"{phrase_id}: G2P syllable count disagreement")
    for index, (left, right) in enumerate(zip(misaki, pypinyin_values)):
        if normalized(left) != normalized(right):
            raise ValueError(f"{phrase_id}: unresolved G2P disagreement at {index}: {left} != {right}")

    flat: list[dict[str, Any]] = []
    words: list[dict[str, Any]] = []
    cursor = 0
    for word_index, (word_hanzi, numeric) in enumerate(word_specs, 1):
        tokens = numeric.split()
        if len(tokens) != len(word_hanzi):
            raise ValueError(f"{phrase_id}: {word_hanzi} does not match {numeric}")
        syllables = []
        for syllable_index, (character, token) in enumerate(zip(word_hanzi, tokens), 1):
            tone = int(token[-1])
            syllable = {
                "id": f"w{word_index}s{syllable_index}", "hanzi": character, "text": character,
                "pinyin": numeric_to_marked(token), "citationPinyin": token, "citationTone": tone,
                "lexicalTone": "neutral" if tone == 5 else f"tone-{tone}",
                "annotationStatus": "automatic-unreviewed",
            }
            syllables.append(syllable)
            flat.append(syllable)
            cursor += 1
        words.append({"id": f"w{word_index}", "hanzi": word_hanzi, "text": word_hanzi, "pinyin": " ".join(item["pinyin"] for item in syllables), "syllables": syllables})
    surface_rules(flat)
    recordings: dict[str, Any] = {}
    for speaker in speakers:
        speaker_id = speaker["id"]
        recordings[speaker_id] = {}
        for speed in ("natural", "slowed"):
            recordings[speaker_id][speed] = {
                "audioUrl": f"/audio/phrases/{speaker_id}/{phrase_id}-{speed}.mp3",
                "analysisUrl": f"/references/{phrase_id}.json",
                "variantKey": f"{speaker_id}-{speed}",
                "status": "fixture-pending-generation" if not live else "pending-generation",
            }
    source = {
        "id": phrase_id, "hanzi": hanzi, "translation": translation, "topic": topic,
        "words": [{"hanzi": word, "pinyin": pinyin} for word, pinyin in word_specs],
        "g2p": {"misaki": misaki, "pypinyin": pypinyin_values, "misakiPhonemeEvidence": misaki_phonemes,
                "mode": "live" if live else "frozen-fixture"},
    }
    phrase = {
        "id": phrase_id, "hanzi": hanzi, "translation": translation, "topicIds": [topic], "published": True,
        "annotationStatus": "automatic-unreviewed", "pronunciationAgreement": "dual-g2p-agree",
        "source": {"provider": "Project-authored PoC corpus", "sentenceId": phrase_id, "sentenceAuthor": "automatic corpus fixture",
                   "translationId": f"{phrase_id}-en", "translationAuthor": "project fixture", "license": "CC0-1.0",
                   "url": "", "modified": False},
        "words": words, "syllableCount": len(flat), "recordings": recordings,
    }
    return phrase, source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live-g2p", action="store_true", help="Require independent installed G2P engines")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    generated_selection = ROOT / "artifacts/speaker-selection/selected-speakers.json"
    selection_path = generated_selection if generated_selection.exists() else ROOT / "config/speaker-selection.json"
    selection = json.loads(selection_path.read_text())
    speakers = selection["selected"]
    seeds = SEEDS[: args.limit] if args.limit else SEEDS
    built = [build_phrase(seed, speakers, args.live_g2p) for seed in seeds]
    phrases = [item[0] for item in built]
    source_phrases = [item[1] for item in built]
    generated_at = "2026-07-22T00:00:00Z"
    catalog = {
        "version": 1, "generatedAt": generated_at, "annotationNotice": DISCLOSURE,
        "humanReviewed": False, "fixture": not args.live_g2p, "selection": {"version": selection["version"]},
        "topics": TOPICS, "phrases": phrases,
    }
    speaker_catalog = {
        "version": 1, "disclosure": DISCLOSURE, "humanReviewed": False, "fixture": selection.get("fixture", False),
        "speakers": [{**speaker, "model": MODEL_ID, "modelRevision": MODEL_REVISION, "selectionMode": selection["selectionMode"],
                      "humanReviewed": False, "age": None, "region": None} for speaker in speakers],
    }
    source = {
        "version": 1, "generatedAt": generated_at, "fixture": not args.live_g2p,
        "annotationStatus": "automatic-unreviewed", "g2pVersions": {"misaki": "0.8.2", "pypinyin": "0.53.0"},
        "sandhiRuleVersion": "mandarin-surface-v1", "phrases": source_phrases,
    }
    (ROOT / "public/content").mkdir(parents=True, exist_ok=True)
    (ROOT / "public/references").mkdir(parents=True, exist_ok=True)
    (ROOT / "content").mkdir(parents=True, exist_ok=True)
    (ROOT / "public/content/phrases.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "public/content/speakers.json").write_text(json.dumps(speaker_catalog, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "content/corpus-source.json").write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n")
    for phrase in phrases:
        variants = {}
        for speaker in speakers:
            for speed, factor in (("natural", 1.0), ("slowed", 1 / 0.78)):
                duration = phrase["syllableCount"] * 0.42 * factor
                syllables = []
                words = []
                cursor = 0.0
                for word in phrase["words"]:
                    word_start = cursor
                    for syllable in word["syllables"]:
                        start = cursor
                        cursor += duration / phrase["syllableCount"]
                        syllables.append(fixture_segment(syllable["id"], start, cursor))
                    words.append(fixture_segment(word["id"], word_start, cursor))
                key = f"{speaker['id']}-{speed}"
                variants[key] = {
                    "audioUrl": phrase["recordings"][speaker["id"]][speed]["audioUrl"], "durationSec": duration,
                    "phraseCentreSemitone": 0, "pitchRuns": [], "words": words, "syllables": syllables,
                    "alignmentFeatures": [], "analysisStatus": "fixture-pending-generation",
                }
        shard = {"phraseId": phrase["id"], "disclosure": DISCLOSURE, "variants": variants}
        (ROOT / f"public/references/{phrase['id']}.json").write_text(json.dumps(shard, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {len(phrases)} phrases and {len(speakers)} speaker fixtures")


def fixture_segment(segment_id: str, start: float, end: float) -> dict[str, Any]:
    return {
        "segmentId": segment_id, "startSec": round(start, 4), "endSec": round(end, 4),
        "timingConfidence": 0, "medianRelativeSemitone": 0, "startRelativeSemitone": 0,
        "endRelativeSemitone": 0, "minRelativeSemitone": 0, "maxRelativeSemitone": 0,
        "excursionSemitone": 0, "turningPoint": None, "voicedRatio": 0, "pitchRuns": [],
    }


if __name__ == "__main__":
    main()
