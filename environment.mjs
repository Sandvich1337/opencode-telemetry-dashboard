import { deepFreeze, normalizeConfidence } from "./analytics/contract.mjs";

const MISSING = Symbol("missing");
const INVENTORY_TYPES = Object.freeze(new Set(["agent", "model", "tool", "capability", "unknown"]));
const SECRET_CONTENT = /(?:api[ _-]*key|access[ _-]*token|auth(?:orization)?|bearer|cookie|csrf|client[ _-]*secret|password|passwd|private[ _-]*key|secret|session[ _-]*token|process[ ._-]*env|environment[ _-]*value|header|payload|prompt|command|args?|token|\benv\b)/i;
const URL_CONTENT = /(?:https?|file|ftp):|(?:^|\s)www\./i;
const SHELL_CONTENT = /[;&|<>$`]|(?:^|\s)(?:bash|cmd|curl|node|npm|powershell|python|rm|sh|sudo|wget)(?:\s|$)/i;
const ID_CONTENT = /^(?:session|message|part|run|request|trace|user|id)[-_]|(?:^|[-_])ids?(?:$|[-_])|^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N}._+~()\- ]{0,95}$/u;
const SAFE_CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_VERSION = /^(?:v)?[0-9][a-z0-9._+\-]{0,31}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read only an explicitly allowlisted own field, failing closed on accessors/proxies. */
function readOwn(value, key) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return MISSING;
  try {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return MISSING;
    return value[key];
  } catch {
    return MISSING;
  }
}

function readFirst(value, keys) {
  for (const key of keys) {
    const child = readOwn(value, key);
    if (child !== MISSING) return child;
  }
  return MISSING;
}

function arrayCopy(value) {
  if (!Array.isArray(value)) return [];
  try {
    return Array.from(value);
  } catch {
    return [];
  }
}

function dangerousText(value) {
  return SECRET_CONTENT.test(value) || URL_CONTENT.test(value) || SHELL_CONTENT.test(value) || ID_CONTENT.test(value) ||
    value === "." || value === ".." || value.startsWith("~") || value.includes("/") || value.includes("\\") || /^[a-z]:/i.test(value) || value.includes(":");
}

/** Names are intentionally stricter than telemetry labels: paths and secret-like content become unknown. */
function safeName(value) {
  if (typeof value !== "string") return "unknown";
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  if (!name || name.length > 96 || dangerousText(name) || !SAFE_LABEL.test(name)) return "unknown";
  return name;
}

function safeCapabilityName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  if (!name || dangerousText(name) || !SAFE_CAPABILITY.test(name)) return null;
  return name;
}

function safeVersion(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) value = String(value);
  if (typeof value !== "string") return "unknown";
  const version = value.trim().slice(0, 32);
  return SAFE_VERSION.test(version) && !dangerousText(version) ? version : "unknown";
}

function safeType(value, fallback = "unknown") {
  if (typeof value !== "string") return INVENTORY_TYPES.has(fallback) ? fallback : "unknown";
  const type = value.trim().toLowerCase();
  return INVENTORY_TYPES.has(type) ? type : "unknown";
}

function bool(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function sample(count, observed = count, denominator = count) {
  const safeCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  const safeObserved = Math.min(safeCount, Number.isSafeInteger(observed) && observed >= 0 ? observed : 0);
  const safeDenominator = denominator === null || denominator === undefined
    ? null
    : Number.isSafeInteger(denominator) && denominator >= 0 ? denominator : 0;
  return {
    count: safeCount,
    observed: safeObserved,
    denominator: safeDenominator,
    complete: safeDenominator === null ? null : safeObserved >= safeDenominator,
  };
}

function evidence(available, basis, reason, count, observed = count, denominator = count) {
  return {
    available: Boolean(available),
    basis,
    reason,
    sample: sample(count, observed, denominator),
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left, right) {
  return compareText(left.name, right.name) || compareText(left.type, right.type) || compareText(left.version, right.version);
}

function capabilityMap(value) {
  const result = {};
  if (Array.isArray(value)) {
    for (const item of arrayCopy(value)) {
      const name = safeCapabilityName(readFirst(item, ["name", "capability"]));
      const available = readFirst(item, ["available", "enabled"]);
      if (name && typeof available === "boolean") result[name] = available;
    }
  } else if (isRecord(value)) {
    let keys = [];
    try {
      keys = Object.keys(value);
    } catch {
      keys = [];
    }
    for (const key of keys) {
      const name = safeCapabilityName(key);
      const available = readOwn(value, key);
      if (name && typeof available === "boolean") result[name] = available;
    }
  }
  return Object.fromEntries(Object.keys(result).sort(compareText).map((key) => [key, result[key]]));
}

function mergeCapabilities(target, source) {
  for (const [name, available] of Object.entries(source)) target[name] = Boolean(target[name]) || available;
}

function addAggregate(target, { name, type, version = "unknown", available = true, capabilities = {}, observed = available }) {
  const normalizedName = safeName(name);
  const normalizedType = safeType(type);
  const normalizedVersion = safeVersion(version);
  const key = `${normalizedType}\u0000${normalizedName}\u0000${normalizedVersion}`;
  const current = target.get(key);
  if (current) {
    current.count += 1;
    current.observed += observed ? 1 : 0;
    current.available = current.available || Boolean(available);
    mergeCapabilities(current.capabilities, capabilities);
    return;
  }
  target.set(key, {
    name: normalizedName,
    type: normalizedType,
    version: normalizedVersion,
    available: Boolean(available),
    count: 1,
    observed: observed ? 1 : 0,
    capabilities: { ...capabilities },
  });
}

function finalizeAggregates(target, basis) {
  return [...target.values()].sort((left, right) => compareEntries(left, right)).map((entry) => ({
    name: entry.name,
    type: entry.type,
    version: entry.version,
    available: entry.available,
    capabilities: Object.fromEntries(Object.keys(entry.capabilities).sort(compareText).map((key) => [key, Boolean(entry.capabilities[key])])),
    sample: sample(entry.count, entry.observed, entry.count),
    provenance: basis,
  }));
}

function coverage(count, observed, basis, reason) {
  return evidence(count > 0, basis, reason, count, observed, count);
}

function inventory(mode, available, provenance, agents, models, tools, capabilities, coverageValue, unknown = []) {
  const entries = [...agents, ...models, ...tools, ...capabilities, ...unknown];
  const count = entries.reduce((total, entry) => total + (entry.sample?.count ?? 0), 0);
  const observed = entries.reduce((total, entry) => total + (entry.sample?.observed ?? 0), 0);
  const inventorySample = sample(count, observed, count);
  const reason = available ? "inventory-present" : provenance.scope ?? "unavailable";
  const basis = available ? provenance.basis ?? mode : "unavailable";
  return deepFreeze({
    mode,
    available: Boolean(available),
    availability: evidence(available, basis, reason, count, observed, count),
    sample: inventorySample,
    confidence: normalizeConfidence(available && count > 0 ? observed / count : null, {
      basis,
      reason,
      sample: inventorySample,
    }),
    provenance,
    agents,
    models,
    tools,
    capabilities,
    unknown,
    coverage: coverageValue,
  });
}

function entityList(snapshot) {
  const runs = arrayCopy(readOwn(snapshot, "runs"));
  if (runs.length) return runs;
  return arrayCopy(readOwn(snapshot, "sessions"));
}

function observedCapabilityEntries(snapshot) {
  const source = readOwn(readOwn(snapshot, "provenance"), "capabilities");
  const schemaVersion = safeVersion(readOwn(readOwn(snapshot, "analytics"), "schemaVersion"));
  const aggregate = new Map();
  for (const capability of arrayCopy(source)) {
    const name = safeCapabilityName(readFirst(capability, ["name", "capability"]));
    if (!name) continue;
    const available = readFirst(capability, ["available"]);
    const key = `${name}\u0000${schemaVersion}`;
    const current = aggregate.get(key);
    if (current) {
      current.available = current.available || available === true;
      current.count += 1;
      current.observed += available === true ? 1 : 0;
    } else {
      aggregate.set(key, {
        name,
        type: "capability",
        version: schemaVersion,
        available: available === true,
        count: 1,
        observed: available === true ? 1 : 0,
      });
    }
  }
  return [...aggregate.values()].sort(compareEntries).map((entry) => ({
    name: entry.name,
    type: entry.type,
    version: entry.version,
    available: entry.available,
    capabilities: { available: entry.available },
    sample: sample(entry.count, entry.observed, entry.count),
    provenance: "observed",
  }));
}

/** Project only normalized telemetry identities and reporting capabilities. This function performs no I/O. */
export function collectObservedEnvironment(snapshot = {}) {
  const entities = entityList(snapshot);
  const agents = new Map();
  const models = new Map();
  const tools = new Map();

  for (const entity of entities) {
    const identity = readOwn(entity, "identity");
    const agent = safeName(readOwn(identity, "agent"));
    const model = safeName(readOwn(identity, "model"));
    const events = arrayCopy(readOwn(entity, "toolEvents"));
    const reviewer = readOwn(entity, "reviewer");
    addAggregate(agents, {
      name: agent,
      type: "agent",
      capabilities: { model: model !== "unknown", reviewer: reviewer !== MISSING && reviewer !== null, tools: events.length > 0 },
    });
    addAggregate(models, {
      name: model,
      type: "model",
      capabilities: { agents: agent !== "unknown", tools: events.length > 0 },
    });
    for (const event of events) {
      addAggregate(tools, {
        name: safeName(readOwn(event, "tool")),
        type: "tool",
        capabilities: { errors: readOwn(event, "error") === true },
      });
    }
  }

  const capabilities = observedCapabilityEntries(snapshot);
  const basis = "observed";
  return inventory(
    "observed",
    entities.length > 0 || capabilities.length > 0,
    { source: "telemetry", basis, scope: "snapshot" },
    finalizeAggregates(agents, basis),
    finalizeAggregates(models, basis),
    finalizeAggregates(tools, basis),
    capabilities,
    {
      agents: coverage(entities.length > 0 ? [...agents.values()].reduce((sum, item) => sum + item.count, 0) : 0,
        entities.length, basis, entities.length ? "present" : "missing"),
      models: coverage(entities.length > 0 ? [...models.values()].reduce((sum, item) => sum + item.count, 0) : 0,
        entities.length, basis, entities.length ? "present" : "missing"),
      tools: coverage([...tools.values()].reduce((sum, item) => sum + item.count, 0),
        [...tools.values()].reduce((sum, item) => sum + item.count, 0), basis, tools.size ? "present" : "missing"),
      schema: coverage(capabilities.length, capabilities.reduce((sum, item) => sum + item.sample.observed, 0), basis,
        capabilities.length ? "present" : "missing"),
    },
  );
}

function descriptor(source, fallbackType) {
  if (!isRecord(source)) return null;
  const rawType = readFirst(source, ["type", "kind"]);
  const rawName = readOwn(source, "name");
  const rawVersion = readOwn(source, "version");
  const rawAvailable = readFirst(source, ["available", "enabled"]);
  return {
    name: safeName(rawName),
    type: safeType(rawType === MISSING ? fallbackType : rawType, fallbackType),
    version: safeVersion(rawVersion),
    available: bool(rawAvailable, true),
    capabilities: capabilityMap(readOwn(source, "capabilities")),
  };
}

function appendDescriptorList(target, value, fallbackType) {
  const values = Array.isArray(value) ? arrayCopy(value) : isRecord(value) ? [value] : [];
  for (const item of values) {
    const parsed = descriptor(item, fallbackType);
    if (parsed) target.push(parsed);
  }
}

function collectConfiguredDescriptors(options) {
  const descriptors = [];
  appendDescriptorList(descriptors, readOwn(options, "candidates"), "unknown");
  appendDescriptorList(descriptors, readOwn(options, "descriptors"), "unknown");

  const config = readOwn(options, "config");
  if (isRecord(config)) {
    for (const type of ["agent", "model", "tool"]) {
      appendDescriptorList(descriptors, readOwn(config, `${type}s`), type);
    }
    const direct = descriptor(config, "unknown");
    if (direct && readOwn(config, "name") !== MISSING) descriptors.push(direct);
  }
  return descriptors;
}

function configuredCapabilities(options, descriptors = []) {
  const config = readOwn(options, "config");
  const values = [];
  if (isRecord(config)) {
    const map = capabilityMap(readOwn(config, "capabilities"));
    for (const name of Object.keys(map).sort(compareText)) {
      values.push({ name, available: map[name], version: "unknown" });
    }
  }
  for (const item of descriptors) {
    if (item.type !== "capability") continue;
    const name = safeCapabilityName(item.name);
    if (name) values.push({ name, available: item.available, version: item.version });
  }
  const merged = new Map();
  for (const item of values) {
    const key = `${item.name}\u0000${item.version}`;
    const current = merged.get(key);
    if (current) current.available = current.available || item.available;
    else merged.set(key, { ...item });
  }
  return [...merged.values()].sort((left, right) => compareText(left.name, right.name) || compareText(left.version, right.version)).map(({ name, available, version }) => ({
    name,
    type: "capability",
    version,
    available,
    capabilities: { available },
    sample: sample(1, available ? 1 : 0, 1),
    provenance: "configured",
  }));
}

function configuredUnavailable(reason) {
  const unavailable = evidence(false, "unavailable", reason, 0, 0, null);
  return inventory("configured", false, { source: "caller", basis: "unavailable", scope: reason }, [], [], [], [], {
    agents: unavailable,
    models: unavailable,
    tools: unavailable,
    schema: unavailable,
  });
}

/**
 * Collect explicit caller-provided descriptors only after strict opt-in. No
 * filesystem, environment, process, command, network, or implicit discovery is used.
 */
export function collectConfiguredEnvironmentSync(options = {}) {
  let enabled = false;
  try {
    enabled = options !== null && (typeof options === "object" || typeof options === "function") && options.enabled === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return configuredUnavailable(typeof options?.disabledReason === "string" ? options.disabledReason : "disabled");

  const descriptors = collectConfiguredDescriptors(options);
  const configured = { agent: new Map(), model: new Map(), tool: new Map(), unknown: new Map() };
  for (const item of descriptors) {
    if (item.type === "capability") continue;
    const type = configured[item.type] ? item.type : "unknown";
    addAggregate(configured[type], item);
  }
  const capabilities = configuredCapabilities(options, descriptors);
  const agents = finalizeAggregates(configured.agent, "configured");
  const models = finalizeAggregates(configured.model, "configured");
  const tools = finalizeAggregates(configured.tool, "configured");
  const unknown = finalizeAggregates(configured.unknown, "configured");
  const basis = "configured";
  const agentCount = [...configured.agent.values()].reduce((sum, item) => sum + item.count, 0);
  const modelCount = [...configured.model.values()].reduce((sum, item) => sum + item.count, 0);
  const toolCount = [...configured.tool.values()].reduce((sum, item) => sum + item.count, 0);
  const capabilityCount = capabilities.length;
  const unknownCount = [...configured.unknown.values()].reduce((sum, item) => sum + item.count, 0);
  const hasInventory = agentCount + modelCount + toolCount + unknownCount + capabilityCount > 0;
  return inventory("configured", hasInventory, { source: "caller", basis: "reported", scope: "explicit" }, agents, models, tools, capabilities, {
    agents: coverage(agentCount, descriptors.filter((item) => item.type === "agent" && item.available).length, basis, agentCount ? "explicit" : "missing"),
    models: coverage(modelCount, descriptors.filter((item) => item.type === "model" && item.available).length, basis, modelCount ? "explicit" : "missing"),
    tools: coverage(toolCount, descriptors.filter((item) => item.type === "tool" && item.available).length, basis, toolCount ? "explicit" : "missing"),
    schema: coverage(capabilityCount, capabilities.reduce((sum, item) => sum + item.sample.observed, 0), basis,
      capabilityCount ? "explicit" : "missing"),
  }, unknown);
}

export async function collectConfiguredEnvironment(options = {}) {
  return collectConfiguredEnvironmentSync(options);
}
