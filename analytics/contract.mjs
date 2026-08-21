/**
 * The dependency-free analytics contract shared by snapshot producers and
 * analyzers.  Values returned by this module are plain data and never retain
 * references to caller-owned objects.
 */

export const ANALYTICS_SCHEMA_VERSION = 1;
export const ANALYTICS = Object.freeze({ schemaVersion: ANALYTICS_SCHEMA_VERSION });

export const TOKEN_BUCKETS = Object.freeze([
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
]);

export const EVIDENCE_BASIS = Object.freeze([
  "observed",
  "reported",
  "derived",
  "estimated",
  "inferred",
  "unavailable",
  "unknown",
]);

const EMPTY_SAMPLE = Object.freeze({ count: 0, observed: 0, denominator: null, complete: null });

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function keyName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(value, keys) {
  const source = record(value);
  if (!source) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  const normalized = new Map(Object.entries(source).map(([key, child]) => [keyName(key), child]));
  for (const key of keys) {
    if (normalized.has(keyName(key))) return normalized.get(keyName(key));
  }
  return undefined;
}

export function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export function nonNegative(value) {
  const number = finiteNumber(value);
  return number === null ? 0 : Math.max(0, number);
}

export function nonNegativeInteger(value) {
  return Math.floor(nonNegative(value));
}

/** Normalize an epoch-millisecond timestamp without consulting the clock. */
export function timestampMs(value) {
  const number = finiteNumber(value);
  if (number !== null) return number;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function durationMs(value) {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : number;
}

export function fraction(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(1, Math.max(0, number));
}

/** Rates deliberately return null when their denominator is not positive. */
export function safeRate(numerator, denominator) {
  const top = finiteNumber(numerator);
  const bottom = finiteNumber(denominator);
  return top === null || bottom === null || bottom <= 0 ? null : top / bottom;
}

function category(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) return fallback;
  if (/(?:^|[-_.])(id|ids|path|url|uri|text|payload|prompt|command|args?|result|output)(?:$|[-_.])/.test(normalized) ||
    /(?:id|ids|path|url|uri|text|payload|prompt|command|args?|result)$/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

export function normalizeLabel(value, fallback = "unknown") {
  if (value === null || value === undefined) return fallback;
  const label = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
  return label || fallback;
}

function modelLabel(value) {
  if (value === null || value === undefined || value === "") return "unknown";
  let parsed = value;
  if (typeof parsed === "string" && parsed.trim().startsWith("{")) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = value;
    }
  }
  const source = record(parsed);
  if (!source) return normalizeLabel(value);
  const provider = pick(source, ["providerId", "providerID", "provider"]);
  const id = pick(source, ["modelId", "modelID", "id", "name"]);
  if (provider !== undefined && id !== undefined) return `${normalizeLabel(provider)}/${normalizeLabel(id)}`;
  return normalizeLabel(id ?? provider);
}

export function normalizeIdentity(value) {
  const source = record(value) ?? {};
  const primitiveAgent = typeof value === "string" ? value : undefined;
  const agent = pick(source, ["agent", "agentId", "agentID", "agentName"]) ?? primitiveAgent;
  let model = pick(source, ["model"]);
  if (model === undefined) model = pick(source, ["modelId", "modelID", "modelName", "model_name"]);
  return Object.freeze({
    agent: normalizeLabel(agent),
    model: modelLabel(model),
  });
}

export function emptyTokens() {
  return Object.fromEntries([...TOKEN_BUCKETS, "total"].map((key) => [key, 0]));
}

/**
 * Token normalization follows metrics.mjs: missing buckets are zero, negative
 * values clamp to zero, an explicit total wins, and cache-write reporting is
 * distinct from a reported zero.
 */
export function normalizeTokens(value) {
  let source = record(value);
  if (!source) return null;
  const nested = pick(source, ["tokens", "usage"]);
  if (record(nested) && TOKEN_BUCKETS.every((key) => pick(source, [key]) === undefined)) source = nested;
  const cache = record(pick(source, ["cache"])) ?? {};
  const input = nonNegative(pick(source, ["input", "inputTokens", "promptTokens"]));
  const output = nonNegative(pick(source, ["output", "outputTokens", "completionTokens"]));
  const reasoning = nonNegative(pick(source, ["reasoning", "reasoningTokens"]));
  const cacheRead = nonNegative(pick(source, ["cacheRead", "cache_read"]) ?? pick(cache, ["read"]));
  const cacheWriteValue = pick(source, ["cacheWrite", "cache_write"]);
  const cacheWrite = nonNegative(cacheWriteValue ?? pick(cache, ["write"]));
  const reportedValue = pick(source, ["cacheWriteReported"]);
  const cacheWriteReported = typeof reportedValue === "boolean"
    ? reportedValue
    : cacheWriteValue !== undefined || pick(cache, ["write"]) !== undefined;
  const explicitTotal = finiteNumber(pick(source, ["total", "totalTokens"]));
  const total = explicitTotal === null
    ? input + output + reasoning + cacheRead + cacheWrite
    : Math.max(0, explicitTotal);
  return Object.freeze({ input, output, reasoning, cacheRead, cacheWrite, cacheWriteReported, total });
}

