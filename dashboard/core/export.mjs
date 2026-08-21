/**
 * Pure, client-side export helpers for the public aggregate dashboard payload.
 *
 * Environment inventory remains explicitly allow-listed here.  The full JSON
 * export applies a recursive deny-list as defense in depth when a caller
 * supplies an object that did not come from the server's public sanitizer.
 */

export const EXPORT_SCHEMA_VERSION = 1;
export const exportSchemaVersion = EXPORT_SCHEMA_VERSION;
export const JSON_MIME = "application/json;charset=utf-8";
export const CSV_MIME = "text/csv;charset=utf-8";

const INVENTORY_KEYS = Object.freeze(["agents", "models", "tools", "capabilities", "unknown"]);
const ENTRY_TYPES = new Set(["agent", "model", "tool", "capability", "unknown"]);
const SAFE_WORD = /^[a-z0-9][a-z0-9._ -]{0,95}$/i;
const SAFE_CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DANGEROUS_TEXT = /(?:https?|file|ftp):|(?:^|\s)www\.|[\\/]|[;&|<>$`]|(?:^|\s)(?:bash|cmd|curl|node|npm|powershell|python|rm|sh|sudo|wget)(?:\s|$)|(?:api[ _-]*key|access[ _-]*token|auth(?:orization)?|bearer|cookie|csrf|client[ _-]*secret|password|passwd|private[ _-]*key|secret|session[ _-]*token|process[ ._-]*env|environment[ _-]*value|header|payload|prompt|command|args?|token|\benv\b)/i;
const DANGEROUS_PUBLIC_KEY = /(?:^|[_-])(?:api[_-]?keys?|access[_-]?tokens?|auth(?:orization)?|auth[_-]?headers?|bearers?|cookies?|csrf|client[_-]?secrets?|passwords?|passwd|private[_-]?(?:keys?|paths?)|source[_-]?paths?|file[_-]?paths?|secrets?|session[_-]?tokens?|process[_-]?env|environment[_-]?values?|headers?|header[_-]?values?|prompts?|commands?|command[_-]?lines?|args?|paths?|urls?|uris?|payloads?|env(?:[_-]?values?|ironment[_-]?values?)?)(?:$|[_-])/i;
const DANGEROUS_PUBLIC_VALUE = /(?:https?|file|ftp):|(?:^|\s)www\.|[\\/]|[;&|<>$`]|(?:^|\s)(?:bash|cmd|curl|node|npm|powershell|python|rm|sh|sudo|wget)(?:\s+\S+)+|(?:api[ _-]*key|access[ _-]*token|auth(?:orization)?|bearer|cookie|csrf|client[ _-]*secret|password|passwd|private[ _-]*key|secret|session[ _-]*token|process[ ._-]*env|environment[ _-]*value|header|prompt|command|args?)(?:\s|[:=]|$)/i;
const PUBLIC_ALIAS = /^(?:agent|model|tool|run)-\d{3}$|^(?:agent|model|tool|run)-unknown$|^[0-9a-f]{16}$/i;
const SAFE_CODES = new Set([
  "observed", "reported", "derived", "estimated", "inferred", "unavailable", "unknown",
  "telemetry", "caller", "snapshot", "explicit", "configured", "inventory-present", "missing", "present",
  "startup-opt-in-required", "request-opt-in-required", "disabled", "no-runs", "no-positive-denominator",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function own(value, key) {
  if (!isRecord(value)) return undefined;
  try {
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function number(value, fallback = 0) {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.floor(number(value, fallback)));
}

function safeText(value, fallback = "unknown") {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, 96);
  return text && SAFE_WORD.test(text) && !DANGEROUS_TEXT.test(text) ? text : fallback;
}

function safeCapability(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  return text && SAFE_CAPABILITY.test(text) && !DANGEROUS_TEXT.test(text) ? text : null;
}

function safeCode(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const text = value.trim().toLowerCase().replace(/\s+/g, "-");
  return SAFE_CODES.has(text) && !DANGEROUS_TEXT.test(value) ? text : fallback;
}

function safeType(value, fallback = "unknown") {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ENTRY_TYPES.has(type) ? type : fallback;
}

function environmentMode(value, fallback) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "configured" || mode === "observed" ? mode : fallback;
}

function sample(value) {
  const source = isRecord(value) ? value : {};
  const denominatorValue = own(source, "denominator");
  const denominator = denominatorValue === undefined || denominatorValue === null ? null : nonNegativeInteger(denominatorValue, 0);
  const count = nonNegativeInteger(own(source, "count"));
  const observed = Math.min(count, nonNegativeInteger(own(source, "observed")));
  return {
    count,
    observed,
    denominator,
    complete: denominator === null ? null : observed >= denominator,
  };
}

function evidence(value, fallbackAvailable = false, fallbackReason = "unavailable") {
  const source = isRecord(value) ? value : {};
  return {
    available: own(source, "available") === true || (!Object.prototype.hasOwnProperty.call(source, "available") && fallbackAvailable),
    basis: safeCode(own(source, "basis"), fallbackAvailable ? "observed" : "unavailable"),
    reason: safeCode(own(source, "reason"), fallbackReason),
    sample: sample(own(source, "sample")),
  };
}

function provenance(value, mode) {
  const source = isRecord(value) ? value : {};
  return {
    source: safeCode(own(source, "source"), mode === "configured" ? "caller" : "telemetry"),
    basis: safeCode(own(source, "basis"), mode === "configured" ? "unavailable" : "observed"),
    scope: safeCode(own(source, "scope"), mode === "configured" ? "unavailable" : "snapshot"),
  };
}

function confidence(value) {
  if (!isRecord(value)) return null;
  const result = number(own(value, "value"), NaN);
  return {
    value: Number.isFinite(result) ? Math.min(1, Math.max(0, result)) : null,
    basis: safeCode(own(value, "basis")),
    reason: safeCode(own(value, "reason")),
    sample: sample(own(value, "sample")),
  };
}

function capabilities(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const name = safeCapability(key);
    if (name) result[name] = own(value, key) === true;
  }
  return result;
}

