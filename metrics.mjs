import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateMessageCost, PRICING_CATALOG } from "./pricing.mjs";

const TABLE_SPECS = Object.freeze({
  session: {
    required: ["id"],
    columns: {
      id: ["id", "session_id", "sessionID"],
      parentId: ["parent_id", "parentID", "parent"],
      createdAt: ["time_created", "created_at", "createdAt"],
      updatedAt: ["time_updated", "updated_at", "updatedAt"],
      agent: ["agent", "agent_id", "agentID", "agent_name", "agentName"],
      model: ["model", "model_id", "modelID", "model_name", "modelName"],
      summary: ["summary", "session_summary", "sessionSummary"],
      summaryAdditions: ["summary_additions", "summaryAdditions"],
      summaryDeletions: ["summary_deletions", "summaryDeletions"],
      summaryFiles: ["summary_files", "summaryFiles"],
      title: ["title", "session_title", "sessionTitle"],
    },
  },
  message: {
    required: ["id", "sessionId", "data"],
    columns: {
      id: ["id", "message_id", "messageID"],
      sessionId: ["session_id", "sessionID"],
      createdAt: ["time_created", "created_at", "createdAt"],
      updatedAt: ["time_updated", "updated_at", "updatedAt"],
      data: ["data", "json", "payload"],
    },
  },
  part: {
    required: ["id", "sessionId", "data"],
    columns: {
      id: ["id", "part_id", "partID"],
      sessionId: ["session_id", "sessionID"],
      messageId: ["message_id", "messageID"],
      createdAt: ["time_created", "created_at", "createdAt"],
      updatedAt: ["time_updated", "updated_at", "updatedAt"],
      data: ["data", "json", "payload"],
    },
  },
});

const RANGE_DURATIONS = Object.freeze({
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
});
const RANGE_LABELS = Object.freeze({
  all: "All time",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
});

export const TABLES = Object.freeze(Object.keys(TABLE_SPECS));

function sessionAlias(sessionId) {
  return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16);
}