export function normalizeCost(value) {
  const source = record(value);
  const direct = finiteNumber(source ? pick(source, ["usd", "cost", "totalCost", "estimatedUSD"]) : value);
  const basis = category(source ? pick(source, ["basis", "source"]) : undefined, direct === null ? "unavailable" : "reported");
  const reportedValue = source ? pick(source, ["reported"]) : undefined;
  const reported = typeof reportedValue === "boolean" ? reportedValue : direct !== null && basis !== "estimated";
  const rawComponents = source ? record(pick(source, ["components"])) : null;
  const components = rawComponents ? Object.freeze(Object.fromEntries(
    ["input", "cacheRead", "cacheWrite", "output"].map((key) => [key, nonNegative(pick(rawComponents, [key]))]),
  )) : null;
  return Object.freeze({
    usd: direct === null ? 0 : Math.max(0, direct),
    currency: source && typeof pick(source, ["currency"]) === "string" ? category(pick(source, ["currency"]), "usd") : "usd",
    basis,
    reported,
    ...(components ? { components } : {}),
  });
}

export function normalizeSampleEvidence(value) {
  const source = record(value) ?? {};
  const count = nonNegativeInteger(pick(source, ["count", "size", "samples"]));
  const observed = Math.min(count, nonNegativeInteger(pick(source, ["observed", "valid", "included"]))) || 0;
  const denominatorValue = finiteNumber(pick(source, ["denominator", "total", "population"]));
  const denominator = denominatorValue === null ? null : Math.max(0, Math.floor(denominatorValue));
  const completeValue = pick(source, ["complete"]);
  const complete = typeof completeValue === "boolean"
    ? completeValue
    : denominator === null ? null : observed >= denominator;
  return Object.freeze({ count, observed, denominator, complete });
}

export function normalizeEvidence(value = {}) {
  const source = record(value) ?? {};
  const hasAvailability = typeof value === "boolean" ? value : pick(source, ["available"]);
  const available = hasAvailability === true ? true : hasAvailability === false ? false : null;
  const defaultBasis = available === false ? "unavailable" : available === true ? "observed" : "unknown";
  const defaultReason = available === false ? "missing" : available === true ? "present" : "unknown";
  return Object.freeze({
    available,
    basis: category(pick(source, ["basis"]) ?? defaultBasis, defaultBasis),
    reason: category(pick(source, ["reason"]) ?? defaultReason, defaultReason),
    sample: normalizeSampleEvidence(pick(source, ["sample", "evidence"])),
  });
}

export function makeAvailability(available, evidence = {}) {
  return normalizeEvidence({ ...(record(evidence) ?? {}), available });
}

export const availability = makeAvailability;

export function normalizeConfidence(value, evidence = {}) {
  const source = record(value);
  const score = fraction(source ? pick(source, ["value", "confidence", "score"]) : value);
  const normalized = normalizeEvidence({ ...(record(evidence) ?? {}), ...(source ?? {}) });
  return Object.freeze({ value: score, basis: normalized.basis, reason: normalized.reason, sample: normalized.sample });
}

export const confidence = normalizeConfidence;

export function rateWithEvidence(numerator, denominator, evidence = {}) {
  const rate = safeRate(numerator, denominator);
  const normalized = normalizeEvidence({
    ...(record(evidence) ?? {}),
    available: rate !== null,
    reason: rate === null ? "no-positive-denominator" : pick(record(evidence) ?? {}, ["reason"]) ?? "positive-denominator",
  });
  return Object.freeze({ rate, basis: normalized.basis, reason: normalized.reason, sample: normalized.sample });
}

/** Stable, cycle-safe data copy used for deterministic tie-breaks. */
export function stableValue(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key], seen)]));
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export const EMPTY_SAMPLE_EVIDENCE = EMPTY_SAMPLE;