function entry(value, fallbackType) {
  if (!isRecord(value)) return null;
  const type = safeType(own(value, "type"), fallbackType);
  return {
    name: safeText(own(value, "name")),
    type,
    version: safeText(own(value, "version")),
    available: own(value, "available") === true,
    capabilities: capabilities(own(value, "capabilities")),
    sample: sample(own(value, "sample")),
    provenance: safeCode(own(value, "provenance"), "unknown"),
  };
}

function entries(value, fallbackType) {
  const source = Array.isArray(value) ? value : [];
  return source.map((item) => entry(item, fallbackType)).filter(Boolean).sort((left, right) =>
    compareText(left.name, right.name) || compareText(left.type, right.type) || compareText(left.version, right.version) ||
    compareText(JSON.stringify(left.capabilities), JSON.stringify(right.capabilities)));
}

function unavailableInventory(mode, reason = "unavailable") {
  const availability = evidence({ available: false, basis: "unavailable", reason, sample: { count: 0, observed: 0, denominator: null } });
  return {
    mode,
    available: false,
    availability,
    sample: sample({ count: 0, observed: 0, denominator: null }),
    confidence: null,
    provenance: provenance({ source: mode === "configured" ? "caller" : "telemetry", basis: "unavailable", scope: reason }, mode),
    agents: [],
    models: [],
    tools: [],
    capabilities: [],
    unknown: [],
    coverage: {},
  };
}

