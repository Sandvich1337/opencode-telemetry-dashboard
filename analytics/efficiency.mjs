import {
  deepFreeze,
  finiteNumber,
  makeAvailability,
  normalizeConfidence,
  normalizeSampleEvidence,
  rateWithEvidence,
} from "./contract.mjs";

import { timingSummary } from "./time.mjs";

/** The threshold is explicit so a long-context result is never mistaken for a score. */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

const TOKEN_BUCKETS = Object.freeze(["input", "output", "reasoning", "cacheRead", "cacheWrite"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function number(value) {
  const result = finiteNumber(value);
  return result === null ? null : Math.max(0, result);
}

function runsOf(snapshot) {
  if (!Array.isArray(snapshot?.runs)) return [];
  const sessions = new Map((Array.isArray(snapshot?.sessions) ? snapshot.sessions : []).map((session) => [session.id, session]));
  return snapshot.runs.map((run) => ({ ...run, _session: sessions.get(run.sessionId) ?? null }));
}

function hasTokenEvidence(run) {
  const tokens = object(run?.tokens);
  if (!tokens) return false;
  const reporting = object(tokens.cacheWriteReporting);
  const fallback = object(run?._session?.tokens);
  const fallbackReporting = object(fallback?.cacheWriteReporting);
  if (fallback && fallbackReporting && number(fallbackReporting.samples) === 0 &&
    TOKEN_BUCKETS.every((key) => (number(tokens[key]) ?? 0) === 0)) return false;
  if (reporting && number(reporting.samples) > 0) return true;
  return !reporting && TOKEN_BUCKETS.some((key) => finiteNumber(tokens[key]) !== null);
}

function hasCostEvidence(run) {
  return ((run?.cost?.reported === true || run?.cost?.basis === "estimated") && number(run.cost.usd) !== null) ||
    ((run?._session?.cost?.reported === true || run?._session?.cost?.basis === "estimated") && number(run._session.cost.usd) !== null);
}

function costOf(run) {
  return (run?.cost?.reported === true || run?.cost?.basis === "estimated") && number(run.cost.usd) !== null
    ? run.cost
    : run?._session?.cost;
}

function hasTimingEvidence(run) {
  return finiteNumber(run?.interval?.start) !== null && finiteNumber(run?.interval?.end) !== null;
}

function sample(count, observed, denominator = count) {
  return normalizeSampleEvidence({ count, observed, denominator });
}

function confidence(available, evidence, reason) {
  return normalizeConfidence(available ? 1 : null, {
    basis: available ? "derived" : "unavailable",
    reason,
    sample: evidence,
  });
}

function metricRate(numerator, denominator, evidence, reason = "positive-denominator") {
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
  const measured = values.filter(hasTokenEvidence);
  if (!measured.length) return { value: null, measured: 0 };
  const tokens = Object.fromEntries(TOKEN_BUCKETS.map((key) => [key, 0]));
  for (const run of measured) {
    for (const key of TOKEN_BUCKETS) tokens[key] += number(run.tokens[key]) ?? 0;
  }
  const total = TOKEN_BUCKETS.reduce((sum, key) => sum + tokens[key], 0);
  return { value: { ...tokens, total }, measured: measured.length };
}

function aggregateCost(values) {
  const measured = values.filter(hasCostEvidence);
  if (!measured.length) return { value: null, measured: 0 };
  return {
    value: measured.reduce((sum, run) => sum + (number(costOf(run)?.usd) ?? 0), 0),
    measured: measured.length,
  };
}

function aggregateDuration(values) {
  const measured = values.filter(hasTimingEvidence);
  if (!measured.length) return { value: null, measured: 0 };
  return { value: timingSummary(measured.map((run) => run.interval)).workMs, measured: measured.length };
}

function pricingRate(value, keys) {
  const source = object(value);
  if (!source) return null;
  for (const key of keys) {
    const direct = number(source[key]);
    if (direct !== null) return direct;
    const nested = object(source[key]);
    const perToken = number(nested?.perToken ?? nested?.usdPerToken ?? nested?.rate);
    if (perToken !== null) return perToken;
  }
  return null;
}

function pricingEvidence(run, tokens) {
  const cost = object(costOf(run));
  const candidates = [run?.pricing, cost?.pricing, cost?.rates, run?.pricingRates];
  for (const candidate of candidates) {
    const input = pricingRate(candidate, ["inputPerToken", "inputRate", "inputUsdPerToken", "input"]);
    const cacheRead = pricingRate(candidate, ["cacheReadPerToken", "cacheReadRate", "cacheReadUsdPerToken", "cacheRead", "cache_read"]);
    if (input !== null && cacheRead !== null) return { input, cacheRead, basis: "reported" };
  }
  const components = object(cost?.components);
  const inputCost = number(components?.input);
  const cacheCost = number(components?.cacheRead ?? components?.cache_read);
  if (inputCost !== null && cacheCost !== null && tokens.input > 0 && tokens.cacheRead > 0) {
    return { input: inputCost / tokens.input, cacheRead: cacheCost / tokens.cacheRead, basis: "derived" };
  }
  return null;
}

function cacheSavings(values, tokens) {
  const cacheRuns = values.filter((run) => hasTokenEvidence(run) && number(run.tokens.cacheRead) > 0);
  if (!cacheRuns.length) {
    return {
      estimatedUSD: null,
      available: false,
      basis: "unavailable",
      reason: tokens ? "no-cache-read" : "token-sample-missing",
      sample: sample(0, 0, values.length),
    };
  }
  let estimatedUSD = 0;
  let priced = 0;
  for (const run of cacheRuns) {
    const evidence = pricingEvidence(run, run.tokens);
    if (!evidence) continue;
    priced += 1;
    estimatedUSD += number(run.tokens.cacheRead) * Math.max(0, evidence.input - evidence.cacheRead);
  }
  if (priced !== cacheRuns.length) {
    return {
      estimatedUSD: null,
      available: false,
      basis: "unavailable",
      reason: "pricing-evidence-missing",
      sample: sample(cacheRuns.length, priced, cacheRuns.length),
    };
  }
  return {
    estimatedUSD,
    available: true,
    basis: "estimated",
    reason: "recorded-pricing-evidence",
    sample: sample(cacheRuns.length, priced, cacheRuns.length),
  };
}

function reviewerOf(run) {
  return object(run?.reviewer);
}

function verdictOf(reviewer) {
  const verdict = String(reviewer?.verdict ?? "UNKNOWN").trim().toUpperCase();
  return verdict === "PASS" ? "PASS" : verdict === "ISSUE" || verdict === "FAIL" ? "ISSUE" : "UNKNOWN";
}

function reviewerPassEconomics(values) {
  const passRuns = values.filter((run) => reviewerOf(run) && verdictOf(run.reviewer) === "PASS");
  const token = aggregateTokens(passRuns);
  const cost = aggregateCost(passRuns);
  const duration = aggregateDuration(passRuns);
  const passSample = sample(passRuns.length, passRuns.length, values.length);
  const available = passRuns.length > 0;
  return {
    available,
    basis: available ? "derived" : "unavailable",
    reason: available ? "attributable-reviewer-pass" : "no-attributable-reviewer-pass",
    sample: passSample,
    passes: passRuns.length,
    measuredSamples: { tokens: token.measured, cost: cost.measured, duration: duration.measured },
    tokens: token.value,
    cost: cost.value,
    durationMs: duration.value,
    tokensPerPass: token.measured ? token.value.total / token.measured : null,
    estimatedCostPerPass: cost.measured ? cost.value / cost.measured : null,
    durationPerPassMs: duration.measured ? duration.value / duration.measured : null,
  };
}

export function analyzeEfficiency(snapshot = {}) {
  const values = runsOf(snapshot);
  const rootSample = sample(values.length, values.length, values.length);
  const token = aggregateTokens(values);
  const cost = aggregateCost(values);
  const duration = aggregateDuration(values);
  const cacheRead = token.value ? token.value.cacheRead : 0;
  const contextDenominator = token.value ? token.value.input + cacheRead : 0;
  const tokenSample = sample(token.measured, token.measured, values.length);
  const cacheReadShare = metricRate(cacheRead, contextDenominator, tokenSample, "cache-context-tokens");
  const mixDenominator = token.value ? token.value.output + token.value.reasoning : 0;
  const reasoningOutputMix = {
    output: metricRate(token.value?.output ?? 0, mixDenominator, tokenSample, "output-reasoning-tokens"),
    reasoning: metricRate(token.value?.reasoning ?? 0, mixDenominator, tokenSample, "output-reasoning-tokens"),
  };
  const crossingRuns = values.filter((run) => hasTokenEvidence(run));
  const crossings = crossingRuns.filter((run) => number(run.tokens.input) >= LONG_CONTEXT_THRESHOLD_TOKENS).length;
  const longContext = {
    thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    comparison: "greater-than-or-equal",
    evidence: "recorded-input-token-bucket",
    ...metricRate(crossings, crossingRuns.length, sample(crossingRuns.length, crossingRuns.length, values.length), "explicit-context-threshold"),
  };
  const cache = cacheSavings(values, token.value);
  const reviewerPass = reviewerPassEconomics(values);
  const available = token.measured > 0;
  const reason = available ? "recorded-token-sample" : values.length ? "token-sample-missing" : "no-runs";
  const result = {
    availability: makeAvailability(available, { basis: available ? "observed" : "unavailable", reason, sample: rootSample }),
    sample: rootSample,
    confidence: confidence(available, rootSample, reason),
    provenance: { source: "normalized-snapshot", basis: "derived", sample: rootSample },
    reasons: [reason, cache.reason, longContext.reason, reviewerPass.reason].filter((value, index, list) => list.indexOf(value) === index).sort(),
    measuredSamples: { tokens: token.measured, cost: cost.measured, duration: duration.measured },
    tokens: token.value,
    cacheReadShare,
    estimatedCacheSavings: cache,
    reasoningOutputMix,
    longContextCrossings: longContext,
    reviewerPassEconomics: reviewerPass,
    timing: { durationMs: duration.value, measuredSamples: duration.measured },
    cost: { estimatedUSD: cost.value, measuredSamples: cost.measured },
  };
  return deepFreeze(result);
}
