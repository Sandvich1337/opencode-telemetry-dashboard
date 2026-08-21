import {
  deepFreeze,
  finiteNumber,
  makeAvailability,
  normalizeConfidence,
  normalizeSampleEvidence,
  rateWithEvidence,
} from "./contract.mjs";

const TOKEN_BUCKETS = Object.freeze(["input", "output", "reasoning", "cacheRead", "cacheWrite"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function number(value) {
  const result = finiteNumber(value);
  return result === null ? null : Math.max(0, result);
}

function valuesOf(snapshot) {
  if (!Array.isArray(snapshot?.runs)) return [];
  const sessions = new Map((Array.isArray(snapshot?.sessions) ? snapshot.sessions : []).map((session) => [session.id, session]));
  return snapshot.runs.map((run) => ({ ...run, _session: sessions.get(run.sessionId) ?? null }));
}

function tokenMeasured(run) {
  const tokens = object(run?.tokens);
  if (!tokens) return false;
  const fallback = object(run?._session?.tokens);
  const fallbackReporting = object(fallback?.cacheWriteReporting);
  if (fallback && fallbackReporting && number(fallbackReporting.samples) === 0 &&
    TOKEN_BUCKETS.every((key) => (number(tokens[key]) ?? 0) === 0)) return false;
  const reporting = object(tokens.cacheWriteReporting);
  if (reporting && number(reporting.samples) > 0) return true;
  return !reporting && TOKEN_BUCKETS.some((key) => finiteNumber(tokens[key]) !== null);
}

function costMeasured(run) {
  return (run?.cost?.reported === true && number(run.cost.usd) !== null) ||
    (run?._session?.cost?.reported === true && number(run._session.cost.usd) !== null);
}

function costOf(run) {
  return run?.cost?.reported === true && number(run.cost.usd) !== null ? run.cost : run?._session?.cost;
}

function durationMeasured(run) {
  return finiteNumber(run?.interval?.start) !== null && finiteNumber(run?.interval?.end) !== null;
}

function sample(count, observed, denominator = count) {
  return normalizeSampleEvidence({ count, observed, denominator });
}

function rate(numerator, denominator, evidence, reason) {
  const result = rateWithEvidence(numerator, denominator, {
    basis: "derived",
    reason,
    sample: evidence,
  });
  return {
    rate: result.rate,
    numerator,
    denominator,
    basis: result.basis,
    reason: result.reason,
    sample: result.sample,
    minimumSample: { required: 1, observed: denominator, met: denominator >= 1 },
  };
}

function aggregateTokens(values) {
  const measured = values.filter(tokenMeasured);
  if (!measured.length) return { value: null, measured: 0 };
  const tokens = Object.fromEntries(TOKEN_BUCKETS.map((key) => [key, 0]));
  for (const run of measured) for (const key of TOKEN_BUCKETS) tokens[key] += number(run.tokens[key]) ?? 0;
  return {
    value: { ...tokens, total: TOKEN_BUCKETS.reduce((total, key) => total + tokens[key], 0) },
    measured: measured.length,
  };
}

function aggregateCost(values) {
  const measured = values.filter(costMeasured);
  if (!measured.length) return { value: null, measured: 0 };
  return {
    value: measured.reduce((total, run) => total + (number(costOf(run)?.usd) ?? 0), 0),
    measured: measured.length,
  };
}

function aggregateDuration(values) {
  const measured = values.filter(durationMeasured);
  if (!measured.length) return { value: null, measured: 0 };
  return {
    value: measured.reduce((total, run) => total + (run.interval.end - run.interval.start), 0),
    measured: measured.length,
  };
}

function callsOf(run) {
  if (!Array.isArray(run?.toolEvents)) return { calls: 0, recorded: false };
  return {
    calls: run.toolEvents.reduce((total, event) => total + (number(event?.count) ?? 0), 0),
    recorded: run.toolEvents.length > 0,
  };
}

function errorsOf(run) {
  if (Array.isArray(run?.errors) && run.errors.length) {
    return run.errors.reduce((total, error) => total + (number(error?.count) ?? 0), 0);
  }
  return Array.isArray(run?.toolEvents)
    ? run.toolEvents.reduce((total, event) => total + (event?.error ? number(event.count) ?? 0 : 0), 0)
    : 0;
}

function reviewerVerdict(run) {
  const reviewer = object(run?.reviewer);
  if (!reviewer) return null;
  const value = String(reviewer.verdict ?? "UNKNOWN").trim().toUpperCase();
  return value === "PASS" ? "PASS" : value === "ISSUE" || value === "FAIL" ? "ISSUE" : "UNKNOWN";
}

function reviewerOutcomes(values) {
  const reviewed = values.filter((run) => reviewerVerdict(run) !== null);
  const counts = { PASS: 0, ISSUE: 0, UNKNOWN: 0 };
  for (const run of reviewed) counts[reviewerVerdict(run)] += 1;
  const evidence = sample(reviewed.length, reviewed.length, values.length);
  const passRate = rate(counts.PASS, reviewed.length, evidence, "reviewer-pass-outcomes");
  return {
    available: reviewed.length > 0,
    basis: reviewed.length > 0 ? "observed" : "unavailable",
    reason: reviewed.length > 0 ? "attributable-reviewer-outcomes" : "reviewer-attribution-missing",
    sample: evidence,
    attributable: reviewed.length,
    counts,
    passRate: passRate.rate,
    passRateEvidence: passRate,
  };
}

function row(values, dimension, label) {
  const token = aggregateTokens(values);
  const cost = aggregateCost(values);
  const duration = aggregateDuration(values);
  const calls = values.map(callsOf);
  const callCount = calls.reduce((total, value) => total + value.calls, 0);
  const callSamples = calls.filter((value) => value.recorded).length;
  const errors = values.reduce((total, run) => total + errorsOf(run), 0);
  const tokenSample = sample(token.measured, token.measured, values.length);
  const callSample = sample(callSamples, callSamples, values.length);
  const errorRate = rate(errors, callCount, callSample, "recorded-tool-calls");
  const cacheDenominator = token.value ? token.value.input + token.value.cacheRead : 0;
  const cacheShare = rate(token.value?.cacheRead ?? 0, cacheDenominator, tokenSample, "cache-context-tokens");
  const timingSample = sample(duration.measured, duration.measured, values.length);
  const costSample = sample(cost.measured, cost.measured, values.length);
  const identity = dimension === "agent" ? { agent: label } : { model: label };
  return {
    ...identity,
    runs: values.length,
    measuredSamples: { tokens: token.measured, cost: cost.measured, duration: duration.measured, calls: callSamples, reviewer: reviewerOutcomes(values).attributable },
    tokens: token.value,
    estimatedCost: cost.value,
    duration: duration.value,
    calls: callCount,
    errorRate: errorRate.rate,
    cacheShare: cacheShare.rate,
    estimatedCostEvidence: {
      available: cost.value !== null,
      basis: cost.value === null ? "unavailable" : "reported",
      reason: cost.value === null ? "cost-sample-missing" : "recorded-cost",
      sample: costSample,
    },
    durationEvidence: {
      available: duration.value !== null,
      basis: duration.value === null ? "unavailable" : "observed",
      reason: duration.value === null ? "timing-sample-missing" : "recorded-intervals",
      sample: timingSample,
    },
    errorRateEvidence: errorRate,
    cacheShareEvidence: cacheShare,
    reviewerOutcomes: reviewerOutcomes(values),
  };
}

function stableLabel(value) {
  return value === null || value === undefined || value === "" ? "unknown" : String(value);
}

function buildRows(values, dimension) {
  const groups = new Map();
  for (const run of values) {
    const identity = object(run?.identity);
    const label = stableLabel(identity?.[dimension]);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(run);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([label, group]) => row(group, dimension, label));
}

export function analyzeComparisons(snapshot = {}) {
  const values = valuesOf(snapshot);
  const rootSample = sample(values.length, values.length, values.length);
  const available = values.length > 0;
  const reason = available ? "recorded-runs" : "no-runs";
  const result = {
    availability: makeAvailability(available, { basis: available ? "observed" : "unavailable", reason, sample: rootSample }),
    sample: rootSample,
    confidence: normalizeConfidence(available ? 1 : null, { basis: available ? "derived" : "unavailable", reason, sample: rootSample }),
    provenance: { source: "normalized-snapshot", basis: "derived", sample: rootSample },
    reasons: [reason].sort(),
    byAgent: buildRows(values, "agent"),
    byModel: buildRows(values, "model"),
  };
  return deepFreeze(result);
}