function inventory(value, mode) {
  if (!isRecord(value)) return unavailableInventory(mode, "missing");
  const available = own(value, "available") === true;
  const result = {
    mode: environmentMode(own(value, "mode"), mode),
    available,
    availability: evidence(own(value, "availability"), available, available ? "inventory-present" : "unavailable"),
    sample: sample(own(value, "sample")),
    confidence: confidence(own(value, "confidence")),
    provenance: provenance(own(value, "provenance"), mode),
    agents: entries(own(value, "agents"), "agent"),
    models: entries(own(value, "models"), "model"),
    tools: entries(own(value, "tools"), "tool"),
    capabilities: entries(own(value, "capabilities"), "capability"),
    unknown: entries(own(value, "unknown"), "unknown"),
    coverage: {},
  };
  const rawCoverage = own(value, "coverage");
  if (isRecord(rawCoverage)) {
    for (const key of ["agents", "models", "tools", "schema"]) {
      if (Object.prototype.hasOwnProperty.call(rawCoverage, key)) result.coverage[key] = evidence(rawCoverage[key], available, "unavailable");
    }
  }
  return result;
}

function environmentSource(value) {
  const root = isRecord(value) ? value : {};
  const analytics = own(root, "analytics");
  const fromAnalytics = own(analytics, "environment");
  if (isRecord(fromAnalytics)) return fromAnalytics;
  const fromRoot = own(root, "environment");
  if (isRecord(fromRoot)) return fromRoot;
  return root;
}

/** Return only the public, aggregate environment shape. Sensitive fields are never copied. */
export function redactAggregatePayload(value, { includeConfigured = true } = {}) {
  const source = environmentSource(value);
  const configured = includeConfigured
    ? inventory(own(source, "configured"), "configured")
    : unavailableInventory("configured", "request-opt-in-required");
  return {
    observed: inventory(own(source, "observed"), "observed"),
    configured,
  };
}

export const redactEnvironmentPayload = redactAggregatePayload;

function identityKey(key) {
  return /(?:^|[_-])(?:id|ids|session[_-]?id|message[_-]?id|part[_-]?id|request[_-]?id|trace[_-]?id|user[_-]?id)(?:$|[_-])/i.test(key);
}

function aliasKey(key) {
  return /alias(?:es)?$/i.test(key);
}

function safePublicString(value) {
  if (typeof value !== "string") return value;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return DANGEROUS_PUBLIC_VALUE.test(text) ? null : text;
}

function publicEnvironmentPath(path, key) {
  return key === "environment" && (path.length === 0 || path[path.length - 1] === "analytics");
}

/** Preserve the public aggregate envelope while defensively removing private fields. */
export function redactPublicPayload(value, options = {}, path = [], seen = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return safePublicString(value);
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactPublicPayload(item, options, path, seen));
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (DANGEROUS_PUBLIC_KEY.test(key)) continue;
      const source = value[key];
      if (identityKey(key) && source !== null && (typeof source !== "string" || !PUBLIC_ALIAS.test(source))) continue;
      if (aliasKey(key) && source !== null && (typeof source !== "string" || !PUBLIC_ALIAS.test(source))) continue;
      if (publicEnvironmentPath(path, key) && isRecord(source)) {
        result[key] = redactAggregatePayload({ environment: source }, options);
        continue;
      }
      result[key] = redactPublicPayload(source, options, [...path, key], seen);
    }
    return result;
  } catch {
    return null;
  } finally {
    seen.delete(value);
  }
}

function normalizeForJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((item) => normalizeForJson(item, seen));
  else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      try { result[key] = normalizeForJson(value[key], seen); } catch { result[key] = null; }
    }
  }
  seen.delete(value);
  return result;
}

/** Deterministic JSON serialization that also handles cycles and non-finite values. */
export function stableStringify(value) {
  return JSON.stringify(normalizeForJson(value));
}

export function createJsonExport(payload, options = {}) {
  return {
    exportSchemaVersion: EXPORT_SCHEMA_VERSION,
    payload: redactPublicPayload(payload, options),
  };
}

export const makeJsonExport = createJsonExport;

export function serializeJsonExport(payload, options = {}) {
  return stableStringify(createJsonExport(payload, options));
}

export const serializeExport = serializeJsonExport;
export const serializeEnvironmentJson = serializeJsonExport;

function pathFor(parent, key) {
  return parent ? `${parent}.${key}` : String(key);
}

