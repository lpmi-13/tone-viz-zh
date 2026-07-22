import type { CitationTone, PhraseSyllable, SurfaceRealization, SurfaceToneClass, ToneId } from "./phrase-types.js";

const MARKED_VOWELS: Record<string, [string, CitationTone]> = {
  ā: ["a", 1], á: ["a", 2], ǎ: ["a", 3], à: ["a", 4], ē: ["e", 1], é: ["e", 2],
  ě: ["e", 3], è: ["e", 4], ī: ["i", 1], í: ["i", 2], ǐ: ["i", 3], ì: ["i", 4],
  ō: ["o", 1], ó: ["o", 2], ǒ: ["o", 3], ò: ["o", 4], ū: ["u", 1], ú: ["u", 2],
  ǔ: ["u", 3], ù: ["u", 4], ǖ: ["ü", 1], ǘ: ["ü", 2], ǚ: ["ü", 3], ǜ: ["ü", 4]
};
const TONE_NAMES: Record<CitationTone, string> = {
  1: "Tone 1 (high and level)", 2: "Tone 2 (rising)", 3: "Tone 3 (low)",
  4: "Tone 4 (falling)", 5: "Neutral tone"
};

export function normalizePinyin(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll("u:", "ü").replaceAll("v", "ü")
    .normalize("NFC").replace(/['’\s-]+/g, "");
}

export function parsePinyinTone(value: string): { base: string; tone: CitationTone } {
  const normalized = normalizePinyin(value);
  const numeric = normalized.match(/^(.+?)([1-5])$/);
  if (numeric) return { base: numeric[1], tone: Number(numeric[2]) as CitationTone };
  let tone: CitationTone = 5;
  let base = "";
  for (const character of normalized) {
    const marked = MARKED_VOWELS[character];
    if (marked) { base += marked[0]; tone = marked[1]; } else base += character;
  }
  return { base, tone };
}

export function pinyinReadingsAgree(first: string, second: string): boolean {
  const left = parsePinyinTone(first);
  const right = parsePinyinTone(second);
  return left.base === right.base && left.tone === right.tone;
}

export function toneId(tone: CitationTone): ToneId { return tone === 5 ? "neutral" : `tone-${tone}` as ToneId; }

export function inferSurfaceRealizations(
  syllables: Array<{ hanzi: string; citationTone: CitationTone }>
): Array<{ surfaceRealization: SurfaceRealization; surfaceToneClass: SurfaceToneClass }> {
  return syllables.map((syllable, index) => {
    const next = syllables[index + 1];
    const previous = syllables[index - 1];
    if (syllable.citationTone === 5) {
      const precedingTone = previous?.citationTone && previous.citationTone !== 5 ? previous.citationTone : 1;
      return { surfaceRealization: `neutral-after-${precedingTone}` as SurfaceRealization, surfaceToneClass: "neutral" };
    }
    if (syllable.hanzi === "一" && next) {
      return { surfaceRealization: "yi-sandhi", surfaceToneClass: next.citationTone === 4 ? "tone-2-rising" : "tone-4-falling" };
    }
    if (syllable.hanzi === "不" && next?.citationTone === 4) {
      return { surfaceRealization: "bu-sandhi", surfaceToneClass: "tone-2-rising" };
    }
    if (syllable.citationTone === 3 && next?.citationTone === 3) {
      return { surfaceRealization: "third-tone-sandhi", surfaceToneClass: "sandhi-rising" };
    }
    if (syllable.citationTone === 3 && next) {
      return { surfaceRealization: "half-third", surfaceToneClass: "tone-3-low" };
    }
    const surfaceToneClass: SurfaceToneClass = syllable.citationTone === 1 ? "tone-1-level"
      : syllable.citationTone === 2 ? "tone-2-rising" : syllable.citationTone === 3 ? "tone-3-final" : "tone-4-falling";
    return { surfaceRealization: "citation", surfaceToneClass };
  });
}

export function surfaceExplanation(syllable: Pick<PhraseSyllable, "citationTone" | "surfaceRealization">): string {
  const underlying = `Underlying ${TONE_NAMES[syllable.citationTone]}`;
  switch (syllable.surfaceRealization) {
    case "half-third": return `${underlying}; automatically classified as a low half-third here because another syllable follows.`;
    case "third-tone-sandhi": return `${underlying}; automatically expected to rise here before another Tone 3.`;
    case "yi-sandhi": return `${underlying}; 一 changes direction automatically according to the following tone.`;
    case "bu-sandhi": return `${underlying}; 不 is expected to rise before Tone 4.`;
    default:
      if (syllable.surfaceRealization.startsWith("neutral-after-")) return `${underlying}; its short contextual pitch depends on the preceding full tone.`;
      return `${underlying}; its contextual label is automatic and the measured recording remains the primary evidence.`;
  }
}

export function toneLabel(tone: CitationTone): string { return TONE_NAMES[tone]; }
export function canonicalGlyph(tone: CitationTone): number[] {
  return tone === 1 ? [4, 4, 4] : tone === 2 ? [2, 2.4, 4] : tone === 3 ? [2.5, 1, 1.7]
    : tone === 4 ? [4, 3, 1] : [2.5, 2.4, 2.3];
}
