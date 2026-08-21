import {
  deepFreeze,
  finiteNumber,
  makeAvailability,
  normalizeCost,
  normalizeConfidence,
  normalizeLabel,
  normalizeSampleEvidence,
  normalizeTokens,
  nonNegativeInteger,
  rateWithEvidence,
  safeRate,
} from "./contract.mjs";
import {
  HOUR_MS,
  MINUTE_MS,
  bucketIntervals,
  bucketWidthMsForRange,
  clampInterval,
  normalizeRange,
  summedWorkMs,
  unionDurationMs,
} from "./time.mjs";

const INTERVAL_METHOD = "clamped-positive-union";
const RATE_KEYS = Object.freeze([
  "processedTokensPerMinute",
  "generatedTokensPerMinute",
  "outputTokensPerMinute",
  "toolCallsPerMinute",
  "estimatedUsdPerHour",
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function rowsOf(snapshot) {
  if (Array.isArray(snapshot?.runs) && snapshot.runs.length > 0) return snapshot.runs;
  return Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
}

function agentOf(row) {
  const identity = object(row?.identity);
  return normalizeLabel(identity?.agent ?? row?.agent, "unknown");
}

function zeroTokens() {
  return { processed: 0, generated: 0, output: 0 };
}

function tokensOf(row) {
  const normalized = normalizeTokens(row?.tokens);
  if (!normalized) return zeroTokens();
  return {
    processed: normalized.total,
    generated: normalized.output + normalized.reasoning,
    output: normalized.output,
  };
}

function addTokens(target, value, factor = 1) {
  target.processed += value.processed * factor;
  target.generated += value.generated * factor;
  target.output += value.output * factor;
}

function costOf(row) {
  const source = object(row?.cost);
  if (source && source.reported === false && source.basis === "unavailable") {
    return { usd: 0, available: false };
  }
  const cost = normalizeCost(row?.cost);
  return {
    usd: cost.usd,
    available: cost.reported,
  };
}

function overlapMs(left, right) {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  return end > start ? end - start : 0;
}

function eventCalls(row, fallback, range) {
  if (Array.isArray(row?.toolEvents)) {
    return row.toolEvents.map((event) => {
      const count = nonNegativeInteger(event?.count ?? event?.calls ?? 1);
      const interval = clampInterval(event?.interval ?? fallback, range) ?? fallback;
      return { count, interval };
    });
  }
  const count = finiteNumber(row?.calls ?? row?.toolCalls);
  return count === null ? [] : [{ count: Math.max(0, count), interval: fallback }];
}

function callTotal(row) {
  return row.calls.reduce((total, event) => total + event.count, 0);
}

function callShareInBucket(event, bucket) {
  if (event.interval.durationMs > 0) {
    return event.count * overlapMs(event.interval, bucket) / event.interval.durationMs;
  }
  return event.interval.start >= bucket.start && event.interval.start < bucket.end ? event.count : 0;
}

function intervalExtent(rows, requested) {
  const clipped = rows.map((row) => clampInterval(row?.interval, requested)).filter(Boolean)
    .filter((interval) => interval.end > interval.start);
  const starts = clipped.map((interval) => interval.start);
  const ends = clipped.map((interval) => interval.end);
  return {
    from: requested.from ?? (starts.length ? Math.min(...starts) : null),
    to: requested.to ?? (ends.length ? Math.max(...ends) : null),
  };
}

function selectedRange(snapshot, rows) {
  const requested = normalizeRange(snapshot?.range ?? {});
  const extent = intervalExtent(rows, { from: requested.from, to: requested.to });
  return {
    key: requested.key,
    from: extent.from,
    to: extent.to,
    now: requested.now,
  };
}

function prepareRows(rows, range) {
  return rows.map((row) => {
    const interval = clampInterval(row?.interval, range);
    if (!interval || interval.end <= interval.start) return null;
    const prepared = {
      agent: agentOf(row),
      interval,
      tokens: tokensOf(row),
      cost: costOf(row),
      calls: [],
    };
    prepared.calls = eventCalls(row, interval, range);
    return prepared;
  }).filter(Boolean);
}

function sampleFor(count, observed = count) {
  return normalizeSampleEvidence({ count, observed, denominator: count, complete: observed >= count });
}

function rate(numerator, activeMs, unitMs) {
  return rateWithEvidence(numerator, activeMs / unitMs).rate;
}

function rateReasons(activeMs, costAvailable) {
  const denominatorReason = activeMs > 0 ? "positive-denominator" : "no-positive-denominator";
  return {
    processedTokensPerMinute: denominatorReason,
    generatedTokensPerMinute: denominatorReason,
    outputTokensPerMinute: denominatorReason,
    toolCallsPerMinute: denominatorReason,
    estimatedUsdPerHour: activeMs <= 0 ? denominatorReason : costAvailable ? "positive-denominator" : "cost-unavailable",
  };
}

function ratesFor(tokens, calls, costUsd, activeMs, costAvailable) {
  return {
    processedTokensPerMinute: rate(tokens.processed, activeMs, MINUTE_MS),
    generatedTokensPerMinute: rate(tokens.generated, activeMs, MINUTE_MS),
    outputTokensPerMinute: rate(tokens.output, activeMs, MINUTE_MS),
    toolCallsPerMinute: rate(calls, activeMs, MINUTE_MS),
    estimatedUsdPerHour: costAvailable ? rate(costUsd, activeMs, HOUR_MS) : null,
  };
}

function addRowToBucket(target, row, bucket) {
  const overlap = overlapMs(row.interval, bucket);
  if (overlap <= 0) return;
  const factor = overlap / row.interval.durationMs;
  addTokens(target.tokens, row.tokens, factor);
  if (row.cost.available) {
    target.estimatedUsd += row.cost.usd * factor;
    target.costObserved += 1;
  }
  for (const event of row.calls) target.calls += callShareInBucket(event, bucket);
}

function makeSeries(prepared, range) {
  if (range.from === null || range.to === null || range.to <= range.from) return [];
  const widthMs = bucketWidthMsForRange(range);
  const buckets = bucketIntervals(range, widthMs);
  return buckets.map((bucket) => {
    const activeMs = unionDurationMs(prepared.map((row) => row.interval), bucket);
    const workMs = summedWorkMs(prepared.map((row) => row.interval), bucket);
    const target = { tokens: zeroTokens(), calls: 0, estimatedUsd: 0, costObserved: 0 };
    for (const row of prepared) addRowToBucket(target, row, bucket);
    return {
      startMs: bucket.start,
      endMs: bucket.end,
      activeMs,
      tokens: target.tokens,
      calls: target.calls,
      estimatedUsd: target.costObserved > 0 ? target.estimatedUsd : null,
      concurrency: safeRate(workMs, activeMs),
    };
  });
}

function makeByAgent(prepared) {
  const groups = new Map();
  for (const row of prepared) {
    if (!groups.has(row.agent)) groups.set(row.agent, []);
    groups.get(row.agent).push(row);
  }
  return [...groups.keys()].sort((left, right) => left.localeCompare(right)).map((agent) => {
    const rows = groups.get(agent);
    const activeMs = unionDurationMs(rows.map((row) => row.interval));
    const tokens = zeroTokens();
    let calls = 0;
    let costUsd = 0;
    let costObserved = 0;
    for (const row of rows) {
      addTokens(tokens, row.tokens);
      calls += callTotal(row);
      if (row.cost.available) {
        costUsd += row.cost.usd;
        costObserved += 1;
      }
    }
    return {
      agent,
      runs: rows.length,
      activeMs,
      tokens,
      rates: ratesFor(tokens, calls, costUsd, activeMs, costObserved > 0),
      rateReasons: rateReasons(activeMs, costObserved > 0),
      sample: sampleFor(rows.length),
      costAvailability: makeAvailability(costObserved > 0, {
        basis: costObserved === rows.length ? "reported" : "partial",
        reason: costObserved > 0 ? "reported" : "missing",
        sample: sampleFor(rows.length, costObserved),
      }),
    };
  });
}

function emptyMetrics() {
  return { tokens: zeroTokens(), calls: 0, costUsd: 0, costObserved: 0 };
}

/**
 * Derive workflow throughput from a normalized, in-memory telemetry snapshot.
 * Intervals are the only timing basis: they are clipped first, then positive
 * unions are used for wall time while every row contributes to summed work.
 */
export function analyzeThroughput(snapshot = {}) {
  const rows = rowsOf(snapshot);
  const range = selectedRange(snapshot, rows);
  const prepared = prepareRows(rows, { from: range.from, to: range.to });
  const activeWallMs = unionDurationMs(prepared.map((row) => row.interval));
  const summedWorkMsValue = prepared.reduce((total, row) => total + row.interval.durationMs, 0);
  const parallelismValue = safeRate(summedWorkMsValue, activeWallMs);
  const metrics = emptyMetrics();
  for (const row of prepared) {
    addTokens(metrics.tokens, row.tokens);
    metrics.calls += callTotal(row);
    if (row.cost.available) {
      metrics.costUsd += row.cost.usd;
      metrics.costObserved += 1;
    }
  }
  const sample = sampleFor(rows.length, prepared.length);
  const costAvailable = metrics.costObserved > 0;
  const rates = ratesFor(metrics.tokens, metrics.calls, metrics.costUsd, activeWallMs, costAvailable);
  const availabilityReason = activeWallMs > 0
    ? "positive-denominator"
    : rows.length > 0 ? "no-positive-interval" : "no-sample";
  const output = {
    availability: makeAvailability(activeWallMs > 0, {
      basis: "derived",
      reason: availabilityReason,
      sample,
    }),
    sample,
    confidence: normalizeConfidence(activeWallMs > 0 ? prepared.length / Math.max(1, rows.length) : null, {
      basis: activeWallMs > 0 ? "derived" : "unavailable",
      reason: activeWallMs > 0 ? "positive-interval-evidence" : availabilityReason,
      sample,
    }),
    provenance: {
      source: "normalized-snapshot",
      range: { key: range.key, from: range.from, to: range.to },
      intervalMethod: INTERVAL_METHOD,
      rateBasis: "workflow-wall-clock",
      costBasis: "reported-usd-only",
    },
    basis: {
      activeWallMs,
      summedWorkMs: summedWorkMsValue,
      parallelism: parallelismValue,
      intervalMethod: INTERVAL_METHOD,
    },
    totals: {
      tokens: metrics.tokens,
      calls: metrics.calls,
      estimatedUsd: costAvailable ? metrics.costUsd : null,
      rates,
    },
    rateReasons: rateReasons(activeWallMs, costAvailable),
    costAvailability: makeAvailability(costAvailable, {
      basis: metrics.costObserved === prepared.length ? "reported" : "partial",
      reason: costAvailable ? "reported" : "missing",
      sample: sampleFor(prepared.length, metrics.costObserved),
    }),
    byAgent: makeByAgent(prepared),
    series: makeSeries(prepared, range),
  };
  return deepFreeze(output);
}

