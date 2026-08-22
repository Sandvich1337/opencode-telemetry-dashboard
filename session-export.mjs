import { createHash } from "node:crypto";

import {
  aggregateRows,
  sessionAlias,
  TABLES,
  TABLE_SPECS,
} from "./metrics.mjs";

export const EXPORT_HEADER = "session-contents-v1";
export const BUNDLE_SCHEMA_VERSION = 1;
export const EXPORT_FILES = Object.freeze([
  "manifest.json",
  "raw/sessions.json",
  "raw/messages.json",
  "raw/parts.json",
  "timeline.json",
  "metrics.json",
  "transcript.json",
]);

const RAW_FILE_BY_TABLE = Object.freeze({
  session: "raw/sessions.json",
  message: "raw/messages.json",
  part: "raw/parts.json",
});
const ENTITY_RANK = Object.freeze({ session: 0, message: 1, part: 2 });
const SESSION_PARENT_CANDIDATES = Object.freeze(["parent_id", "parentID", "parent"]);
const TIME_CANDIDATES = Object.freeze({
  createdAt: ["time_created", "created_at", "createdAt", "created", "timestamp"],
  updatedAt: ["time_updated", "updated_at", "updatedAt", "updated"],
});
const TEXT_FIELDS = Object.freeze(["text", "content", "message"]);

class ExportFailure extends Error {
  constructor(message = "unsupported session export") {
    super(message);
    this.name = "ExportFailure";
  }
}