function publicTimestamp(value) {
  const number = finiteNumber(value);
  if (number !== null) return number;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function makeSessionOption(session, includeSessionTitles = false) {
  const identity = mergeIdentity(session);
  const option = {
    alias: sessionAlias(session.id),
    parentAlias: session.parentId ? sessionAlias(session.parentId) : null,
    createdAt: publicTimestamp(session.createdAt),
    updatedAt: publicTimestamp(session.updatedAt),
    agent: identity.agent,
    model: identity.model,
    kind: session.parentId ? "child" : "root",
  };
  if (includeSessionTitles && !session.parentId) option.title = session.title === undefined || session.title === null
    ? null
    : safeLabel(session.title, null);
  return option;
}

function sessionCatalog(sessions, options = {}) {
  return sessions
    .filter((session) => session.id !== undefined && session.id !== null && String(session.id) !== "")
    .map((session) => ({
      session,
      option: makeSessionOption(session, options.includeSessionTitles === true),
    }))
    .sort((left, right) => {
      const rightUpdated = timestampMs(right.session.updatedAt) ?? timestampMs(right.session.createdAt);
      const leftUpdated = timestampMs(left.session.updatedAt) ?? timestampMs(left.session.createdAt);
      if (rightUpdated !== leftUpdated) {
        if (rightUpdated === null || rightUpdated === undefined) return 1;
        if (leftUpdated === null || leftUpdated === undefined) return -1;
        return rightUpdated > leftUpdated ? 1 : -1;
      }
      const rightCreated = timestampMs(right.session.createdAt);
      const leftCreated = timestampMs(left.session.createdAt);
      if (rightCreated !== leftCreated) {
        if (rightCreated === null || rightCreated === undefined) return 1;
        if (leftCreated === null || leftCreated === undefined) return -1;
        return rightCreated > leftCreated ? 1 : -1;
      }
      return left.option.alias.localeCompare(right.option.alias);
    });
}

function resolveSessionScope(sessions, catalog, requested) {
  const hasSelection = requested !== undefined && requested !== null && String(requested) !== "";
  if (!hasSelection) {
    return {
      apply: false,
      ids: null,
      metadata: null,
      mode: "all",
      selectedAlias: null,
      found: true,
      count: catalog.length,
    };
  }

  const selected = catalog.find(({ option }) => option.alias === String(requested));
  if (!selected) {
    return {
      apply: true,
      ids: new Set(),
      metadata: null,
      mode: "session",
      selectedAlias: null,
      found: false,
      count: 0,
    };
  }

  const selectedIds = new Set([String(selected.session.id)]);
  if (!selected.session.parentId) {
    const sessionById = new Map(catalog.map(({ session }) => [String(session.id), session]));
    const childrenByParent = new Map();
    for (const session of catalog.map(({ session: value }) => value)) {
      if (!session.parentId) continue;
      const parentId = String(session.parentId);
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(String(session.id));
    }

    const pending = [String(selected.session.id)];
    while (pending.length) {
      const parentId = pending.shift();
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (selectedIds.has(childId) || !sessionById.has(childId)) continue;
        selectedIds.add(childId);
        pending.push(childId);
      }
    }
  }
  return {
    apply: true,
    ids: selectedIds,
    metadata: selected.option,
    mode: "session",
    selectedAlias: selected.option.alias,
    found: true,
    count: selectedIds.size,
  };
}

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonNegative(value) {
  const number = finiteNumber(value);
  return number === null ? 0 : Math.max(0, number);
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !(value instanceof Uint8Array)) return value;
  let text;
  if (value instanceof Uint8Array) {
    text = new TextDecoder().decode(value);
  } else {
    text = String(value);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeLabel(value, fallback = "unknown") {
  if (value === null || value === undefined) return fallback;
  const label = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return label ? label.slice(0, 160) : fallback;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function columnLookup(columns) {
  const lookup = new Map();
  for (const column of columns) {
    lookup.set(String(column.name).toLowerCase(), String(column.name));
    lookup.set(normalizedKey(column.name), String(column.name));
  }
  return lookup;
}

function chooseColumn(lookup, candidates) {
  for (const candidate of candidates) {
    const exact = lookup.get(String(candidate).toLowerCase());
    if (exact) return exact;
    const normalized = lookup.get(normalizedKey(candidate));
    if (normalized) return normalized;
  }
  return null;
}

function tableColumns(db, table) {
  try {
    return db
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => ({ name: String(row.name), type: String(row.type ?? "") }));
  } catch {
    return [];
  }
}

function describeTable(db, table, spec) {
  const columns = tableColumns(db, table);
  const lookup = columnLookup(columns);
  const selected = Object.fromEntries(
    Object.entries(spec.columns).map(([alias, candidates]) => [alias, chooseColumn(lookup, candidates)]),
  );
  const missing = spec.required.filter((alias) => !selected[alias]);
  return {
    present: columns.length > 0,
    usable: columns.length > 0 && missing.length === 0,
    missing,
    selected,
    hasTimestamps: Boolean(selected.createdAt || selected.updatedAt),
    hasHierarchy: Boolean(selected.parentId),
  };
}

export function inspectSchema(db) {
  const tables = Object.fromEntries(
    TABLES.map((table) => [table, describeTable(db, table, TABLE_SPECS[table])]),
  );
  const capabilities = {
    session: tables.session.usable,
    message: tables.message.usable,
    part: tables.part.usable,
    timestamps: TABLES.every((table) => tables[table].hasTimestamps),
    sessionHierarchy: tables.session.hasHierarchy,
    messageData: tables.message.usable,
    partData: tables.part.usable,
    toolMetadata: tables.part.usable,
    fileMetadata: tables.part.usable,
    reviewerVerdicts: tables.message.usable || tables.part.usable,
  };
  const missingTables = TABLES.filter((table) => !tables[table].present);
  const missingColumns = TABLES.flatMap((table) =>
    tables[table].missing.map((column) => `${table}.${column}`),
  );
  return {
    ok: TABLES.every((table) => tables[table].usable),
    tables: Object.fromEntries(
      TABLES.map((table) => [
        table,
        {
          present: tables[table].present,
          usable: tables[table].usable,
          missing: tables[table].missing,
        },
      ]),
    ),
    capabilities,
    missing: [...missingTables.map((table) => `${table} table`), ...missingColumns],
    _details: tables,
  };
}

function selectRows(db, table, description) {
  if (!description.usable) return [];
  const spec = TABLE_SPECS[table];
  const fields = [];
  for (const alias of Object.keys(spec.columns)) {
    const column = description.selected[alias];
    if (column) fields.push(`${quoteIdentifier(column)} AS ${quoteIdentifier(alias)}`);
  }
  if (!fields.length) return [];
  try {
    return db.prepare(`SELECT ${fields.join(", ")} FROM ${quoteIdentifier(table)}`).all();
  } catch {
    return [];
  }
}

export function readDatabaseRows(db, schema = inspectSchema(db)) {
  const details = schema._details ?? Object.fromEntries(
    TABLES.map((table) => [table, describeTable(db, table, TABLE_SPECS[table])]),
  );
  return {
    sessions: selectRows(db, "session", details.session),
    messages: selectRows(db, "message", details.message),
    parts: selectRows(db, "part", details.part),
  };
}

function timestampMs(value) {
  const number = finiteNumber(value);
  if (number !== null) return Math.abs(number) < 100_000_000_000 ? number * 1000 : number;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseOptionTime(value) {
  if (value === null || value === undefined || value === "") return null;
  return timestampMs(value);
}

export function normalizeRange(options = {}) {
  const now = parseOptionTime(options.now) ?? Date.now();
  const requested = String(options.range ?? "all").toLowerCase();
  let from = parseOptionTime(options.from);
  let to = parseOptionTime(options.to);
  const hasExplicitBounds = from !== null || to !== null;
  let key = RANGE_DURATIONS[requested] ? requested : requested === "all" ? "all" : "all";

  if (!hasExplicitBounds && RANGE_DURATIONS[requested]) {
    from = now - RANGE_DURATIONS[requested];
    to = now;
  }
  if (to !== null && from !== null && to < from) [from, to] = [to, from];
  if (hasExplicitBounds) key = "custom";
  return {
    key,
    from,
    to,
    now,
    label: key === "custom" ? "Custom range" : RANGE_LABELS[key] ?? RANGE_LABELS.all,
  };
}

export function activeInRange(startValue, endValue, range) {
  const start = timestampMs(startValue);
  const end = timestampMs(endValue) ?? start;
  if (range.from === null && range.to === null) return true;
  if (start === null && end === null) return false;
  if (range.from !== null && end < range.from) return false;
  if (range.to !== null && start > range.to) return false;
  return true;
}

function rowStart(row) {
  return timestampMs(row.createdAt) ?? timestampMs(row.updatedAt);
}

function rowEnd(row) {
  return timestampMs(row.updatedAt) ?? timestampMs(row.createdAt);
}

function rowSort(a, b) {
  return (rowStart(a) ?? Number.MAX_SAFE_INTEGER) - (rowStart(b) ?? Number.MAX_SAFE_INTEGER) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function objectValue(object, keys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  }
  const normalized = new Map(Object.entries(object).map(([key, value]) => [normalizedKey(key), value]));
  for (const key of keys) {
    const value = normalized.get(normalizedKey(key));
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasObjectValue(object, keys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return false;
  const normalized = new Set(Object.keys(object).map(normalizedKey));
  return keys.some((key) => Object.prototype.hasOwnProperty.call(object, key) || normalized.has(normalizedKey(key)));
}

function modelLabel(value) {
  let model = value;
  if (typeof model === "string" && model.trim().startsWith("{")) model = parseJson(model);
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const provider = objectValue(model, ["providerId", "providerID", "provider"]);
    const id = objectValue(model, ["modelId", "modelID", "id", "name"]);
    model = provider && id ? `${provider}/${id}` : id ?? provider;
  }
  return model === undefined || model === null || model === "" ? null : safeLabel(model);
}

function partialIdentity(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const agent = objectValue(data, ["agent", "agentId", "agentID", "agentName"]);
  let model = objectValue(data, ["model"]);
  if (model === undefined) model = objectValue(data, ["modelId", "modelID", "model_name", "modelName"]);
  return {
    agent: agent === undefined || agent === null || agent === "" ? null : safeLabel(agent),
    model: modelLabel(model),
  };
}

function mergeIdentity(...sources) {
  const merged = { agent: null, model: null };
  for (const source of sources) {
    const identity = partialIdentity(source);
    if (identity.agent) merged.agent = identity.agent;
    if (identity.model) merged.model = identity.model;
  }
  return {
    agent: merged.agent ?? "unknown",
    model: merged.model ?? "unknown",
  };
}

function fillIdentity(...sources) {
  const merged = { agent: null, model: null };
  for (const source of sources) {
    const identity = partialIdentity(source);
    if (!merged.agent && identity.agent) merged.agent = identity.agent;
    if (!merged.model && identity.model) merged.model = identity.model;
  }
  return {
    agent: merged.agent ?? "unknown",
    model: merged.model ?? "unknown",
  };
}

function agentModel(data) {
  return mergeIdentity(data);
}

function groupKey(group) {
  return `${group.agent}\u0000${group.model}`;
}

function isKnownGroup(group) {
  return group.agent !== "unknown" || group.model !== "unknown";
}

function dataRole(data) {
  return String(objectValue(data, ["role"]) ?? "").toLowerCase();
}

function tokensFrom(data) {
  if (!data || typeof data !== "object") return null;
  const tokens = objectValue(data, ["tokens", "usage"]);
  if (!tokens || typeof tokens !== "object") return null;
  const cache = objectValue(tokens, ["cache"]) ?? {};
  const input = nonNegative(objectValue(tokens, ["input", "inputTokens", "promptTokens"]));
  const output = nonNegative(objectValue(tokens, ["output", "outputTokens", "completionTokens"]));
  const reasoning = nonNegative(objectValue(tokens, ["reasoning", "reasoningTokens"]));
  const cacheRead = nonNegative(objectValue(tokens, ["cacheRead", "cache_read"]) ?? objectValue(cache, ["read"]));
  const cacheWrite = nonNegative(objectValue(tokens, ["cacheWrite", "cache_write"]) ?? objectValue(cache, ["write"]));
  const cacheWriteReported = hasObjectValue(tokens, ["cacheWrite", "cache_write"]) || hasObjectValue(cache, ["write"]);
  const explicitTotal = finiteNumber(objectValue(tokens, ["total", "totalTokens"]));
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cacheWriteReported,
    total: explicitTotal === null ? input + output + reasoning + cacheRead + cacheWrite : Math.max(0, explicitTotal),
  };
}

function costFrom(data) {
  if (!data || typeof data !== "object") return 0;
  const direct = finiteNumber(objectValue(data, ["cost", "totalCost"]));
  if (direct !== null) return direct;
  const usage = objectValue(data, ["usage"]);
  return usage && typeof usage === "object" ? finiteNumber(objectValue(usage, ["cost", "totalCost"])) ?? 0 : 0;
}

function emptyEstimatedCost() {
  return {
    usd: 0,
    components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    coverage: { priced: 0, unpriced: 0 },
  };
}

function publicPricing(estimatedCost) {
  const catalog = PRICING_CATALOG && typeof PRICING_CATALOG === "object" ? PRICING_CATALOG : {};
  const longContextThreshold = finiteNumber(
    catalog.longContextThreshold ?? catalog.threshold ?? catalog.longContext?.threshold,
  ) ?? 272_000;
  return {
    estimatedUSD: estimatedCost.usd,
    components: { ...estimatedCost.components },
    coverage: { ...estimatedCost.coverage },
    source: typeof catalog.source === "string" ? catalog.source : null,
    date: catalog.date ?? catalog.asOf ?? null,
    currency: typeof catalog.currency === "string" ? catalog.currency : null,
    unit: typeof catalog.unit === "string" ? catalog.unit : null,
    longContextThreshold,
  };
}

function addEstimatedCost(target, data, fallbackModel) {
  const tokens = tokensFrom(data);
  if (!tokens) return;
  const model = partialIdentity(data).model;
  const estimate = estimateMessageCost(model && model !== "unknown" ? model : fallbackModel, tokens);
  if (!estimate) {
    target.coverage.unpriced += 1;
    return;
  }
  target.coverage.priced += 1;
  target.usd += estimate.usd;
  for (const key of Object.keys(target.components)) target.components[key] += estimate.components[key];
}

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(target, value) {
  if (!value) return;
  for (const key of Object.keys(target)) target[key] += value[key] ?? 0;
}

function toolName(data) {
  if (!data || typeof data !== "object") return null;
  const type = String(objectValue(data, ["type"]) ?? "").toLowerCase();
  const value = objectValue(data, ["tool", "toolName", "name"]);
  if (value === undefined || value === null || value === "") return type === "tool" ? "unknown" : null;
  return safeLabel(value, "unknown");
}

function isReadTool(name) {
  const value = String(name ?? "").toLowerCase().replaceAll("\\", "/");
  return value === "read" || value.endsWith("/read") || value.endsWith(".read") ||
    value === "read_file" || value === "readfile" || value === "filesystem.read";
}

function hasError(data) {
  if (!data || typeof data !== "object") return false;
  const state = objectValue(data, ["state"]);
  const status = String(objectValue(data, ["status"]) ?? objectValue(state, ["status"]) ?? "").toLowerCase();
  return status === "error" || status === "failed" || objectValue(data, ["error"]) !== undefined ||
    (state && typeof state === "object" && objectValue(state, ["error"]) !== undefined) ||
    String(objectValue(data, ["type"]) ?? "").toLowerCase() === "error";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fileMetadataDelta(data, sessionId, seenFiles) {
  const state = data && typeof data === "object" ? objectValue(data, ["state"]) : null;
  const metadata = state && typeof state === "object" ? objectValue(state, ["metadata"]) : null;
  const files = metadata && typeof metadata === "object" ? objectValue(metadata, ["files"]) : null;
  if (!Array.isArray(files)) return { additions: 0, deletions: 0, files: 0 };

  let additions = 0;
  let deletions = 0;
  let uniqueFiles = 0;
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) continue;
    const path = objectValue(file, ["path", "file", "filename", "fileName", "filePath", "relativePath"]);
    const fileAdditions = nonNegative(objectValue(file, ["additions", "addition", "insertions"]));
    const fileDeletions = nonNegative(objectValue(file, ["deletions", "deletion", "removals"]));
    const patch = objectValue(file, ["patch"]);
    const key = JSON.stringify([String(sessionId), path ?? "", fileAdditions, fileDeletions, stableValue(patch)]);
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    uniqueFiles += 1;
    additions += fileAdditions;
    deletions += fileDeletions;
  }
  return { additions, deletions, files: uniqueFiles };
}

function sessionSummaryDelta(session) {
  if (session.summaryAdditions !== undefined || session.summaryDeletions !== undefined) {
    return {
      additions: nonNegative(session.summaryAdditions),
      deletions: nonNegative(session.summaryDeletions),
    };
  }
  const summary = parseJson(session.summary);
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return { additions: 0, deletions: 0 };
  }
  return {
    additions: nonNegative(objectValue(summary, ["additions", "addition"])),
    deletions: nonNegative(objectValue(summary, ["deletions", "deletion"])),
  };
}

