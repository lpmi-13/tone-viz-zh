import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("content satisfies every non-release invariant", () => {
  const result = spawnSync(process.execPath, ["scripts/validate_content.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /60 phrases/);
  assert.match(result.stdout, /720 (?:fixture|content) variants/);
});

test("generated content satisfies release invariants", () => {
  const result = spawnSync(process.execPath, ["scripts/validate_content.mjs", "--release"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /720 release variants/);
});

test("release validation fails closed on an explicit fixture selection", () => {
  const result = spawnSync(process.execPath, ["scripts/validate_content.mjs", "--release", "--selection=config/speaker-selection.json"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture content|do not match/);
});
