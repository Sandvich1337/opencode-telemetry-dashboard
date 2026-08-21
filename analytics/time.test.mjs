import assert from "node:assert/strict";
import test from "node:test";

import {
  BUCKET_WIDTHS_MS,
  DAY_MS,
  FORTY_FIVE_DAYS_MS,
  HOUR_MS,
  WEEK_MS,
  activeWallMs,
  bucketIntervals,
  bucketWidthMsForRange,
  clampInterval,
  normalizeInterval,
  normalizeRange,
  parallelism,
  perAgentUnion,
  positiveIntervalUnion,
  summedWorkMs,
  timingSummary,
} from "./time.mjs";

test("interval normalization and clamping reject malformed data", () => {
  assert.deepEqual(normalizeInterval({ start: 10, end: 20 }), { start: 10, end: 20, durationMs: 10 });
  assert.deepEqual(normalizeInterval({ start: 10, durationMs: 5 }), { start: 10, end: 15, durationMs: 5 });
  assert.equal(normalizeInterval({ start: 20, end: 10 }), null);
  assert.equal(normalizeInterval({ start: Infinity, end: 10 }), null);
  assert.deepEqual(clampInterval({ start: 0, end: 100 }, { from: 25, to: 75 }), { start: 25, end: 75, durationMs: 50 });
  assert.equal(clampInterval({ start: 0, end: 10 }, { from: 20, to: 30 }), null);
  assert.equal(clampInterval({ start: 0, end: 10 }, { from: 30, to: 20 }), null);
});

test("positive union merges overlap, nesting, adjacency, and ignores zero intervals", () => {
  const intervals = positiveIntervalUnion([
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 4, end: 8 },
    { start: 2, end: 15 },
    { start: 50, end: 50 },
    { start: 40, end: 30 },
    null,
  ]);
  assert.deepEqual(intervals, [
    { start: 0, end: 20, durationMs: 20 },
  ]);
  assert.equal(activeWallMs([{ start: 0, end: 10 }, { start: 5, end: 15 }]), 15);
  assert.equal(summedWorkMs([{ start: 0, end: 10 }, { start: 5, end: 15 }]), 20);
  assert.equal(parallelism([{ start: 0, end: 10 }, { start: 5, end: 15 }]), 20 / 15);
  assert.equal(parallelism([{ start: 0, end: 0 }]), null);
});

test("clamping is applied before work and wall calculations", () => {
  const range = { from: 20, to: 80 };
  assert.equal(summedWorkMs([{ start: 0, end: 50 }, { start: 60, end: 100 }], range), 50);
  assert.equal(activeWallMs([{ start: 0, end: 50 }, { start: 60, end: 100 }], range), 50);
  assert.deepEqual(timingSummary([{ start: 0, end: 100 }], range), {
    workMs: 60,
    activeWallMs: 60,
    parallelism: 1,
  });
});

test("per-agent unions are sorted and independent", () => {
  const result = perAgentUnion([
    { agent: "zeta", start: 0, end: 10 },
    { agent: "alpha", start: 0, end: 5 },
    { agent: "zeta", start: 8, end: 20 },
    { identity: { agent: "alpha" }, interval: { start: 10, end: 20 } },
    { start: 30, end: 35 },
  ]);
  assert.deepEqual(result, [
    { agent: "alpha", intervals: [{ start: 0, end: 5, durationMs: 5 }, { start: 10, end: 20, durationMs: 10 }], activeWallMs: 15 },
    { agent: "unknown", intervals: [{ start: 30, end: 35, durationMs: 5 }], activeWallMs: 5 },
    { agent: "zeta", intervals: [{ start: 0, end: 20, durationMs: 20 }], activeWallMs: 20 },
  ]);
});

test("bucket widths honor every inclusive threshold", () => {
  assert.equal(bucketWidthMsForRange(DAY_MS), BUCKET_WIDTHS_MS.day);
  assert.equal(bucketWidthMsForRange(DAY_MS + 1), BUCKET_WIDTHS_MS.week);
  assert.equal(bucketWidthMsForRange(WEEK_MS), BUCKET_WIDTHS_MS.week);
  assert.equal(bucketWidthMsForRange(WEEK_MS + 1), BUCKET_WIDTHS_MS.month);
  assert.equal(bucketWidthMsForRange(FORTY_FIVE_DAYS_MS), BUCKET_WIDTHS_MS.month);
  assert.equal(bucketWidthMsForRange(FORTY_FIVE_DAYS_MS + 1), BUCKET_WIDTHS_MS.long);
  assert.equal(bucketWidthMsForRange(null), BUCKET_WIDTHS_MS.long);
});

test("ranges are deterministic without a hidden clock and buckets are clipped", () => {
  assert.deepEqual(normalizeRange({ range: "24h" }), { key: "24h", from: null, to: null, now: null });
  assert.deepEqual(normalizeRange({ range: "24h", now: 100 * HOUR_MS }), {
    key: "24h", from: 100 * HOUR_MS - DAY_MS, to: 100 * HOUR_MS, now: 100 * HOUR_MS,
  });
  assert.deepEqual(bucketIntervals({ from: 0, to: HOUR_MS }, 15 * 60 * 1000).at(-1), {
    start: 45 * 60 * 1000,
    end: HOUR_MS,
    durationMs: 15 * 60 * 1000,
  });
});