function textValues(value, result = [], depth = 0) {
  if (depth > 5 || value === null || value === undefined) return result;
  if (Array.isArray(value)) {
    for (const item of value) textValues(item, result, depth + 1);
    return result;
  }
  if (typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "text" && typeof child === "string") result.push(child);
    else if (typeof child === "object") textValues(child, result, depth + 1);
  }
  return result;
}

const VERDICT_PATTERN = /\bVERDICT\s*:\s*([A-Za-z][A-Za-z0-9_-]*)\b/g;

export function parseVerdict(text) {
  if (typeof text !== "string") return null;
  let verdict = null;
  for (const match of text.matchAll(VERDICT_PATTERN)) verdict = safeLabel(match[1], "unknown");
  return verdict;
}

function messageGroup(data, sessionIdentity) {
  return fillIdentity(sessionIdentity, data);
}

function partGroup(partData, messageData, sessionIdentity) {
  return fillIdentity(sessionIdentity, messageData, partData);
}

function primaryGroup(session, messages, parts) {
  const firstMessage = messages.find((row) => isKnownGroup(agentModel(row.data)));
  const firstPart = parts.find((row) => isKnownGroup(agentModel(row.data)));
  return fillIdentity(session, firstMessage?.data, firstPart?.data);
}

function stateTimes(data) {
  const state = data && typeof data === "object" ? objectValue(data, ["state"]) : null;
  const time = state && typeof state === "object" ? objectValue(state, ["time"]) : null;
  if (!time || typeof time !== "object") return [];
  return [objectValue(time, ["start", "startedAt"]), objectValue(time, ["end", "endedAt"])]
    .map(timestampMs)
    .filter((value) => value !== null);
}