function normalizedObject(value) {
  return isRecord(value) ? value : null;
}

/** Generic deterministic recursive diff for redacted JSON-compatible values. */
export function diffValues(before, after, path = "") {
  const added = [];
  const removed = [];
  const changed = [];
  const walk = (left, right, currentPath) => {
    const leftObject = normalizedObject(left);
    const rightObject = normalizedObject(right);
    if (leftObject && rightObject) {
      const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
      for (const key of keys) {
        const childPath = pathFor(currentPath, key);
        const hasLeft = Object.prototype.hasOwnProperty.call(leftObject, key);
        const hasRight = Object.prototype.hasOwnProperty.call(rightObject, key);
        if (!hasLeft) added.push({ path: childPath, value: normalizeForJson(rightObject[key]) });
        else if (!hasRight) removed.push({ path: childPath, value: normalizeForJson(leftObject[key]) });
        else walk(leftObject[key], rightObject[key], childPath);
      }
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        const childPath = pathFor(currentPath, index);
        if (index >= left.length) added.push({ path: childPath, value: normalizeForJson(right[index]) });
        else if (index >= right.length) removed.push({ path: childPath, value: normalizeForJson(left[index]) });
        else walk(left[index], right[index], childPath);
      }
      return;
    }
    if (stableStringify(left) !== stableStringify(right)) {
      changed.push({ path: currentPath || "$", before: normalizeForJson(left), after: normalizeForJson(right) });
    }
  };
  walk(before, after, path);
  return { added, removed, changed, hasChanges: Boolean(added.length || removed.length || changed.length) };
}

function principalKey(row) {
  return [row.inventory, row.type, row.name, row.version].join("\u0000");
}

function capabilitiesText(value) {
  return stableStringify(value ?? {});
}

/** Flatten the inventory into deterministic principal rows for table/CSV use. */
export function principalRows(payload, { includeConfigured = true } = {}) {
  const environment = redactAggregatePayload(payload, { includeConfigured });
  const rows = [];
  for (const inventoryName of ["observed", "configured"]) {
    const source = environment[inventoryName];
    for (const key of INVENTORY_KEYS) {
      for (const item of source[key]) {
        rows.push({
          inventory: inventoryName,
          type: item.type,
          name: item.name,
          version: item.version,
          available: item.available,
          sampleCount: item.sample.count,
          sampleObserved: item.sample.observed,
          sampleDenominator: item.sample.denominator,
          capabilities: capabilitiesText(item.capabilities),
        });
      }
    }
  }
  return rows.sort((left, right) => compareText(principalKey(left), principalKey(right)));
}

export const principalTableRows = principalRows;

export const PRINCIPAL_CSV_COLUMNS = Object.freeze([
  "inventory", "type", "name", "version", "available", "sampleCount", "sampleObserved", "sampleDenominator", "capabilities",
]);
export const CSV_COLUMNS = PRINCIPAL_CSV_COLUMNS;

