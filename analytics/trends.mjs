import { deepFreeze, makeAvailability, normalizeConfidence } from "./contract.mjs";
import { analyzeThroughput } from "./throughput.mjs";

const BASIS_KEYS = Object.freeze(["activeWallMs", "summedWorkMs", "parallelism"]);
const TOKEN_KEYS = Object.freeze(["processed", "generated", "output"]);
const TOTAL_KEYS = Object.freeze([
  "processedTokensPerMinute",
  "generatedTokensPerMinute",
  "outputTokensPerMinute",
  "toolCallsPerMinute",
  "estimatedUsdPerHour",
]);

function delta(current, previous) {
  return typeof current === "number" && Number.isFinite(current) &&
    typeof previous === "number" && Number.isFinite(previous)
    ? current - previous
    : null;
}

function deltaObject(current, previous, keys) {
  return Object.fromEntries(keys.map((key) => [key, delta(current?.[key], previous?.[key])]));
}

function deltaReasons(current, previous) {
  const currentReason = current?.availability?.reason ?? "current-unavailable";
  const previousReason = previous?.availability?.reason ?? "previous-unavailable";
  return {
    basis: Object.fromEntries(BASIS_KEYS.map((key) => [key, current && previous ? "measured" : previousReason])),
    tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, current && previous ? "measured" : previousReason])),
    totals: Object.fromEntries(TOTAL_KEYS.map((key) => [key,
      current && previous ? (current.rateReasons?.[key] ?? "measured") : previousReason])),
    calls: current && previous ? "measured" : previousReason,
    estimatedUsd: current && previous ? (current.costAvailability?.reason ?? "measured") : previousReason,
    availability: current && previous ? "comparison-ready" : currentReason === "positive-denominator" ? "previous-unavailable" : currentReason,
  };
}

function trendAvailability(current, previous) {
  if (!previous) return makeAvailability(false, { basis: "derived", reason: "previous-unavailable", sample: current.sample });
  if (!current.availability.available) return makeAvailability(false, {
    basis: "derived",
    reason: "current-unavailable",
    sample: current.sample,
  });
  if (!previous.availability.available) return makeAvailability(false, {
    basis: "derived",
    reason: "previous-unavailable",
    sample: current.sample,
  });
  return makeAvailability(true, { basis: "derived", reason: "comparison-ready", sample: current.sample });
}

/**
 * Compare the current normalized snapshot with the immediately preceding
 * snapshot. Deltas are absolute differences; unavailable values remain null.
 */
export function analyzeTrends(currentSnapshot = {}, previousSnapshot = null) {
  const current = analyzeThroughput(currentSnapshot);
  const previous = previousSnapshot === null ? null : analyzeThroughput(previousSnapshot);
  const currentTotals = current.totals ?? {};
  const previousTotals = previous?.totals ?? null;
  const deltas = {
    basis: deltaObject(current.basis, previous?.basis, BASIS_KEYS),
    tokens: deltaObject(currentTotals.tokens, previousTotals?.tokens, TOKEN_KEYS),
    calls: delta(currentTotals.calls, previousTotals?.calls),
    estimatedUsd: delta(currentTotals.estimatedUsd, previousTotals?.estimatedUsd),
    totals: deltaObject(currentTotals.rates, previousTotals?.rates, TOTAL_KEYS),
  };
  const available = trendAvailability(current, previous);
  return deepFreeze({
    availability: available,
    sample: current.sample,
    confidence: normalizeConfidence(
      available.available && previous?.confidence?.value !== null && previous?.confidence?.value !== undefined
        ? Math.min(current.confidence?.value ?? 0, previous.confidence.value)
        : null,
      {
        basis: available.available ? "derived" : "unavailable",
        reason: available.reason,
        sample: current.sample,
      },
    ),
    previousSample: previous?.sample ?? null,
    provenance: {
      source: "normalized-snapshot",
      method: "current-minus-previous",
      current: current.provenance,
      previous: previous?.provenance ?? null,
    },
    current,
    previous,
    deltas,
    deltaReasons: deltaReasons(current, previous),
  });
}