function rangeDuration(start, end, range) {
  if (start === null || end === null || end < start) return 0;
  const clippedStart = range.from === null ? start : Math.max(start, range.from);
  const clippedEnd = range.to === null ? end : Math.min(end, range.to);
  return Math.max(0, clippedEnd - clippedStart);
}

function sessionDuration(session, messages, parts, range) {
  let start = rowStart(session);
  let end = rowEnd(session);
  if (start === null || end === null || end < start) {
    const times = [...messages, ...parts].flatMap((row) => [rowStart(row), rowEnd(row), ...stateTimes(row.data)])
      .filter((value) => value !== null);
    if (times.length) {
      start = Math.min(...times);
      end = Math.max(...times);
    }
  }
  return rangeDuration(start, end, range);
}

function makeAggregate(group) {
  return {
    agent: group.agent,
    model: group.model,
    runs: 0,
    subagents: 0,
    tokens: emptyTokens(),
    cacheWriteReporting: emptyCacheWriteReporting(),
    cost: 0,
    estimatedCost: emptyEstimatedCost(),
    tools: 0,
    toolBreakdown: new Map(),
    reads: 0,
    errors: 0,
    durationMs: 0,
    files: { additions: 0, deletions: 0 },
    _sessions: new Set(),
  };
}

function aggregateFor(aggregates, group) {
  const key = groupKey(group);
  if (!aggregates.has(key)) aggregates.set(key, makeAggregate(group));
  return aggregates.get(key);
}

function addSessionRun(aggregate, session, messages, parts, range) {
  if (!aggregate._sessions.has(session.id)) {
    aggregate._sessions.add(session.id);
    aggregate.runs += 1;
    if (session.parentId) aggregate.subagents += 1;
    aggregate.durationMs += sessionDuration(session, messages, parts, range);
  }
}

function addMessageRow(aggregate, data) {
  const tokens = tokensFrom(data);
  addTokens(aggregate.tokens, tokens);
  addCacheWriteReporting(aggregate.cacheWriteReporting, tokens);
  aggregate.cost += costFrom(data);
  addEstimatedCost(aggregate.estimatedCost, data, aggregate.model);
  if (hasError(data)) aggregate.errors += 1;
}

function addPartRow(aggregate, data) {
  const name = toolName(data);
  if (name !== null) {
    aggregate.tools += 1;
    aggregate.toolBreakdown.set(name, (aggregate.toolBreakdown.get(name) ?? 0) + 1);
    if (isReadTool(name)) aggregate.reads += 1;
  }
  if (hasError(data)) aggregate.errors += 1;
}

const TOKEN_BUCKETS = Object.freeze(["input", "output", "reasoning", "cacheRead", "cacheWrite"]);
const UNATTRIBUTED_TOOL = "Unattributed / no tool";

function emptyCacheWriteReporting() {
  return { observed: 0, samples: 0 };
}

function addCacheWriteReporting(target, tokens) {
  if (!tokens) return;
  target.samples += 1;
  if (tokens.cacheWriteReported) target.observed += 1;
}

function emptyTokenBuckets() {
  return Object.fromEntries(TOKEN_BUCKETS.map((key) => [key, 0]));
}

function addTokenBuckets(target, value) {
  if (!value) return;
  for (const key of TOKEN_BUCKETS) target[key] += value[key] ?? 0;
}

function equalTokenBuckets(left, right) {
  return TOKEN_BUCKETS.every((key) => (left?.[key] ?? 0) === (right?.[key] ?? 0));
}

function splitEven(value, count) {
  if (count <= 0) return [];
  const amount = nonNegative(value);
  if (!Number.isInteger(amount)) {
    const share = amount / count;
    return Array.from({ length: count }, (_, index) => index === count - 1
      ? amount - share * (count - 1)
      : share);
  }
  const quotient = Math.floor(amount / count);
  const remainder = amount % count;
  return Array.from({ length: count }, (_, index) => quotient + (index < remainder ? 1 : 0));
}

function splitTokens(value, count) {
  const result = Array.from({ length: count }, () => emptyTokenBuckets());
  for (const key of TOKEN_BUCKETS) {
    const shares = splitEven(value?.[key] ?? 0, count);
    for (let index = 0; index < count; index += 1) result[index][key] = shares[index];
  }
  for (const share of result) share.cacheWriteReported = Boolean(value?.cacheWriteReported);
  return result;
}

function makeToolUsageRow(tool) {
  return {
    tool,
    calls: 0,
    errors: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    _cacheRead: 0,
    _cacheWrite: 0,
    estimatedUSD: 0,
    cacheWriteReporting: emptyCacheWriteReporting(),
  };
}

function toolUsageRow(rows, tool) {
  if (!rows.has(tool)) rows.set(tool, makeToolUsageRow(tool));
  return rows.get(tool);
}

function addToolTokens(row, tokens, model, context) {
  row.input += tokens.input;
  row.output += tokens.output;
  row.reasoning += tokens.reasoning;
  row._cacheRead += tokens.cacheRead;
  row._cacheWrite += tokens.cacheWrite;
  addCacheWriteReporting(row.cacheWriteReporting, tokens);
  const estimate = estimateMessageCost(model, tokens, { context });
  if (estimate) row.estimatedUSD += estimate.usd;
}

function partType(data) {
  return String(objectValue(data, ["type"]) ?? "").toLowerCase().replaceAll("_", "-");
}

function stepTokens(data) {
  const direct = tokensFrom(data);
  if (direct) return direct;
  const state = data && typeof data === "object" ? objectValue(data, ["state"]) : null;
  return tokensFrom(state);
}

function stepGroups(parts) {
  const groups = [];
  let current = null;
  let invalid = false;
  let toolsSeen = 0;
  const toolsInParts = parts.filter((part) => toolName(part.data) !== null);

  for (const part of parts) {
    const type = partType(part.data);
    if (type === "step-start") {
      if (current) invalid = true;
      current = { tools: [] };
    } else if (toolName(part.data) !== null) {
      toolsSeen += 1;
      if (!current) invalid = true;
      else current.tools.push(part);
    } else if (type === "step-finish") {
      const tokens = stepTokens(part.data);
      if (!current || !tokens) invalid = true;
      else groups.push({ tools: current.tools, tokens });
      current = null;
    }
  }

  if (current || invalid || !groups.length || toolsSeen !== toolsInParts.length) return null;
  const total = emptyTokenBuckets();
  for (const group of groups) addTokenBuckets(total, group.tokens);
  return { groups, total };
}

