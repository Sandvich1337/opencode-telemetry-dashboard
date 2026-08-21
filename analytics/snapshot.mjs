import {
  ANALYTICS,
  deepFreeze,
  finiteNumber,
  makeAvailability,
  normalizeConfidence,
  normalizeCost,
  normalizeEvidence,
  normalizeIdentity,
  normalizeLabel,
  normalizeSampleEvidence,
  normalizeTokens,
  nonNegative,
  nonNegativeInteger,
  stableStringify,
  timestampMs,
} from "./contract.mjs";
import { normalizeInterval } from "./time.mjs";

/**
 * Frozen internal snapshot shape (schema version 1):
 *
 * {
 *   analytics: { schemaVersion: 1 },
 *   range: { from: epochMs|null, to: epochMs|null },
 *   scope: { kind, sessionId: rawId|null },
 *   provenance: {
 *     range: evidence, scope: evidence,
 *     capabilities: [{ name, ...evidence }]
 *   },
 *   sessions: [{ id, parentId, rootId, identity, interval, tokens, cost,
 *     toolEvents: [{ tool, interval, error, count }], errors, reviewer }],
 *   runs: [{ id, sessionId, parentId, rootId, identity, interval, tokens,
 *     cost, toolEvents, errors, reviewer }]
 * }
 *
 * IDs and identity labels can remain in this internal value for joins. Use
 * sanitizeSnapshot before crossing a public boundary; it emits aliases only.
 */