function spreadsheetSafe(value) {
  const text = String(value ?? "");
  return /^[\t ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

export function csvEscape(value) {
  const text = spreadsheetSafe(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvColumn(column) {
  if (typeof column === "string" && column) return { key: column, header: column };
  if (!isRecord(column)) return null;
  const key = typeof column.key === "string" && column.key ? column.key : typeof column.name === "string" && column.name ? column.name : null;
  if (!key) return null;
  return { key, header: typeof column.header === "string" ? column.header : key };
}

function csvValue(value) {
  return value !== null && typeof value === "object" ? stableStringify(value) : value;
}

/** Deterministic RFC4180-style CSV for explicit rows and columns. */
export function serializeCsv(rows = [], columns = []) {
  const specs = (Array.isArray(columns) ? columns : []).map(csvColumn).filter(Boolean);
  const sourceRows = Array.isArray(rows) ? rows : [];
  const lines = [specs.map(({ header }) => csvEscape(header)).join(",")];
  for (const row of sourceRows) {
    lines.push(specs.map(({ key }, index) => csvEscape(csvValue(Array.isArray(row) ? row[index] : isRecord(row) ? row[key] : ""))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Environment-inventory CSV; generic callers should use serializeCsv(rows, columns). */
export function serializeEnvironmentCsv(payload, options = {}) {
  return serializeCsv(principalRows(payload, options), PRINCIPAL_CSV_COLUMNS);
}

/** Backward-compatible environment-inventory name. */
export function serializePrincipalCsv(payload, options = {}) {
  return serializeEnvironmentCsv(payload, options);
}

function rowMap(payload, options) {
  const result = new Map();
  for (const row of principalRows(payload, options)) {
    const base = principalKey(row);
    let key = base;
    let occurrence = 2;
    while (result.has(key)) key = `${base}\u0000${occurrence++}`;
    result.set(key, row);
  }
  return result;
}

/** Compare current and saved redacted inventories by principal identity. */
export function diffEnvironmentBaseline(currentPayload, baselinePayload, options = {}) {
  const current = rowMap(currentPayload, options);
  const baseline = rowMap(baselinePayload, options);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, row] of current) {
    if (!baseline.has(key)) added.push({ key, after: row });
    else {
      const before = baseline.get(key);
      const fields = ["available", "sampleCount", "sampleObserved", "sampleDenominator", "capabilities"];
      if (fields.some((field) => before[field] !== row[field])) changed.push({ key, before, after: row });
    }
  }
  for (const [key, row] of baseline) if (!current.has(key)) removed.push({ key, before: row });
  const sort = (left, right) => compareText(left.key, right.key);
  added.sort(sort);
  removed.sort(sort);
  changed.sort(sort);
  return {
    available: isRecord(baselinePayload) || baselinePayload !== null && baselinePayload !== undefined,
    added,
    removed,
    changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    hasChanges: Boolean(added.length || removed.length || changed.length),
  };
}

export const diffBaseline = diffEnvironmentBaseline;
export const diffEnvironment = diffEnvironmentBaseline;

export function makeExportFilename(name = "environment", extension = ".json") {
  const suffix = extension === ".csv" ? ".csv" : ".json";
  let base = String(name ?? "environment").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop() || "environment";
  base = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "").slice(0, 80) || "environment";
  base = base.replace(/\.(?:json|csv)$/i, "");
  return `${base || "environment"}${suffix}`;
}

export const safeFilename = makeExportFilename;
export const filenameForExport = makeExportFilename;

export function createDownloadDescriptor(kind, payload, options = {}) {
  const csv = kind === "csv";
  return {
    filename: makeExportFilename(options.filename ?? (csv ? "environment-principals" : "environment"), csv ? ".csv" : ".json"),
    mime: csv ? CSV_MIME : JSON_MIME,
    content: csv ? serializeEnvironmentCsv(payload, options) : serializeJsonExport(payload, options),
  };
}

/** Optional browser download primitive; it is a no-op when browser APIs are absent. */
export function downloadText({ content, filename, mime }, documentRef = globalThis.document, urlRef = globalThis.URL) {
  if (!documentRef || typeof documentRef.createElement !== "function" || !urlRef || typeof urlRef.createObjectURL !== "function" || typeof globalThis.Blob !== "function") return false;
  const safeMime = mime === CSV_MIME ? CSV_MIME : mime === JSON_MIME ? JSON_MIME : "text/plain;charset=utf-8";
  const blob = new globalThis.Blob([String(content ?? "")], { type: safeMime });
  const url = urlRef.createObjectURL(blob);
  const link = documentRef.createElement("a");
  link.href = url;
  link.download = makeExportFilename(filename, safeMime === CSV_MIME ? ".csv" : ".json");
  link.rel = "noopener";
  if (typeof link.click !== "function") {
    if (typeof urlRef.revokeObjectURL === "function") urlRef.revokeObjectURL(url);
    return false;
  }
  link.click();
  if (typeof urlRef.revokeObjectURL === "function") urlRef.revokeObjectURL(url);
  return true;
}