function messageKey(sessionId, messageId) {
  if (messageId === undefined || messageId === null || messageId === "") return null;
  return `${String(sessionId)}\u0000${String(messageId)}`;
}

function toolUsageRowBuckets(row) {
  return {
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cacheRead: row._cacheRead,
    cacheWrite: row._cacheWrite,
  };
}

function publicToolUsageRow(row) {
  const cacheRead = row._cacheRead;
  const cacheWrite = row._cacheWrite;
  const total = row.input + row.output + row.reasoning + cacheRead + cacheWrite;
  return {
    tool: row.tool,
    calls: row.calls,
    errors: row.errors,
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cacheRead,
    cacheWrite,
    total,
    cache: cacheRead + cacheWrite,
    estimatedUSD: row.estimatedUSD,
    cacheWriteReporting: { ...row.cacheWriteReporting },
  };
}

function emptyToolUsage() {
  const empty = emptyTokenBuckets();
  return {
    rows: [],
    byAgent: [],
    cacheWriteReporting: emptyCacheWriteReporting(),
    conservation: {
      exact: true,
      ok: true,
      summary: { ...empty, total: 0 },
      rows: { ...empty, total: 0 },
      delta: { ...empty, total: 0 },
    },
    method: "step-start→tools→step-finish when conserved; otherwise all message tools",
    methods: { stepFinish: 0, messageTools: 0, noTool: 0, noTokens: 0, nonAssistant: 0 },
  };
}

function tokenTotals(value) {
  const totals = { ...emptyTokenBuckets() };
  addTokenBuckets(totals, value);
  totals.total = value?.total ?? TOKEN_BUCKETS.reduce((total, key) => total + totals[key], 0);
  return totals;
}

function addTokenTotals(target, value) {
  addTokenBuckets(target, value);
  target.total += value?.total ?? TOKEN_BUCKETS.reduce((total, key) => total + (value?.[key] ?? 0), 0);
}

function tokenConservation(summary, rows) {
  const summaryTotals = tokenTotals(summary);
  const allocated = { ...emptyTokenBuckets() };
  addTokenBuckets(allocated, rows);
  const allocatedWithTotal = {
    ...allocated,
    total: TOKEN_BUCKETS.reduce((total, key) => total + allocated[key], 0),
  };
  const delta = Object.fromEntries([
    ...TOKEN_BUCKETS.map((key) => [key, allocated[key] - summaryTotals[key]]),
    ["total", allocatedWithTotal.total - summaryTotals.total],
  ]);
  const exact = Object.values(delta).every((value) => value === 0);
  return { exact, ok: exact, summary: summaryTotals, rows: allocatedWithTotal, delta };
}

function makeAgentToolBlock(blocks, agent) {
  if (!blocks.has(agent)) {
    blocks.set(agent, {
      agent,
      rows: new Map(),
      totals: tokenTotals(),
      cacheWriteReporting: emptyCacheWriteReporting(),
    });
  }
  return blocks.get(agent);
}

function addAgentToolTokens(blocks, agent, tool, tokens, model, context) {
  const block = makeAgentToolBlock(blocks, agent);
  addTokenTotals(block.totals, tokens);
  addCacheWriteReporting(block.cacheWriteReporting, tokens);
  addToolTokens(toolUsageRow(block.rows, tool), tokens, model, context);
}

function publicAgentToolBlock(block) {
  const rows = [...block.rows.values()]
    .map(publicToolUsageRow)
    .sort((left, right) => right.total - left.total || right.calls - left.calls || left.tool.localeCompare(right.tool));
  const allocated = emptyTokenBuckets();
  for (const row of block.rows.values()) addTokenBuckets(allocated, toolUsageRowBuckets(row));
  return {
    agent: block.agent,
    rows,
    totals: { ...block.totals },
    cacheWriteReporting: { ...block.cacheWriteReporting },
    conservation: tokenConservation(block.totals, allocated),
  };
}

function buildToolUsage(
  activeMessagesBySession,
  activePartsBySession,
  sessionById,
  summaryTokens,
  summaryCacheWriteReporting,
) {
  const rows = new Map();
  const byAgent = new Map();
  const partsByMessage = new Map();
  const activeMessagesByKey = new Map();
  const methods = { stepFinish: 0, messageTools: 0, noTool: 0, noTokens: 0, nonAssistant: 0 };

  for (const [sessionId, messages] of activeMessagesBySession.entries()) {
    for (const message of messages) {
      const key = messageKey(sessionId, message.id);
      if (key) activeMessagesByKey.set(key, message);
    }
  }

  for (const [sessionId, parts] of activePartsBySession.entries()) {
    for (const part of parts) {
      const key = messageKey(sessionId, part.messageId);
      if (key) {
        if (!partsByMessage.has(key)) partsByMessage.set(key, []);
        partsByMessage.get(key).push(part);
      }
      const name = toolName(part.data);
      if (name !== null) {
        const row = toolUsageRow(rows, name);
        row.calls += 1;
        if (hasError(part.data)) row.errors += 1;
        const parentMessage = key ? activeMessagesByKey.get(key) : null;
        const agent = fillIdentity(sessionById.get(String(sessionId)), parentMessage?.data, part.data).agent;
        const agentRow = toolUsageRow(makeAgentToolBlock(byAgent, agent).rows, name);
        agentRow.calls += 1;
        if (hasError(part.data)) agentRow.errors += 1;
      }
    }
  }

  for (const [sessionId, messages] of activeMessagesBySession.entries()) {
    const session = sessionById.get(String(sessionId));
    const sessionModel = partialIdentity(session).model;
    for (const message of messages) {
      const data = message.data;
      const tokens = tokensFrom(data);
      if (!tokens) {
        methods.noTokens += 1;
        continue;
      }
      const messageParts = partsByMessage.get(messageKey(sessionId, message.id)) ?? [];
      const tools = messageParts.filter((part) => toolName(part.data) !== null);
      const assistant = dataRole(data) === "assistant" || dataRole(data) === "";
      const messageModel = partialIdentity(data).model;
      const model = messageModel && messageModel !== "unknown" ? messageModel : sessionModel;
      const fullEstimate = estimateMessageCost(model, tokens);
      const context = fullEstimate?.context;
      const baseAgent = fillIdentity(session, data).agent;
      const addAllocation = (tool, value, agent = baseAgent) => {
        addToolTokens(toolUsageRow(rows, tool), value, model, context);
        addAgentToolTokens(byAgent, agent, tool, value, model, context);
      };

      if (!assistant) {
        methods.nonAssistant += 1;
        addAllocation(UNATTRIBUTED_TOOL, tokens);
        continue;
      }
      if (!tools.length) {
        methods.noTool += 1;
        addAllocation(UNATTRIBUTED_TOOL, tokens);
        continue;
      }

      const segmented = stepGroups(messageParts);
      if (segmented && equalTokenBuckets(segmented.total, tokens)) {
        methods.stepFinish += 1;
        for (const group of segmented.groups) {
          if (!group.tools.length) {
            addAllocation(UNATTRIBUTED_TOOL, group.tokens);
            continue;
          }
          const shares = splitTokens(group.tokens, group.tools.length);
          for (let index = 0; index < group.tools.length; index += 1) {
            const part = group.tools[index];
            const agent = fillIdentity(session, data, part.data).agent;
            addAllocation(toolName(part.data), shares[index], agent);
          }
        }
      } else {
        methods.messageTools += 1;
        const shares = splitTokens(tokens, tools.length);
        for (let index = 0; index < tools.length; index += 1) {
          const part = tools[index];
          const agent = fillIdentity(session, data, part.data).agent;
          addAllocation(toolName(part.data), shares[index], agent);
        }
      }
    }
  }

  const publicRows = [...rows.values()]
    .map(publicToolUsageRow)
    .sort((left, right) => right.total - left.total || right.calls - left.calls || left.tool.localeCompare(right.tool));
  const allocated = emptyTokenBuckets();
  for (const row of rows.values()) addTokenBuckets(allocated, toolUsageRowBuckets(row));
  return {
    rows: publicRows,
    byAgent: [...byAgent.values()]
      .map(publicAgentToolBlock)
      .sort((left, right) => right.totals.total - left.totals.total || left.agent.localeCompare(right.agent)),
    cacheWriteReporting: { ...(summaryCacheWriteReporting ?? emptyCacheWriteReporting()) },
    conservation: tokenConservation(summaryTokens, allocated),
    method: "step-start→tools→step-finish when conserved; otherwise all message tools",
    methods,
  };
}