function fail(message) {
  throw new ExportFailure(message);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function codeUnitCompare(left, right) {
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite value");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") fail("unsupported value");
  const result = Object.create(null);
  for (const key of Object.keys(value).sort(codeUnitCompare)) {
    Object.defineProperty(result, key, {
      value: canonicalize(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tableColumns(db, table) {
  let rows;
  try {
    rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  } catch {
    fail("unsupported schema");
  }
  if (!Array.isArray(rows) || rows.length === 0) fail("unsupported schema");
  return rows.map((row, index) => ({
    cid: Number(row.cid ?? index),
    name: String(row.name ?? ""),
    declaredType: String(row.type ?? ""),
    notNull: Number(row.notnull ?? 0) === 1,
    defaultValue: row.dflt_value === undefined || row.dflt_value === null ? null : String(row.dflt_value),
    primaryKey: Number(row.pk ?? 0),
  })).map((column) => {
    if (!column.name) fail("unsupported schema");
    return column;
  });
}

function chooseColumn(columns, candidates, required = true) {
  const matches = [];
  for (const candidate of candidates) {
    const normalized = normalizedKey(candidate);
    const exact = columns.find((column) => column.name.toLowerCase() === String(candidate).toLowerCase());
    const match = exact ?? columns.find((column) => normalizedKey(column.name) === normalized);
    if (match && !matches.some((entry) => entry.name === match.name)) matches.push(match);
    if (exact) break;
  }
  if (matches.length > 1) fail("ambiguous schema");
  if (!matches.length && required) fail("unsupported schema");
  return matches[0]?.name ?? null;
}

function describeExportSchema(db) {
  const details = {};
  for (const table of TABLES) {
    const columns = tableColumns(db, table);
    const spec = TABLE_SPECS[table];
    const aliases = {};
    for (const [alias, candidates] of Object.entries(spec.columns)) {
      aliases[alias] = chooseColumn(columns, candidates, spec.required.includes(alias));
    }
    aliases.parentId = table === "session"
      ? chooseColumn(columns, SESSION_PARENT_CANDIDATES, true)
      : aliases.parentId ?? null;
    details[table] = {
      table,
      columns,
      aliases,
      indexes: Object.fromEntries(columns.map((column, index) => [column.name, index])),
    };
  }
  return details;
}

function encodeCell(value, storageClass) {
  if (storageClass === "null") return { type: "null", value: null };
  if (storageClass === "integer") {
    if (typeof value === "bigint") return { type: "integer", value: String(value) };
    if (typeof value === "number" && Number.isSafeInteger(value)) return { type: "integer", value: String(value) };
    fail("lossless integer unavailable");
  }
  if (storageClass === "real") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail("unsupported real");
    return { type: "real", value: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (storageClass === "text") {
    if (typeof value !== "string") fail("unsupported text");
    return { type: "text", value };
  }
  if (storageClass === "blob") {
    if (!(value instanceof Uint8Array)) fail("unsupported blob");
    return { type: "blob", value: Buffer.from(value).toString("base64") };
  }
  fail("unsupported storage class");
}

function readTypedTable(db, detail) {
  const fields = [];
  detail.columns.forEach((column, index) => {
    const valueAlias = `__session_export_value_${index}`;
    const typeAlias = `__session_export_type_${index}`;
    fields.push(`${quoteIdentifier(column.name)} AS ${quoteIdentifier(valueAlias)}`);
    fields.push(`typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(typeAlias)}`);
  });
  let statement;
  try {
    statement = db.prepare(`SELECT ${fields.join(", ")} FROM ${quoteIdentifier(detail.table)}`);
    statement.setReadBigInts?.(true);
    const rows = statement.all();
    return rows.map((row) => ({
      cells: detail.columns.map((_column, index) => encodeCell(
        row[`__session_export_value_${index}`],
        String(row[`__session_export_type_${index}`] ?? ""),
      )),
    }));
  } catch (error) {
    if (error instanceof ExportFailure) throw error;
    fail("unable to read session snapshot");
  }
}

function cellAt(row, detail, columnName) {
  if (!columnName) return null;
  const index = detail.indexes[columnName];
  return index === undefined ? null : row.cells[index];
}

function decodedCell(cell) {
  if (!cell || cell.type === "null") return null;
  if (cell.type === "integer") {
    const number = Number(cell.value);
    return Number.isSafeInteger(number) ? number : cell.value;
  }
  if (cell.type === "real") return Number(cell.value);
  if (cell.type === "blob") return Uint8Array.from(Buffer.from(cell.value, "base64"));
  return cell.value;
}

function scalarValue(cell, { allowNull = true } = {}) {
  if (!cell || cell.type === "null") {
    if (allowNull) return null;
    fail("malformed selected row");
  }
  if (!["text", "integer", "real"].includes(cell.type)) fail("unsupported identifier");
  const value = String(cell.value);
  if (!value) {
    if (allowNull) return null;
    fail("malformed selected row");
  }
  return value;
}

function cellForAlias(row, detail, alias) {
  return cellAt(row, detail, detail.aliases[alias]);
}

function idValue(row, detail) {
  return scalarValue(cellForAlias(row, detail, "id"), { allowNull: false });
}

function parentValue(row, detail) {
  return scalarValue(cellForAlias(row, detail, "parentId"));
}

function sortRows(rows, detail) {
  return [...rows].sort((left, right) => {
    const leftId = idValue(left, detail);
    const rightId = idValue(right, detail);
    return codeUnitCompare(leftId, rightId) || codeUnitCompare(rowDigest(left), rowDigest(right));
  });
}

function rowDigest(row) {
  return sha256(JSON.stringify(row.cells));
}

function ensureUniqueIds(rows, detail) {
  const seen = new Set();
  for (const row of rows) {
    const id = idValue(row, detail);
    if (seen.has(id)) fail("duplicate row identifier");
    seen.add(id);
  }
  return seen;
}

function readSnapshot(db) {
  const schema = describeExportSchema(db);
  const rows = {};
  for (const table of TABLES) rows[table] = readTypedTable(db, schema[table]);
  const sessionIds = ensureUniqueIds(rows.session, schema.session);
  const messageIds = ensureUniqueIds(rows.message, schema.message);
  const partIds = ensureUniqueIds(rows.part, schema.part);
  const aliases = new Map();
  for (const row of rows.session) {
    const id = idValue(row, schema.session);
    const alias = sessionAlias(id);
    const previous = aliases.get(alias);
    if (previous && previous !== id) fail("ambiguous session alias");
    aliases.set(alias, id);
  }
  if (!sessionIds.size || !messageIds || !partIds) fail("unsupported snapshot");

  const sessionsById = new Map(rows.session.map((row) => [idValue(row, schema.session), row]));
  const childrenByParent = new Map();
  for (const row of rows.session) {
    const parent = parentValue(row, schema.session);
    if (parent === null) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(idValue(row, schema.session));
  }
  for (const children of childrenByParent.values()) children.sort(codeUnitCompare);
  return { schema, rows, aliases, sessionsById, childrenByParent };
}

function selectedTree(snapshot, requestedAlias) {
  if (!/^[0-9a-f]{16}$/.test(String(requestedAlias ?? ""))) fail("invalid root selection");
  const rootId = snapshot.aliases.get(String(requestedAlias));
  if (!rootId) fail("unknown root selection");
  const root = snapshot.sessionsById.get(rootId);
  if (parentValue(root, snapshot.schema.session) !== null) fail("selected session is not a root");
  const ids = [];
  const visited = new Set();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    ids.push(id);
    for (const child of snapshot.childrenByParent.get(id) ?? []) pending.push(child);
  }
  return { rootId, ids, idSet: new Set(ids), ordinal: new Map(ids.map((id, index) => [id, index])) };
}

function selectedRows(snapshot, tree) {
  const { rows, schema } = snapshot;
  const sessions = sortRows(rows.session.filter((row) => tree.idSet.has(idValue(row, schema.session))), schema.session);
  const allMessages = sortRows(rows.message, schema.message);
  const includedMessages = allMessages.filter((row) => tree.idSet.has(scalarValue(cellForAlias(row, schema.message, "sessionId"))));
  const messageById = new Map(includedMessages.map((row) => [idValue(row, schema.message), row]));
  const allParts = sortRows(rows.part, schema.part);
  const includedParts = [];
  for (const row of allParts) {
    const directSessionId = scalarValue(cellForAlias(row, schema.part, "sessionId"));
    const messageId = scalarValue(cellForAlias(row, schema.part, "messageId"));
    const linkedMessage = messageId ? messageById.get(messageId) : null;
    if (directSessionId !== null) {
      if (tree.idSet.has(directSessionId)) {
        if (messageId && linkedMessage) {
          const messageSessionId = scalarValue(cellForAlias(linkedMessage, schema.message, "sessionId"));
          if (messageSessionId !== directSessionId) fail("cross-tree part relation");
        } else if (messageId) {
          const anyMessage = rows.message.find((candidate) => idValue(candidate, schema.message) === messageId);
          if (anyMessage && scalarValue(cellForAlias(anyMessage, schema.message, "sessionId")) !== directSessionId) fail("cross-tree part relation");
        }
        includedParts.push(row);
      } else if (linkedMessage) {
        fail("cross-tree part relation");
      }
    } else if (linkedMessage) {
      includedParts.push(row);
    }
  }
  return { sessions, messages: includedMessages, parts: includedParts, messageById };
}

function rawTable(detail, rows) {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    table: detail.table,
    columns: detail.columns,
    rowEncoding: { values: "typed", order: "columns" },
    rows: rows.map((row) => row.cells),
  };
}

function rawRef(table, index, row) {
  return { path: RAW_FILE_BY_TABLE[table], row: index, sha256: rowDigest(row) };
}

function dataText(row, detail) {
  const cell = cellForAlias(row, detail, "data");
  if (!cell || cell.type === "null") return null;
  if (cell.type === "text") return cell.value;
  if (cell.type === "blob") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(cell.value, "base64"));
    } catch {
      return { invalidUtf8: true };
    }
  }
  return null;
}

function parseData(row, detail) {
  const text = dataText(row, detail);
  if (text && typeof text === "object" && text.invalidUtf8 === true) return { value: null, anomaly: "data-invalid-utf8" };
  if (text === null || !text.trim()) return { value: null, anomaly: "data-missing" };
  try {
    return { value: JSON.parse(text), anomaly: null };
  } catch {
    return { value: null, anomaly: "data-invalid-json" };
  }
}

function jsonPointer(pointer, key) {
  return `${pointer}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function textSegments(value, pointer) {
  const segments = [];
  const add = (text, sourcePointer) => {
    if (typeof text === "string") segments.push({ kind: "text", text, source: { pointer: sourcePointer } });
  };
  if (!value || typeof value !== "object") return segments;
  for (const field of TEXT_FIELDS) {
    if (typeof value[field] === "string") add(value[field], jsonPointer(pointer, field));
  }
  if (Array.isArray(value.content)) {
    value.content.forEach((item, index) => {
      if (typeof item === "string") add(item, jsonPointer(jsonPointer(pointer, "content"), index));
      else if (item && typeof item === "object" && item.type === "text") add(item.text, jsonPointer(jsonPointer(pointer, "content"), index) + "/text");
    });
  }
  return segments;
}

function explicitProjection(row, detail, table, ref) {
  const parsed = parseData(row, detail);
  const value = parsed.value;
  const pointer = "/data";
  const segments = textSegments(value, pointer);
  const result = {
    id: idValue(row, detail),
    rawRef: ref,
    type: typeof value?.type === "string" ? value.type : null,
    role: typeof value?.role === "string" ? value.role : null,
    tool: typeof value?.tool === "string" ? value.tool : null,
    segments,
    anomalies: [],
  };
  if (parsed.anomaly) result.anomalies.push(parsed.anomaly);
  if (!segments.length && !parsed.anomaly) result.anomalies.push("unsupported-content-shape");
  if (table === "message") {
    result.sessionId = scalarValue(cellForAlias(row, detail, "sessionId"));
  } else {
    result.sessionId = scalarValue(cellForAlias(row, detail, "sessionId"));
    result.messageId = scalarValue(cellForAlias(row, detail, "messageId"));
    if (typeof value?.state?.status === "string") result.status = value.state.status;
  }
  return result;
}

function numberTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timeEvidence(row, detail, parsed) {
  const evidence = [];
  const anomalies = [];
  const fields = [
    ["created", chooseColumn(detail.columns, TIME_CANDIDATES.createdAt, false)],
    ["updated", chooseColumn(detail.columns, TIME_CANDIDATES.updatedAt, false)],
  ];
  for (const [kind, column] of fields) {
    if (!column) continue;
    const cell = cellAt(row, detail, column);
    const original = decodedCell(cell);
    if (original === null) continue;
    const normalizedMs = numberTime(original);
    if (normalizedMs === null) anomalies.push(`time-invalid-${kind}`);
    else evidence.push({ kind, source: `row.${column}`, original, normalizedMs });
  }
  if (parsed && typeof parsed === "object") {
    for (const [kind, keys] of [["created", ["createdAt", "timeCreated"]], ["updated", ["updatedAt", "timeUpdated"]]]) {
      for (const key of keys) {
        if (!Object.hasOwn(parsed, key)) continue;
        const normalizedMs = numberTime(parsed[key]);
        if (normalizedMs === null) anomalies.push(`time-invalid-${kind}`);
        else evidence.push({ kind, source: `data.${key}`, original: parsed[key], normalizedMs });
        break;
      }
    }
  }
  return { evidence, anomalies };
}

function timelineRecord(table, row, detail, ref, tree, sessionIdOverride = null) {
  const parsed = parseData(row, detail).value;
  const times = timeEvidence(row, detail, parsed);
  const created = times.evidence.find((item) => item.kind === "created");
  const updated = times.evidence.find((item) => item.kind === "updated");
  return {
    entity: table,
    id: idValue(row, detail),
    rawRef: ref,
    provenance: "sqlite-snapshot",
    treeOrdinal: tree.ordinal.get(table === "session"
      ? idValue(row, detail)
      : sessionIdOverride ?? scalarValue(cellForAlias(row, detail, "sessionId"))) ?? null,
    time: {
      startMs: created?.normalizedMs ?? null,
      endMs: updated?.normalizedMs ?? null,
      evidence: times.evidence,
    },
    anomalies: [...times.anomalies, ...(created || updated ? [] : ["time-missing"])],
  };
}

function sortTimeline(records) {
  return [...records].sort((left, right) => {
    const leftPrimary = left.time.startMs === null || left.time.startMs === undefined
      ? Number.POSITIVE_INFINITY : left.time.startMs;
    const rightPrimary = right.time.startMs === null || right.time.startMs === undefined
      ? Number.POSITIVE_INFINITY : right.time.startMs;
    return (leftPrimary - rightPrimary)
      || ((left.time.endMs ?? Number.POSITIVE_INFINITY) - (right.time.endMs ?? Number.POSITIVE_INFINITY))
      || ((left.treeOrdinal ?? Number.POSITIVE_INFINITY) - (right.treeOrdinal ?? Number.POSITIVE_INFINITY))
      || (ENTITY_RANK[left.entity] - ENTITY_RANK[right.entity])
      || codeUnitCompare(left.id, right.id)
      || codeUnitCompare(left.rawRef.sha256, right.rawRef.sha256);
  });
}

function buildTranscript(captured, snapshot, refs) {
  const messages = captured.messages.map((row) => {
    const id = idValue(row, snapshot.schema.message);
    const record = explicitProjection(row, snapshot.schema.message, "message", refs.message.get(id));
    record.parts = [];
    return record;
  });
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  const unattachedParts = [];
  for (const row of captured.parts) {
    const id = idValue(row, snapshot.schema.part);
    const record = explicitProjection(row, snapshot.schema.part, "part", refs.part.get(id));
    const messageId = record.messageId;
    const message = messageId ? byMessage.get(messageId) : null;
    if (message) message.parts.push(record);
    else unattachedParts.push(record);
  }
  for (const message of messages) message.parts.sort((left, right) => codeUnitCompare(left.id, right.id));
  unattachedParts.sort((left, right) => codeUnitCompare(left.id, right.id));
  return { schemaVersion: BUNDLE_SCHEMA_VERSION, messages, unattachedParts };
}

function metricsRows(captured, snapshot) {
  const convert = (table, row) => {
    const detail = snapshot.schema[table];
    const aliases = TABLE_SPECS[table].columns;
    const result = {};
    for (const alias of Object.keys(aliases)) {
      const column = detail.aliases[alias];
      if (column) result[alias] = decodedCell(cellAt(row, detail, column));
    }
    return result;
  };
  return {
    sessions: captured.sessions.map((row) => convert("session", row)),
    messages: captured.messages.map((row) => convert("message", row)),
    parts: captured.parts.map((row) => convert("part", row)),
  };
}

function metricsSchema(snapshot) {
  const tables = Object.fromEntries(TABLES.map((table) => [table, {
    present: true,
    usable: true,
    missing: [],
  }]));
  const capabilities = {
    session: true,
    message: true,
    part: true,
    timestamps: TABLES.every((table) => Boolean(snapshot.schema[table].aliases.createdAt || snapshot.schema[table].aliases.updatedAt)),
    sessionHierarchy: Boolean(snapshot.schema.session.aliases.parentId),
    messageData: Boolean(snapshot.schema.message.aliases.data),
    partData: Boolean(snapshot.schema.part.aliases.data),
    toolMetadata: Boolean(snapshot.schema.part.aliases.data),
    fileMetadata: Boolean(snapshot.schema.part.aliases.data),
    reviewerVerdicts: Boolean(snapshot.schema.message.aliases.data || snapshot.schema.part.aliases.data),
  };
  return { ok: true, tables, capabilities, missing: [] };
}

function coverageAnomalies(timeline, transcript) {
  return [
    ...timeline.flatMap((record) => record.anomalies),
    ...transcript.messages.flatMap((record) => [
      ...record.anomalies,
      ...record.parts.flatMap((part) => part.anomalies),
    ]),
    ...transcript.unattachedParts.flatMap((record) => record.anomalies),
  ].sort(codeUnitCompare).filter((value, index, values) => index === 0 || value !== values[index - 1]);
}

function boundsForTimeline(timeline) {
  const values = timeline.flatMap((record) => [record.time.startMs, record.time.endMs]).filter((value) => Number.isFinite(value));
  if (!values.length) return { earliest: null, latest: null };
  return { earliest: Math.min(...values), latest: Math.max(...values) };
}

function makeFile(path, value) {
  const content = canonicalJson(value);
  return {
    path,
    mediaType: "application/json; charset=utf-8",
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
    content,
  };
}

function getDataVersion(db) {
  try {
    const value = db.prepare("PRAGMA data_version").get().data_version;
    if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
    return value;
  } catch {
    fail("database unavailable");
  }
}

function buildSessionExportInTransaction(db, requestedAlias) {
  const snapshot = readSnapshot(db);
  const tree = selectedTree(snapshot, requestedAlias);
  const captured = selectedRows(snapshot, tree);
  const rawValues = {
    sessions: rawTable(snapshot.schema.session, captured.sessions),
    messages: rawTable(snapshot.schema.message, captured.messages),
    parts: rawTable(snapshot.schema.part, captured.parts),
  };
  const rawFiles = {
    "raw/sessions.json": makeFile("raw/sessions.json", rawValues.sessions),
    "raw/messages.json": makeFile("raw/messages.json", rawValues.messages),
    "raw/parts.json": makeFile("raw/parts.json", rawValues.parts),
  };
  const refs = { session: new Map(), message: new Map(), part: new Map() };
  for (const [table, list] of [["session", captured.sessions], ["message", captured.messages], ["part", captured.parts]]) {
    const ordered = table === "session" ? captured.sessions : table === "message" ? captured.messages : captured.parts;
    ordered.forEach((row, index) => refs[table].set(idValue(row, snapshot.schema[table]), rawRef(table, index, row)));
    if (list.length !== refs[table].size) fail("row coverage mismatch");
  }
  const timeline = sortTimeline([
    ...captured.sessions.map((row) => timelineRecord("session", row, snapshot.schema.session, refs.session.get(idValue(row, snapshot.schema.session)), tree)),
    ...captured.messages.map((row) => timelineRecord("message", row, snapshot.schema.message, refs.message.get(idValue(row, snapshot.schema.message)), tree)),
    ...captured.parts.map((row) => {
      const directSessionId = scalarValue(cellForAlias(row, snapshot.schema.part, "sessionId"));
      const messageId = scalarValue(cellForAlias(row, snapshot.schema.part, "messageId"));
      const message = messageId ? captured.messages.find((candidate) => idValue(candidate, snapshot.schema.message) === messageId) : null;
      const sessionId = directSessionId ?? (message ? scalarValue(cellForAlias(message, snapshot.schema.message, "sessionId")) : null);
      return timelineRecord("part", row, snapshot.schema.part, refs.part.get(idValue(row, snapshot.schema.part)), tree, sessionId);
    }),
  ]);
  if (timeline.length !== captured.sessions.length + captured.messages.length + captured.parts.length) fail("timeline coverage mismatch");
  const transcript = buildTranscript(captured, snapshot, refs);
  const transcriptPartIds = new Set([
    ...transcript.messages.flatMap((message) => message.parts.map((part) => part.id)),
    ...transcript.unattachedParts.map((part) => part.id),
  ]);
  if (transcript.messages.length !== captured.messages.length || transcriptPartIds.size !== captured.parts.length) fail("transcript coverage mismatch");
  const normalizedRows = metricsRows(captured, snapshot);
  const aggregate = aggregateRows(normalizedRows, { range: "all", session: requestedAlias, now: 0 }, metricsSchema(snapshot));
  const metrics = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    scope: { range: "all", mode: "root-tree", selectedAlias: requestedAlias, count: captured.sessions.length },
    basis: { source: "captured-sqlite-rows", scope: "all-time", observed: true, derived: true, estimated: true, unavailable: false },
    aggregate,
  };
  const timelineFile = makeFile("timeline.json", { schemaVersion: BUNDLE_SCHEMA_VERSION, events: timeline });
  const metricsFile = makeFile("metrics.json", metrics);
  const transcriptFile = makeFile("transcript.json", transcript);
  const bounds = boundsForTimeline(timeline);
  const anomalies = coverageAnomalies(timeline, transcript);
  const manifest = {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: "opencode-session-contents",
    filename: `opencode-session-contents-${requestedAlias}.zip`,
    selected: { alias: requestedAlias, id: tree.rootId, parentId: null, kind: "root" },
    tree: { rootId: tree.rootId, sessionIds: tree.ids, sessionCount: captured.sessions.length },
    counts: {
      sessions: captured.sessions.length,
      messages: captured.messages.length,
      parts: captured.parts.length,
      timeline: timeline.length,
      transcriptMessages: transcript.messages.length,
      transcriptParts: transcriptPartIds.size,
      unattachedParts: transcript.unattachedParts.length,
    },
    sqlite: { dataVersion: getDataVersion(db), persistedTimeBounds: bounds },
    source: { kind: "sqlite", tables: ["session", "message", "part"], readOnly: true },
    coverage: {
      mode: "snapshot-only",
      runtimeSnapshot: { included: true, consistency: "single-sqlite-read-transaction" },
      liveTelemetry: { included: false, reason: "not-connected" },
    },
    derivation: {
      raw: "SELECT * typed rows from the captured tables",
      timeline: "explicit SQLite row and persisted JSON time fields only",
      transcript: "explicit persisted role, type, tool, and text fields only",
      metrics: "aggregate derivation over the exact captured rows with range=all",
      unknowns: "missing, invalid, unsupported, retry-like, and causal semantics remain unknown",
    },
    anomalies,
    ordering: {
      objects: "recursive UTF-16 code-unit key order",
      rows: "identifier then raw-row SHA-256",
      timeline: "start/end time, tree ordinal, entity rank, identifier, raw-row SHA-256",
      trailingLf: true,
    },
    files: [rawFiles["raw/sessions.json"], rawFiles["raw/messages.json"], rawFiles["raw/parts.json"], timelineFile, metricsFile, transcriptFile]
      .map(({ path, mediaType, bytes, sha256: digest }) => ({ path, mediaType, bytes, sha256: digest })),
  };
  const manifestFile = makeFile("manifest.json", manifest);
  const files = [manifestFile, rawFiles["raw/sessions.json"], rawFiles["raw/messages.json"], rawFiles["raw/parts.json"], timelineFile, metricsFile, transcriptFile];
  if (files.length !== EXPORT_FILES.length || files.some((file, index) => file.path !== EXPORT_FILES[index])) fail("bundle file coverage mismatch");
  return { bundleSchemaVersion: BUNDLE_SCHEMA_VERSION, filename: manifest.filename, files };
}

export function buildSessionExport(db, requestedAlias) {
  let transactionStarted = false;
  try {
    db.exec("BEGIN");
    transactionStarted = true;
    const value = buildSessionExportInTransaction(db, requestedAlias);
    db.exec("COMMIT");
    transactionStarted = false;
    return value;
  } finally {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Rollback is best effort after a failed read.
      }
    }
  }
}

export function isExportHeader(value) {
  return value === EXPORT_HEADER;
}

export { ExportFailure };
