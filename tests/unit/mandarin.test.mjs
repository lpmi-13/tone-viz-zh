import test from "node:test";
import assert from "node:assert/strict";
import {
  inferSurfaceRealizations,
  normalizePinyin,
  parsePinyinTone,
  pinyinReadingsAgree,
  surfaceExplanation
} from "../../.build/assets/mandarin.js";

test("pinyin normalization compares numbered and marked readings", () => {
  assert.equal(normalizePinyin(" Nǚ-ér "), "nǚér");
  assert.deepEqual(parsePinyinTone("nǚ"), { base: "nü", tone: 3 });
  assert.deepEqual(parsePinyinTone("nv3"), { base: "nü", tone: 3 });
  assert.equal(pinyinReadingsAgree("lǜ", "lv4"), true);
  assert.equal(pinyinReadingsAgree("hǎo", "hao4"), false);
});

test("third-tone, 一, 不, and neutral rules use citation context", () => {
  const input = [
    { hanzi: "你", citationTone: 3 }, { hanzi: "好", citationTone: 3 },
    { hanzi: "一", citationTone: 1 }, { hanzi: "样", citationTone: 4 },
    { hanzi: "不", citationTone: 4 }, { hanzi: "是", citationTone: 4 },
    { hanzi: "吗", citationTone: 5 }
  ];
  const output = inferSurfaceRealizations(input);
  assert.equal(output[0].surfaceRealization, "third-tone-sandhi");
  assert.equal(output[1].surfaceRealization, "half-third");
  assert.equal(output[2].surfaceRealization, "yi-sandhi");
  assert.equal(output[2].surfaceToneClass, "tone-2-rising");
  assert.equal(output[4].surfaceRealization, "bu-sandhi");
  assert.equal(output[6].surfaceRealization, "neutral-after-4");
});

test("context explanations do not demand a full rise from a half-third", () => {
  const text = surfaceExplanation({ citationTone: 3, surfaceRealization: "half-third" });
  assert.match(text, /low half-third/);
  assert.doesNotMatch(text, /needs? a final rise/i);
});