function addToAggregates(aggregates, session, messages, parts, messageById, range, options) {
  const baseIdentity = primaryGroup(session, messages, parts);
  addSessionRun(aggregateFor(aggregates, baseIdentity), session, messages, parts, range);

  for (const row of messages) {
    const target = aggregateFor(aggregates, messageGroup(row.data, baseIdentity));
    addMessageRow(target, row.data);
  }

  const seenFiles = new Set();
  let metadataFiles = 0;
  for (const row of parts) {
    const parentMessage = messageById.get(String(row.messageId ?? ""));
    const target = aggregateFor(
      aggregates,
      partGroup(row.data, parentMessage?.data, baseIdentity),
    );
    addPartRow(target, row.data);
    const delta = fileMetadataDelta(row.data, session.id, seenFiles);
    metadataFiles += delta.files;
    target.files.additions += delta.additions;
    target.files.deletions += delta.deletions;
  }

  if (metadataFiles === 0 && range.from === null && range.to === null && options.sessionSummaryFallback !== false) {
    const delta = sessionSummaryDelta(session);
    const target = aggregateFor(aggregates, baseIdentity);
    target.files.additions += delta.additions;
    target.files.deletions += delta.deletions;
  }
}

function emptySummary() {
  return {
    runs: 0,
    subagents: 0,
    tokens: emptyTokens(),
    cacheWriteReporting: emptyCacheWriteReporting(),
    cost: 0,
    estimatedCost: emptyEstimatedCost(),
    tools: 0,
    toolBreakdown: {},
    reads: 0,
    errors: 0,
    durationMs: 0,
    files: { additions: 0, deletions: 0 },
  };
}

function summarize(groups) {
  const summary = emptySummary();
  for (const group of groups) {
    summary.runs += group.runs;
    summary.subagents += group.subagents;
    addTokens(summary.tokens, group.tokens);
    summary.cacheWriteReporting.observed += group.cacheWriteReporting.observed;
    summary.cacheWriteReporting.samples += group.cacheWriteReporting.samples;
    summary.cost += group.cost;
    summary.estimatedCost.usd += group.estimatedCost.usd;
    for (const key of Object.keys(summary.estimatedCost.components)) {
      summary.estimatedCost.components[key] += group.estimatedCost.components[key];
    }
    summary.estimatedCost.coverage.priced += group.estimatedCost.coverage.priced;
    summary.estimatedCost.coverage.unpriced += group.estimatedCost.coverage.unpriced;
    summary.tools += group.tools;
    for (const [tool, count] of Object.entries(group.toolBreakdown)) {
      summary.toolBreakdown[tool] = (summary.toolBreakdown[tool] ?? 0) + count;
    }
    summary.reads += group.reads;
    summary.errors += group.errors;
    summary.durationMs += group.durationMs;
    summary.files.additions += group.files.additions;
    summary.files.deletions += group.files.deletions;
  }
  return summary;
}

