import test from "node:test";
import assert from "node:assert/strict";
import { smoothPitchRunForDisplay } from "../../.build/assets/phrase-chart.js";

test("display smoothing reduces a one-frame octave error without changing time", () => {
  const points = [0, .7, -.5, .8, -.4, 4.8, .2, -.6, .5, .1, .4, .6].map((semitone, index) => ({ timeSec: index * .01, semitone, confidence: .9 }));
  const smoothed = smoothPitchRunForDisplay({ points });
  assert.deepEqual(smoothed.map((point) => point.timeSec), points.map((point) => point.timeSec));
  assert.ok(Math.max(...smoothed.map((point) => point.semitone)) < 2.5);
});

test("short voiced runs remain separate data rather than invented bridges", () => {
  const points = [{ timeSec: .1, semitone: -1, confidence: .8 }, { timeSec: .13, semitone: 1, confidence: .8 }];
  assert.deepEqual(smoothPitchRunForDisplay({ points }), points);
});