const EMPTY_INTERVAL = Object.freeze({ start: null, end: null, durationMs: 0 });
const UNKNOWN = "unknown";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function read(value, keys) {
  const source = object(value);
  if (!source) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  const wanted = new Set(keys.map((key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const [key, child] of Object.entries(source)) {
    if (wanted.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) return child;
  }
  return undefined;
}

function parseValue(value) {
  if (typeof value !== "string") return value;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rawId(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function uniqueId(value, used, fallback) {
  const base = rawId(value, fallback);
  const count = (used.get(base) ?? 0) + 1;
  used.set(base, count);
  return count === 1 ? base : `${base}#${count}`;
}

function safeCategory(value, fallback = UNKNOWN) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) return fallback;
  if (/(?:^|[-_.])(id|ids|path|url|uri|text|payload|prompt|command|args?|result|output)(?:$|[-_.])/.test(normalized) ||
    /(?:id|ids|path|url|uri|text|payload|prompt|command|args?|result)$/.test(normalized)) return fallback;
  return normalized;
}

function canonicalVerdict(value) {
  const verdict = String(value ?? "").trim().toUpperCase();
  return verdict === "PASS" || verdict === "ISSUE" ? verdict : "UNKNOWN";
}

function tokenPresent(value) {
  const source = object(value);
  if (!source) return false;
  if (object(read(source, ["tokens", "usage"]))) return true;
  return ["input", "output", "reasoning", "cacheRead", "cache_read", "cacheWrite", "cache_write", "total", "totalTokens"]
    .some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function tokensOf(value) {
  const source = parseValue(value);
  const nested = object(source) ? parseValue(read(source, ["data"])) : null;
  if (tokenPresent(source)) return normalizeTokens(source);
  return tokenPresent(nested) ? normalizeTokens(nested) : null;
}

function addTokens(target, value) {
  if (!value) return;
  for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]) target[key] += nonNegative(value[key]);
  const reporting = object(value.cacheWriteReporting);
  if (reporting) {
    const samples = nonNegativeInteger(read(reporting, ["samples", "count"]));
    const observed = Math.min(samples, nonNegativeInteger(read(reporting, ["observed", "reported"])));
    target.cacheWriteReporting.samples += samples;
    target.cacheWriteReporting.observed += observed;
  } else {
    target.cacheWriteReporting.samples += 1;
  }
  if (value.cacheWriteReported || reporting?.observed > 0) {
    target.cacheWriteReported = true;
    if (!reporting) target.cacheWriteReporting.observed += 1;
  }
}

function aggregateTokens(values) {
  const total = {
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cacheWriteReported: false,
    cacheWriteReporting: { observed: 0, samples: 0 },
  };
  for (const value of values) addTokens(total, tokensOf(value));
  return deepFreeze(total);
}

function hasCost(value) {
  const source = object(parseValue(value));
  if (!source) return finiteNumber(value) !== null;
  return ["usd", "cost", "totalCost", "estimatedUSD"].some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function aggregateCost(values) {
  const normalized = values.map((value) => parseValue(value)).filter(hasCost).map(normalizeCost);
  if (!normalized.length) return normalizeCost(null);
  const estimated = normalized.some((value) => value.basis === "estimated");
  const reported = normalized.some((value) => value.reported);
  const componentValues = normalized.filter((value) => value.components);
  const components = componentValues.length
    ? Object.fromEntries(["input", "cacheRead", "cacheWrite", "output"].map((key) => [
      key,
      componentValues.reduce((total, value) => total + (value.components[key] ?? 0), 0),
    ]))
    : null;
  return deepFreeze({
    usd: normalized.reduce((total, value) => total + value.usd, 0),
    currency: "usd",
    basis: estimated ? "estimated" : reported ? "reported" : "unavailable",
    reported,
    ...(components ? { components } : {}),
  });
}

function intervalFromChildren(value, children = []) {
  const own = normalizeInterval(read(value, ["interval"]) ?? value);
  if (own) return own;
  const intervals = children.map((child) => normalizeInterval(child)).filter(Boolean);
  if (!intervals.length) return EMPTY_INTERVAL;
  return Object.freeze({
    start: Math.min(...intervals.map((interval) => interval.start)),
    end: Math.max(...intervals.map((interval) => interval.end)),
    durationMs: Math.max(...intervals.map((interval) => interval.end)) - Math.min(...intervals.map((interval) => interval.start)),
  });
}

function eventData(value) {
  const source = parseValue(value);
  const nested = object(source) ? parseValue(read(source, ["data"])) : null;
  return object(nested) ?? object(source) ?? {};
}

function eventTool(value) {
  const source = eventData(value);
  const name = read(source, ["tool", "toolName", "name"]);
  const type = String(read(source, ["type"]) ?? "").toLowerCase();
  if (name === undefined && type !== "tool") return null;
  return normalizeLabel(name ?? "unknown");
}

function eventError(value) {
  const source = eventData(value);
  const state = object(read(source, ["state"]));
  const status = String(read(source, ["status"]) ?? read(state, ["status"]) ?? "").toLowerCase();
  const errorValue = read(source, ["error"]);
  const stateErrorValue = read(state, ["error"]);
  return status === "error" || status === "failed" || errorValue === true ||
    stateErrorValue === true || (errorValue !== undefined && errorValue !== null && errorValue !== false) ||
    (stateErrorValue !== undefined && stateErrorValue !== null && stateErrorValue !== false) ||
    String(read(source, ["type"]) ?? "").toLowerCase() === "error";
}

function normalizeToolEvent(value, fallbackInterval, index) {
  const tool = eventTool(value);
  if (!tool) return null;
  const source = object(parseValue(value)) ?? {};
  const interval = normalizeInterval(read(source, ["interval"]) ?? source) ?? fallbackInterval ?? EMPTY_INTERVAL;
  const countValue = finiteNumber(read(source, ["count", "calls"]));
  const tokens = tokensOf(source);
  const costValue = read(source, ["cost"]);
  return {
    tool,
    interval,
    error: eventError(value),
    count: countValue === null ? 1 : nonNegativeInteger(countValue),
    ...(tokens ? { tokens } : {}),
    ...(costValue === undefined ? {} : { cost: normalizeCost(costValue) }),
    _index: index,
  };
}

function normalizeToolEvents(value, children = [], fallbackInterval = EMPTY_INTERVAL) {
  const source = object(value);
  const direct = Array.isArray(read(source, ["toolEvents", "tools"])) ? read(source, ["toolEvents", "tools"]) : [];
  const all = [...direct, ...children];
  return all.map((item, index) => normalizeToolEvent(item, fallbackInterval, index)).filter(Boolean)
    .sort((left, right) => (left.interval.start ?? Number.MAX_SAFE_INTEGER) - (right.interval.start ?? Number.MAX_SAFE_INTEGER) ||
      left.tool.localeCompare(right.tool) || Number(left.error) - Number(right.error) || left._index - right._index)
    .map(({ _index, ...event }) => Object.freeze(event));
}

function normalizeError(value, fallbackInterval = EMPTY_INTERVAL, index = 0) {
  const source = object(parseValue(value));
  const interval = normalizeInterval(read(source, ["interval"]) ?? source) ?? fallbackInterval;
  const kind = safeCategory(read(source, ["kind", "type", "status"]) ?? "error", "error");
  const count = finiteNumber(read(source, ["count", "errors"])) ?? 1;
  return { kind, count: nonNegativeInteger(count), interval, _index: index };
}

function normalizeErrors(value, children = [], fallbackInterval = EMPTY_INTERVAL) {
  const source = object(value);
  const direct = Array.isArray(read(source, ["errors", "errorEvents"])) ? read(source, ["errors", "errorEvents"]) : [];
  const derived = children.filter(eventError);
  return [...direct, ...derived].map((item, index) => normalizeError(item, fallbackInterval, index))
    .sort((left, right) => (left.interval.start ?? Number.MAX_SAFE_INTEGER) - (right.interval.start ?? Number.MAX_SAFE_INTEGER) ||
      left.kind.localeCompare(right.kind) || left._index - right._index)
    .map(({ _index, ...error }) => Object.freeze(error));
}

function normalizeReviewer(value) {
  const source = object(value);
  if (!source && (value === null || value === undefined || value === "")) return null;
  const input = source ?? { agent: value };
  const identity = normalizeIdentity(input);
  const slotValue = finiteNumber(read(input, ["slot", "reviewerSlot"]));
  const confidenceValue = read(input, ["confidence"]);
  return deepFreeze({
    agent: identity.agent,
    slot: slotValue === null || slotValue < 1 ? null : nonNegativeInteger(slotValue),
    verdict: canonicalVerdict(read(input, ["verdict", "result"])),
    confidence: confidenceValue === undefined || confidenceValue === null ? null : normalizeConfidence(confidenceValue),
  });
}

function childRows(rows, sessionId) {
  return rows.filter((row) => String(read(row, ["sessionId", "session_id"]) ?? "") === String(sessionId));
}

function normalizeEntity(value, children, kind, fallbackId, tokenChildren = children) {
  const source = object(value) ?? {};
  const interval = intervalFromChildren(source, children);
  let identity = normalizeIdentity(read(source, ["identity"]) ?? source);
  for (const child of children) {
    const childIdentity = normalizeIdentity(read(child, ["data"]) ?? child);
    identity = {
      agent: identity.agent === UNKNOWN ? childIdentity.agent : identity.agent,
      model: identity.model === UNKNOWN ? childIdentity.model : identity.model,
    };
  }
  const sourceTokens = tokensOf(source);
  const dataTokens = tokensOf(read(source, ["data"]));
  const tokenInputs = sourceTokens ? [source] : dataTokens ? [read(source, ["data"])] : tokenChildren;
  const sourceCost = read(source, ["cost"]) ?? (hasCost(source) ? source : null);
  const sourceData = read(source, ["data"]);
  const dataCost = read(sourceData, ["cost"]) ?? (hasCost(sourceData) ? sourceData : null);
  const childCosts = tokenChildren.flatMap((child) => {
    const childData = read(child, ["data"]);
    const value = read(child, ["cost"]) ?? (hasCost(child) ? child : null) ??
      (hasCost(childData) ? childData : null);
    return value === null || value === undefined ? [] : [value];
  });
  const costInputs = sourceCost ? [sourceCost] : dataCost ? [dataCost] : childCosts;
  const tokens = aggregateTokens(tokenInputs);
  const cost = aggregateCost(costInputs);
  const directReviewer = read(source, ["reviewer", "reviewerAttribution"]);
  const reviewer = normalizeReviewer(directReviewer ?? (
    read(source, ["reviewerAgent"]) === undefined ? null : { agent: read(source, ["reviewerAgent"]), verdict: read(source, ["verdict"]) }
  ));
  return {
    id: rawId(read(source, ["id", `${kind}Id`]), fallbackId),
    parentId: rawId(read(source, ["parentId", "parent_id"]), null),
    sessionId: kind === "run" ? rawId(read(source, ["sessionId", "session_id"]), null) : undefined,
    rootId: null,
    identity,
    interval,
    tokens,
    cost,
    ...(read(source, ["pricing", "pricingRates"]) ? { pricing: read(source, ["pricing", "pricingRates"]) } : {}),
    toolEvents: normalizeToolEvents(source, children, interval),
    errors: normalizeErrors(source, children, interval),
    reviewer,
  };
}

function compareEntity(left, right) {
  return (left.interval.start === null ? Number.MAX_SAFE_INTEGER : left.interval.start) -
    (right.interval.start === null ? Number.MAX_SAFE_INTEGER : right.interval.start) ||
    (left.interval.end === null ? Number.MAX_SAFE_INTEGER : left.interval.end) -
    (right.interval.end === null ? Number.MAX_SAFE_INTEGER : right.interval.end) ||
    left.id.localeCompare(right.id);
}

function rootFor(id, parents) {
  let current = id;
  const seen = new Set();
  while (parents.has(current) && parents.get(current) !== null && !seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    if (!parents.has(parent)) break;
    current = parent;
  }
  return current;
}

function normalizeRange(value) {
  const source = object(value) ?? {};
  let from = timestampMs(read(source, ["from", "start"]));
  let to = timestampMs(read(source, ["to", "end"]));
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  return Object.freeze({ from, to });
}

function normalizeScope(value) {
  const source = object(value) ?? {};
  const supplied = String(read(source, ["kind", "mode"]) ?? "all").toLowerCase();
  const kind = ["all", "root", "session", "custom"].includes(supplied) ? supplied : "unknown";
  return Object.freeze({
    kind,
    sessionId: rawId(read(source, ["sessionId", "session_id"]), null),
  });
}

function normalizeCapabilities(value) {
  const source = value ?? {};
  const entries = Array.isArray(source)
    ? source.map((entry) => [read(entry, ["name", "capability"]), entry])
    : object(source) ? Object.entries(source) : [];
  return entries.map(([name, entry]) => {
    const normalizedName = safeCategory(name, "unknown");
    const evidence = normalizeEvidence(entry);
    return Object.freeze({ name: normalizedName, ...evidence });
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeProvenance(input, range, scope) {
  const source = object(input) ?? {};
  const rangeSource = read(source, ["range"]);
  const scopeSource = read(source, ["scope"]);
  const capabilities = normalizeCapabilities(read(source, ["capabilities"]) ?? {});
  return {
    range: normalizeEvidence(rangeSource ?? { available: range.from !== null || range.to !== null, basis: "observed", reason: "explicit" }),
    scope: normalizeEvidence(scopeSource ?? { available: scope.kind !== "all", basis: "observed", reason: "explicit" }),
    capabilities,
  };
}

function asSnapshotInput(value) {
  return object(value) ?? {};
}

/** Construct and deeply freeze a normalized internal snapshot without I/O. */
export function normalizeSnapshot(value = {}) {
  const input = asSnapshotInput(value);
  const rawSessions = Array.isArray(input.sessions) ? input.sessions : [];
  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const rawParts = Array.isArray(input.parts) ? input.parts : [];
  const rawRuns = Array.isArray(input.runs) ? input.runs : [];
  const sessionIds = new Map();
  const sessions = rawSessions.map((raw, index) => {
    const source = object(raw) ?? {};
    const id = uniqueId(read(source, ["id", "sessionId"]), sessionIds, `session-${index + 1}`);
    const children = [...childRows(rawMessages, read(source, ["id", "sessionId"])), ...childRows(rawParts, read(source, ["id", "sessionId"]))];
    const messageChildren = childRows(rawMessages, read(source, ["id", "sessionId"]));
    const tokenChildren = messageChildren.some((child) => tokensOf(child)) ? messageChildren : children;
    return normalizeEntity({ ...source, id }, children, "session", id, tokenChildren);
  });
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const parents = new Map(sessions.map((session) => [session.id, session.parentId]));
  for (const session of sessions) session.rootId = rootFor(session.id, parents);

  const runIds = new Map();
  const runInputs = rawRuns.length ? rawRuns : sessions.map((session) => ({
    id: `run:${session.id}`,
    sessionId: session.id,
    parentId: session.parentId,
    identity: session.identity,
    interval: session.interval,
    tokens: session.tokens,
    cost: session.cost,
    toolEvents: session.toolEvents,
    errors: session.errors,
    reviewer: session.reviewer,
  }));
  const runs = runInputs.map((raw, index) => {
    const source = object(raw) ?? {};
    const id = uniqueId(read(source, ["id", "runId"]), runIds, `run-${index + 1}`);
    const sessionId = rawId(read(source, ["sessionId", "session_id"]), null);
    const session = sessionById.get(sessionId);
    const children = rawRuns.length
      ? [...childRows(rawMessages, sessionId), ...childRows(rawParts, sessionId)]
      : [];
    const messageChildren = childRows(rawMessages, sessionId);
    const tokenChildren = messageChildren.some((child) => tokensOf(child)) ? messageChildren : children;
    const normalized = normalizeEntity({
      ...source,
      id,
      parentId: read(source, ["parentId", "parent_id"]) ?? session?.parentId,
      identity: read(source, ["identity"]) ?? session?.identity,
      interval: read(source, ["interval"]) ?? session?.interval,
    }, children, "run", id, tokenChildren);
    normalized.sessionId = sessionId;
    normalized.rootId = session?.rootId ?? rootFor(sessionId ?? id, parents);
    return normalized;
  });
  const runParents = new Map(runs.map((run) => [run.id, run.parentId]));
  for (const run of runs) {
    if (run.rootId === null || run.rootId === undefined || (!sessionById.has(run.rootId) && runParents.has(run.id))) {
      run.rootId = runParents.has(run.id) ? rootFor(run.id, runParents) : run.id;
    }
  }
  sessions.sort(compareEntity);
  runs.sort(compareEntity);

  const range = normalizeRange(input.range ?? input.provenance?.range);
  const scope = normalizeScope(input.scope ?? input.provenance?.scope);
  const provenanceInput = input.provenance ?? {
    range: input.rangeEvidence,
    scope: input.scopeEvidence,
    capabilities: input.capabilities,
  };
  const snapshot = {
    analytics: { ...ANALYTICS },
    range,
    scope,
    provenance: normalizeProvenance(provenanceInput, range, scope),
    sessions,
    runs,
  };
  return deepFreeze(snapshot);
}

export const createSnapshot = normalizeSnapshot;
export const buildSnapshot = normalizeSnapshot;

function sortValues(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))].sort((left, right) => left.localeCompare(right));
}

function aliasCatalog(values, prefix, sort = true) {
  const aliases = new Map();
  const ordered = sort ? sortValues(values) : [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
  ordered.forEach((value, index) => aliases.set(value, `${prefix}-${String(index + 1).padStart(3, "0")}`));
  return aliases;
}

function allEntities(snapshot) {
  return [...snapshot.sessions, ...snapshot.runs];
}

function publicInterval(interval) {
  return { start: interval.start, end: interval.end, durationMs: interval.durationMs };
}

function publicTokens(tokens) {
  const reporting = tokens.cacheWriteReporting ?? {
    observed: tokens.cacheWriteReported ? 1 : 0,
    samples: tokens.cacheWriteReported ? 1 : 0,
  };
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    total: tokens.total,
    cacheWriteReporting: { observed: reporting.observed, samples: reporting.samples },
  };
}

function publicCost(cost) {
  return {
    usd: cost.usd,
    currency: cost.currency,
    basis: cost.basis,
    reported: cost.reported,
    ...(cost.components ? { components: { ...cost.components } } : {}),
  };
}

function publicEvidence(value) {
  const evidence = normalizeEvidence(value);
  return {
    available: evidence.available,
    basis: evidence.basis,
    reason: evidence.reason,
    sample: normalizeSampleEvidence(evidence.sample),
  };
}

function publicConfidence(value) {
  if (!value) return null;
  const confidence = normalizeConfidence(value);
  return { value: confidence.value, basis: confidence.basis, reason: confidence.reason, sample: confidence.sample };
}

function publicErrors(errors) {
  return errors.map((error) => ({ kind: safeCategory(error.kind, "error"), count: error.count, interval: publicInterval(error.interval) }));
}

function publicReviewer(reviewer, agentAliases, reviewerAliases) {
  if (!reviewer) return null;
  return {
    reviewerAlias: reviewerAliases.get(reviewer.agent) ?? "reviewer-unknown",
    agentAlias: agentAliases.get(reviewer.agent) ?? "agent-unknown",
    slot: reviewer.slot,
    verdict: canonicalVerdict(reviewer.verdict),
    confidence: publicConfidence(reviewer.confidence),
  };
}

function publicEvents(events, toolAliases) {
  return events.map((event) => ({
    toolAlias: toolAliases.get(event.tool) ?? "tool-unknown",
    interval: publicInterval(event.interval),
    error: event.error,
    count: event.count,
    ...(event.tokens ? { tokens: publicTokens(event.tokens) } : {}),
    ...(event.cost ? { cost: publicCost(event.cost) } : {}),
  }));
}

function publicEntity(entity, aliases, sessionAliases, agentAliases, modelAliases, toolAliases, reviewerAliases) {
  const result = {
    alias: aliases.get(entity.id) ?? "entity-unknown",
    parentAlias: sessionAliases.get(entity.parentId) ?? null,
    rootAlias: sessionAliases.get(entity.rootId) ?? null,
    identity: {
      agent: agentAliases.get(entity.identity.agent) ?? "agent-unknown",
      model: modelAliases.get(entity.identity.model) ?? "model-unknown",
    },
    interval: publicInterval(entity.interval),
    tokens: publicTokens(entity.tokens),
    cost: publicCost(entity.cost),
    toolEvents: publicEvents(entity.toolEvents, toolAliases),
    errors: publicErrors(entity.errors),
    reviewer: publicReviewer(entity.reviewer, agentAliases, reviewerAliases),
  };
  if (entity.sessionId !== undefined) result.sessionAlias = sessionAliases.get(entity.sessionId) ?? null;
  return result;
}

/**
 * Public sanitization is allow-list based. It never copies arbitrary input,
 * recursively drops privacy-sensitive keys, and replaces every joinable
 * identity with a deterministic alias derived only from stable ordering.
 */
export function sanitizeSnapshot(value) {
  const validSnapshot = value?.analytics?.schemaVersion === ANALYTICS.schemaVersion &&
    Array.isArray(value.sessions) && Array.isArray(value.runs) && object(value.range) && object(value.scope) &&
    object(value.provenance);
  const snapshot = validSnapshot ? value : normalizeSnapshot(value);
  const entities = allEntities(snapshot);
  const sessionAliases = aliasCatalog(snapshot.sessions.map((entity) => entity.id), "session", false);
  const runAliases = aliasCatalog(snapshot.runs.map((entity) => entity.id), "run", false);
  const agentAliases = aliasCatalog(entities.map((entity) => entity.identity.agent).concat(entities.flatMap((entity) => entity.reviewer ? [entity.reviewer.agent] : [])), "agent");
  const modelAliases = aliasCatalog(entities.map((entity) => entity.identity.model), "model");
  const toolAliases = aliasCatalog(entities.flatMap((entity) => entity.toolEvents.map((event) => event.tool)), "tool");
  const reviewerAliases = aliasCatalog(entities.flatMap((entity) => entity.reviewer ? [entity.reviewer.agent] : []), "reviewer");
  const relationAliases = new Map([...sessionAliases, ...runAliases]);
  const publicValue = {
    analytics: { schemaVersion: ANALYTICS.schemaVersion },
    range: { from: snapshot.range.from, to: snapshot.range.to },
    scope: {
      kind: snapshot.scope.kind,
      sessionAlias: sessionAliases.get(snapshot.scope.sessionId) ?? null,
    },
    provenance: {
      range: publicEvidence(snapshot.provenance.range),
      scope: publicEvidence(snapshot.provenance.scope),
      capabilities: snapshot.provenance.capabilities.map((capability) => ({
        name: safeCategory(capability.name),
        ...publicEvidence(capability),
      })),
    },
    sessions: snapshot.sessions.map((entity) => publicEntity(entity, sessionAliases, relationAliases, agentAliases, modelAliases, toolAliases, reviewerAliases)),
    runs: snapshot.runs.map((entity) => publicEntity(entity, runAliases, relationAliases, agentAliases, modelAliases, toolAliases, reviewerAliases)),
  };
  return deepFreeze(sanitizePublic(publicValue));
}

export const toPublicSnapshot = sanitizeSnapshot;
export const publicSnapshot = sanitizeSnapshot;

const SAFE_STRING_KEYS = new Set([
  "agent", "agentAlias", "alias", "basis", "classification", "code", "currency", "kind", "label", "method", "model", "modelAlias", "name", "primaryRole", "reason", "role", "severity", "signal", "source", "summary", "title",
  "parentAlias", "reviewerAlias", "reviewerVerdict", "rootAlias", "scope", "sessionAlias", "source", "target", "tool", "toolAlias", "type", "verdict", "unit",
]);

function forbiddenKey(key, value) {
  const normalized = key.toLowerCase();
  if (normalized === "source" || normalized === "target" || normalized === "longcontextcrossings") return false;
  if (/(?:^|[_-])(raw|payload|prompt|text|path|url|uri|command|args?|result|message|content)(?:$|[_-])/.test(normalized) ||
    /(?:raw|payload|prompt|text|path|url|uri|command|args?|result|message|content)/.test(normalized)) return true;
  if (/(?:^|[_-])id$/.test(normalized) || normalized === "id" || normalized.endsWith("id") || normalized.endsWith("ids")) {
    return !(normalized === "id" && typeof value === "string" && /^(?:agent|model|run|tool)-\d{3,}$/.test(value));
  }
  if ((normalized === "input" || normalized === "output") && typeof value !== "number") return true;
  return false;
}

function safeString(key, value, contextKey = "") {
  if (contextKey === "reason-map") return safeCategory(value, "unknown");
  if (key === "id") return /^(?:agent|model|run|tool)-\d{3,}$/.test(value) ? value : undefined;
  if (!SAFE_STRING_KEYS.has(key)) return undefined;
  if (["source", "target"].includes(key)) return /^[a-z]+-\d{3,}$/.test(value) || value.endsWith("-unknown") ? value : undefined;
  if (key.endsWith("Alias")) return /^[a-z]+-\d{3,}$/.test(value) || value.endsWith("-unknown") ? value : undefined;
  if (key === "verdict") return ["PASS", "ISSUE", "UNKNOWN"].includes(value) ? value : "UNKNOWN";
  if (["agent", "model", "name", "tool", "label"].includes(key)) {
    const label = normalizeLabel(value, "unknown");
    if (/(?:https?|file|ftp):|[\\]|(?:^|[-_])(session|message|part|run|request|trace|user)[-_]|[;&|<>$`]/i.test(label)) return undefined;
    return /^[\p{L}\p{N}][\p{L}\p{N}._+~()\- /]{0,95}$/u.test(label) ? label : undefined;
  }
  if (["title", "summary"].includes(key)) {
    const label = normalizeLabel(value, "unknown");
    return /(?:https?|file|ftp):|[\\]|[;&|<>$`]/i.test(label) ? undefined : label.slice(0, 160);
  }
  return safeCategory(value, "unknown");
}

/** Recursively sanitize an already public value; useful for analyzer extensions. */
export function sanitizePublic(value, contextKey = "") {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return undefined;
  if (Array.isArray(value)) return value.map(sanitizePublic).filter((child) => child !== undefined);
  if (!object(value)) return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey(key, child)) continue;
    if (typeof child === "string") {
      const safe = safeString(key, child, contextKey);
      if (safe !== undefined) result[key] = safe;
      continue;
    }
    const childContext = key === "rateReasons" || key === "deltaReasons" || key.endsWith("Reasons")
      ? "reason-map"
      : key;
    const sanitized = sanitizePublic(child, childContext);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function snapshotFingerprint(value) {
  return stableStringify(sanitizeSnapshot(value));
}

export { makeAvailability };
