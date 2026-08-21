import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYTICS,
  ANALYTICS_SCHEMA_VERSION,
  EMPTY_SAMPLE_EVIDENCE,
  TOKEN_BUCKETS,
  confidence,
  deepFreeze,
  fraction,
  makeAvailability,
  normalizeCost,
  normalizeIdentity,
  normalizeSampleEvidence,
  normalizeTokens,
  rateWithEvidence,
  safeRate,
  stableStringify,
  timestampMs,
} from "./contract.mjs";
import { sanitizePublic } from "./snapshot.mjs";

test("the analytics schema and constants are frozen", () => {
  assert.equal(ANALYTICS_SCHEMA_VERSION, 1);
  assert.equal(ANALYTICS.schemaVersion, 1);
  assert.deepEqual(TOKEN_BUCKETS, ["input", "output", "reasoning", "cacheRead", "cacheWrite"]);
  assert.ok(Object.isFrozen(ANALYTICS));
  assert.ok(Object.isFrozen(TOKEN_BUCKETS));
  assert.ok(Object.isFrozen(EMPTY_SAMPLE_EVIDENCE));
});

test("finite values fail closed and fractions clamp", () => {
  assert.equal(timestampMs("2026-08-19T00:00:00.000Z"), Date.parse("2026-08-19T00:00:00.000Z"));
  assert.equal(timestampMs(Infinity), null);
  assert.equal(timestampMs("not a timestamp"), null);
  assert.equal(fraction(-1), 0);
  assert.equal(fraction(2), 1);
  assert.equal(fraction("bad"), null);
  assert.equal(safeRate(4, 2), 2);
  assert.equal(safeRate(4, 0), null);
  assert.equal(safeRate(Infinity, 2), null);
});

test("token normalization conserves existing token semantics", () => {
  assert.deepEqual(normalizeTokens({
    usage: { input: -4, output: "5", reasoning: 2, cache: { read: 3, write: 0 }, total: 99 },
  }), {
    input: 0,
    output: 5,
    reasoning: 2,
    cacheRead: 3,
    cacheWrite: 0,
    cacheWriteReported: true,
    total: 99,
  });
  assert.equal(normalizeTokens({ input: 1, output: 2 }).total, 3);
  assert.equal(normalizeTokens({ input: 1, cacheWrite: "bad" }).cacheWriteReported, true);
  assert.equal(normalizeTokens({ input: 1 }).cacheWriteReported, false);
});

test("identity and cost normalization are pure copies", () => {
  const input = { agent: " build ", model: { providerID: "provider", modelID: "model" }, cost: "0.25" };
  const before = JSON.stringify(input);
  assert.deepEqual(normalizeIdentity(input), { agent: "build", model: "provider/model" });
  assert.deepEqual(normalizeCost(input), { usd: 0.25, currency: "usd", basis: "reported", reported: true });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(normalizeIdentity({ model: JSON.stringify({ providerID: "provider", modelID: "nested-model" }) }), {
    agent: "unknown",
    model: "provider/nested-model",
  });
});

test("sanitization retains safe topology edge aliases", () => {
  assert.deepEqual(sanitizePublic({ edges: [{ source: "run-001", target: "tool-001", weight: { calls: 1 } }] }), {
    edges: [{ source: "run-001", target: "tool-001", weight: { calls: 1 } }],
  });
});

test("availability, confidence, and rate evidence always include sample basis", () => {
  const sample = normalizeSampleEvidence({ count: 10, observed: 7, denominator: 12 });
  assert.deepEqual(sample, { count: 10, observed: 7, denominator: 12, complete: false });
  assert.deepEqual(makeAvailability(false, { basis: "reported", reason: "missing", sample }), {
    available: false,
    basis: "reported",
    reason: "missing",
    sample,
  });
  assert.deepEqual(confidence({ value: 1.5, basis: "derived", reason: "sampled", sample }), {
    value: 1,
    basis: "derived",
    reason: "sampled",
    sample,
  });
  assert.deepEqual(rateWithEvidence(1, 0, { basis: "derived", sample }), {
    rate: null,
    basis: "derived",
    reason: "no-positive-denominator",
    sample,
  });
});

test("stable copies handle key ordering and cycles without throwing", () => {
  const cyclic = { z: 1, a: { b: 2 } };
  cyclic.self = cyclic;
  assert.equal(stableStringify(cyclic), '{"a":{"b":2},"self":null,"z":1}');
  const frozen = deepFreeze({ nested: { value: 1 } });
  assert.ok(Object.isFrozen(frozen.nested));
});
