import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

test("character error calculation records insertions and deletions", () => {
  const result = spawnSync("python3", ["-c", "import sys;sys.path.insert(0,'scripts');from pipeline_common import character_error;print(character_error('你好世界','你好世'))"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /'delete': 1/);
});

test("constrained selection is exact, deterministic, and gender-balanced", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "mandarin-selection-"));
  const speakers = [];
  for (const [gender, prefix, sidStart] of [["female", "zf", 3], ["male", "zm", 58]]) {
    for (let index = 0; index < 6; index += 1) speakers.push({
      speaker: `${prefix}_${String(index + 1).padStart(3, "0")}`, sid: sidStart + index, genderGroup: gender, passed: true,
      embedding: [Math.cos(index * .9 + (gender === "male" ? .2 : 0)), Math.sin(index * .9 + (gender === "male" ? .2 : 0)), .2],
      medianLogF0: index + (gender === "male" ? 10 : 20), speakingRate: [1, 3, 2, 5, 4, 6][index],
      spectralVector: [index * .2, (5 - index) * .13]
    });
  }
  const features = path.join(temporary, "features.json");
  await writeFile(features, JSON.stringify({ version: "fixture-v1", speakers }));
  const run = (directory) => spawnSync("python3", ["scripts/select_speakers.py", "--features", features, "--output-dir", directory], { encoding: "utf8" });
  const firstDirectory = path.join(temporary, "one"), secondDirectory = path.join(temporary, "two");
  const first = run(firstDirectory), second = run(secondDirectory);
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  const left = JSON.parse(await readFile(path.join(firstDirectory, "selected-speakers.json"), "utf8"));
  const right = JSON.parse(await readFile(path.join(secondDirectory, "selected-speakers.json"), "utf8"));
  assert.deepEqual(left.selected, right.selected);
  assert.equal(await readFile(path.join(firstDirectory, "acoustic-map.svg"), "utf8"), await readFile(path.join(secondDirectory, "acoustic-map.svg"), "utf8"));
  assert.equal(left.selected.filter((speaker) => speaker.genderGroup === "female").length, 3);
  assert.equal(left.selected.filter((speaker) => speaker.genderGroup === "male").length, 3);
});