function cleanGroup(aggregate) {
  const { _sessions: ignored, toolBreakdown, ...group } = aggregate;
  return {
    ...group,
    toolBreakdown: Object.fromEntries([...toolBreakdown.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function rootIdFor(sessionId, sessionById) {
  const seen = new Set();
  let current = sessionById.get(sessionId);
  while (current?.parentId && sessionById.has(current.parentId) && !seen.has(current.id)) {
    seen.add(current.id);
    current = sessionById.get(current.parentId);
  }
  return current?.id ?? sessionId;
}

function canonicalVerdict(value) {
  const verdict = String(value ?? "").trim().toUpperCase();
  return verdict === "PASS" ? "PASS" : verdict === "ISSUE" ? "ISSUE" : "UNKNOWN";
}

function reviewerRows(sessions, messagesBySession, partsBySession, sessionById, range, includedSessionIds = null) {
  const messageById = new Map();
  for (const messages of messagesBySession.values()) {
    for (const message of messages) messageById.set(String(message.id), message);
  }
  const reviewers = [];
  for (const session of sessions) {
    const messages = messagesBySession.get(session.id) ?? [];
    const parts = partsBySession.get(session.id) ?? [];
    const baseIdentity = primaryGroup(session, messages, parts);
    const identities = [
      baseIdentity,
      agentModel(session),
      ...messages.map((message) => agentModel(message.data)),
      ...parts.map((part) => agentModel(part.data)),
      ...messages.map((message) => messageGroup(message.data, baseIdentity)),
      ...parts.map((part) => partGroup(part.data, messageById.get(String(part.messageId ?? ""))?.data, baseIdentity)),
    ];
    if (!identities.some((identity) => identity.agent === "luna-reviewer")) continue;
    reviewers.push({
      rootId: rootIdFor(session.id, sessionById),
      sessionId: session.id,
      session,
      messages,
      parts,
      start: rowStart(session),
    });
  }

  const slots = new Map();
  return reviewers
    .sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER) ||
      String(a.sessionId).localeCompare(String(b.sessionId)))
    .map((reviewer) => {
      const slot = (slots.get(reviewer.rootId) ?? 0) + 1;
      slots.set(reviewer.rootId, slot);
      if (includedSessionIds && !includedSessionIds.has(String(reviewer.sessionId))) return null;
      if (!activeInRange(reviewer.session.createdAt, reviewer.session.updatedAt, range)) return null;
      const activeMessages = reviewer.messages.filter((row) => activeInRange(row.createdAt, row.updatedAt, range));
      const activeParts = reviewer.parts.filter((row) => activeInRange(row.createdAt, row.updatedAt, range));
      const candidates = [];
      for (const message of activeMessages) {
        if (dataRole(message.data) === "assistant" || dataRole(message.data) === "") {
          for (const text of textValues(message.data)) candidates.push({ time: rowStart(message), text });
        }
      }
      for (const part of activeParts) {
        const data = part.data;
        const type = String(objectValue(data, ["type"]) ?? "").toLowerCase();
        if (type === "text" || type === "") {
          for (const text of textValues(data)) candidates.push({ time: rowStart(part), text });
        }
      }
      candidates.sort((a, b) => (a.time ?? Number.MAX_SAFE_INTEGER) - (b.time ?? Number.MAX_SAFE_INTEGER));
      let verdict = null;
      for (const candidate of candidates) verdict = parseVerdict(candidate.text) ?? verdict;
      return { rootId: reviewer.rootId, sessionId: reviewer.sessionId, slot, verdict: canonicalVerdict(verdict) };
    })
    .filter(Boolean);
}

export function reviewerSummary(reviewers) {
  const categories = ["PASS", "ISSUE", "UNKNOWN"];
  const counts = Object.fromEntries(categories.map((category) => [category, 0]));
  for (const reviewer of reviewers) counts[canonicalVerdict(reviewer.verdict)] += 1;
  const total = reviewers.length;
  const rates = Object.fromEntries(categories.map((category) => [category, total ? counts[category] / total : 0]));
  const byRoot = new Map();
  for (const reviewer of reviewers) {
    if (!byRoot.has(reviewer.rootId)) byRoot.set(reviewer.rootId, []);
    byRoot.get(reviewer.rootId).push(reviewer);
  }
  const secondAfterFirstPass = { eligible: 0, pass: 0, issue: 0, unknown: 0, rate: 0 };
  for (const slots of byRoot.values()) {
    slots.sort((a, b) => a.slot - b.slot);
    const first = slots.find((slot) => slot.slot === 1);
    const second = slots.find((slot) => slot.slot === 2);
    if (first?.verdict !== "PASS" || !second) continue;
    secondAfterFirstPass.eligible += 1;
    const secondVerdict = canonicalVerdict(second.verdict).toLowerCase();
    if (secondVerdict === "pass" || secondVerdict === "issue" || secondVerdict === "unknown") {
      secondAfterFirstPass[secondVerdict] += 1;
    }
  }
  if (secondAfterFirstPass.eligible) {
    secondAfterFirstPass.rate = secondAfterFirstPass.issue / secondAfterFirstPass.eligible;
  }
  const bySlot = {};
  for (const reviewer of reviewers) {
    const slot = String(reviewer.slot);
    if (!bySlot[slot]) bySlot[slot] = { total: 0, counts: { PASS: 0, ISSUE: 0, UNKNOWN: 0 }, rates: {} };
    const bucket = bySlot[slot];
    const verdict = canonicalVerdict(reviewer.verdict);
    bucket.total += 1;
    bucket.counts[verdict] += 1;
  }
  for (const bucket of Object.values(bySlot)) {
    bucket.rates = Object.fromEntries(categories.map((category) => [
      category,
      bucket.total ? bucket.counts[category] / bucket.total : 0,
    ]));
  }
  return {
    total,
    counts,
    rates,
    verdicts: categories.map((verdict) => ({ verdict, count: counts[verdict] })),
    bySlot,
    secondAfterFirstPass,
    secondAfterFirstPassIssueRate: secondAfterFirstPass.rate,
  };
}

function zeroResult(schema, range, options = {}) {
  const hasSelection = options.session !== undefined && options.session !== null && String(options.session) !== "";
  const summary = emptySummary();
  return {
    schema: publicSchema(schema),
    range,
    sessionOptions: [],
    scope: {
      mode: hasSelection ? "session" : "all",
      selectedAlias: null,
      metadata: null,
      found: !hasSelection,
      count: 0,
    },
    summary,
    pricing: publicPricing(summary.estimatedCost),
    groups: [],
    toolUsage: emptyToolUsage(),
    reviewerSummary: reviewerSummary([]),
    privacy: {
      aggregateOnly: true,
      rawText: false,
      rawPaths: false,
      databaseWritable: false,
      sessionTitlesIncluded: options.includeSessionTitles === true,
    },
  };
}

function publicSchema(schema) {
  const { _details: ignored, ...publicValue } = schema;
  return publicValue;
}

export function aggregateRows(rows, options = {}, schema = {
  ok: true,
  tables: {},
  capabilities: {},
  missing: [],
}) {
  const range = normalizeRange(options);
  const sessions = (rows.sessions ?? []).map((row) => ({
    ...row,
    id: row.id === undefined || row.id === null ? row.id : String(row.id),
    parentId: row.parentId === undefined || row.parentId === null || row.parentId === "" ? null : String(row.parentId),
    summary: parseJson(row.summary),
    data: undefined,
  })).sort(rowSort);
  const messages = (rows.messages ?? []).map((row) => ({
    ...row,
    id: row.id === undefined || row.id === null ? row.id : String(row.id),
    sessionId: row.sessionId === undefined || row.sessionId === null ? row.sessionId : String(row.sessionId),
    messageId: row.messageId === undefined || row.messageId === null ? row.messageId : String(row.messageId),
    data: parseJson(row.data),
  })).sort(rowSort);
  const parts = (rows.parts ?? []).map((row) => ({
    ...row,
    id: row.id === undefined || row.id === null ? row.id : String(row.id),
    sessionId: row.sessionId === undefined || row.sessionId === null ? row.sessionId : String(row.sessionId),
    messageId: row.messageId === undefined || row.messageId === null ? row.messageId : String(row.messageId),
    data: parseJson(row.data),
  })).sort(rowSort);
  const sessionById = new Map(sessions.filter((row) => row.id !== undefined && row.id !== null).map((row) => [String(row.id), row]));
  const catalog = sessionCatalog(sessions, options);
  const scopeInfo = resolveSessionScope(sessions, catalog, options.session);
  const messageById = new Map(messages.filter((row) => row.id !== undefined && row.id !== null).map((row) => [String(row.id), row]));
  const messagesBySession = new Map();
  for (const message of messages) {
    const sessionId = String(message.sessionId ?? "");
    if (!sessionId) continue;
    if (!messagesBySession.has(sessionId)) messagesBySession.set(sessionId, []);
    messagesBySession.get(sessionId).push(message);
  }
  const partsBySession = new Map();
  for (const part of parts) {
    const parentMessage = messageById.get(String(part.messageId ?? ""));
    const directSessionId = part.sessionId === undefined || part.sessionId === null || part.sessionId === ""
      ? null
      : String(part.sessionId);
    const sessionId = directSessionId ?? String(parentMessage?.sessionId ?? "");
    if (!sessionId) continue;
    if (!partsBySession.has(sessionId)) partsBySession.set(sessionId, []);
    partsBySession.get(sessionId).push(part);
  }

  const includedSessions = sessions
    .filter((session) => !scopeInfo.apply || scopeInfo.ids.has(String(session.id)))
    .filter((session) => activeInRange(session.createdAt, session.updatedAt, range));
  const activeMessagesBySession = new Map();
  const activePartsBySession = new Map();
  const aggregates = new Map();
  for (const session of includedSessions) {
    const sessionMessages = (messagesBySession.get(String(session.id)) ?? [])
      .filter((row) => activeInRange(row.createdAt, row.updatedAt, range));
    const sessionParts = (partsBySession.get(String(session.id)) ?? [])
      .filter((row) => activeInRange(row.createdAt, row.updatedAt, range));
    activeMessagesBySession.set(String(session.id), sessionMessages);
    activePartsBySession.set(String(session.id), sessionParts);
    addToAggregates(aggregates, session, sessionMessages, sessionParts, messageById, range, options);
  }

  const groups = [...aggregates.values()]
    .map(cleanGroup)
    .sort((a, b) => b.runs - a.runs || b.tokens.total - a.tokens.total || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
  const summary = summarize(groups);
  const reviewerAttributions = reviewerRows(
    sessions,
    messagesBySession,
    partsBySession,
    sessionById,
    range,
    scopeInfo.apply ? scopeInfo.ids : null,
  );
  const toolUsage = buildToolUsage(
    activeMessagesBySession,
    activePartsBySession,
    sessionById,
    summary.tokens,
    summary.cacheWriteReporting,
  );
  return {
    schema: publicSchema(schema),
    range,
    sessionOptions: catalog.map(({ option }) => option),
    scope: {
      mode: scopeInfo.mode,
      selectedAlias: scopeInfo.selectedAlias,
      metadata: scopeInfo.metadata,
      found: scopeInfo.found,
      count: scopeInfo.count,
    },
    summary,
    groups,
    pricing: publicPricing(summary.estimatedCost),
    toolUsage,
    reviewerSummary: reviewerSummary(reviewerAttributions),
    privacy: {
      aggregateOnly: true,
      rawText: false,
      rawPaths: false,
      databaseWritable: false,
      sessionTitlesIncluded: options.includeSessionTitles === true,
    },
  };
}

export function computeMetrics(db, options = {}) {
  const schema = inspectSchema(db);
  const range = normalizeRange(options);
  if (!schema.ok) return zeroResult(schema, range, options);
  return aggregateRows(readDatabaseRows(db, schema), options, schema);
}

export function databaseCandidates() {
  const home = homedir();
  const dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
  return [...new Set([
    process.env.OPENCODE_DB_PATH,
    join(dataHome, "opencode", "opencode.db"),
    join(localAppData, "opencode", "opencode.db"),
    join(appData, "opencode", "opencode.db"),
    join(home, ".opencode", "opencode.db"),
  ].filter(Boolean).map((path) => resolve(path)))];
}

export function resolveDatabasePath(explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  return databaseCandidates().find((path) => existsSync(path)) ?? databaseCandidates()[0];
}

export function openReadOnlyDatabase(path = resolveDatabasePath()) {
  return new DatabaseSync(path, { readOnly: true });
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function renderCliSummary(metrics) {
  const summary = metrics.summary;
  const lines = [
    `Range: ${metrics.range.label}`,
    `Runs: ${formatNumber(summary.runs)}  Subagents: ${formatNumber(summary.subagents)}`,
    `Tokens: ${formatNumber(summary.tokens.total)}  Input: ${formatNumber(summary.tokens.input)}  Output: ${formatNumber(summary.tokens.output)}`,
    `Estimated API $: ${formatNumber(summary.estimatedCost.usd)}  Pricing coverage: ${formatNumber(summary.estimatedCost.coverage.priced)}/${formatNumber(summary.estimatedCost.coverage.priced + summary.estimatedCost.coverage.unpriced)}`,
    `Tools: ${formatNumber(summary.tools)}  Reads: ${formatNumber(summary.reads)}  Errors: ${formatNumber(summary.errors)}`,
    `Duration: ${formatNumber(summary.durationMs / 1000)}s  Files +${formatNumber(summary.files.additions)} / -${formatNumber(summary.files.deletions)}`,
    `Reviewer slots: ${formatNumber(metrics.reviewerSummary.total)}`,
  ];
  if (!metrics.schema.ok) lines.push(`Schema unavailable: ${metrics.schema.missing.join(", ") || "required capability"}`);
  return lines.join("\n");
}

function parseCli(argv) {
  const options = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--db") options.dbPath = argv[++index];
    else if (argument.startsWith("--db=")) options.dbPath = argument.slice(5);
    else if (argument === "--range") options.range = argv[++index];
    else if (argument.startsWith("--range=")) options.range = argument.slice(8);
    else if (argument === "--session") options.session = argv[++index];
    else if (argument.startsWith("--session=")) options.session = argument.slice(10);
    else if (argument === "--from") options.from = argv[++index];
    else if (argument.startsWith("--from=")) options.from = argument.slice(7);
    else if (argument === "--to") options.to = argv[++index];
    else if (argument.startsWith("--to=")) options.to = argument.slice(5);
    else if (!argument.startsWith("-") && !options.dbPath) options.dbPath = argument;
  }
  return { options, json };
}

export async function runCli(argv = process.argv.slice(2)) {
  const { options, json } = parseCli(argv);
  const path = resolveDatabasePath(options.dbPath);
  let db;
  try {
    db = openReadOnlyDatabase(path);
    const metrics = computeMetrics(db, options);
    process.stdout.write(`${json ? JSON.stringify(metrics, null, 2) : renderCliSummary(metrics)}\n`);
    return metrics.schema.ok ? 0 : 2;
  } catch {
    process.stderr.write("Unable to open a readable OpenCode database.\n");
    return 1;
  } finally {
    try {
      db?.close();
    } catch {
      // The process is ending; there is no useful recovery action here.
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli();
}
