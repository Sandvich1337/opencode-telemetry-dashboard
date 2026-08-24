export const EXPORT_HEADER = "session-contents-v2";
export const EXPORT_PATHS = Object.freeze([
  "manifest.json",
  "raw/sessions.json",
  "raw/messages.json",
  "raw/parts.json",
  "timeline.json",
  "metrics.json",
  "transcript.json",
  "chat.json",
]);

const textEncoder = new TextEncoder();
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const DOS_DATE = 0x0021;
const FIXED_EXTERNAL_ATTRIBUTES = 0x81b40000;

function fail() {
  throw new Error("Session export unavailable");
}

function codeUnitCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") fail();
  const result = Object.create(null);
  for (const key of Object.keys(value).sort(codeUnitCompare)) {
    Object.defineProperty(result, key, { value: canonicalize(value[key]), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function canonicalJson(value) {
  const encoded = JSON.stringify(canonicalize(value), null, 2);
  if (typeof encoded !== "string") fail();
  return `${encoded}\n`;
}

function parseCanonicalJson(content) {
  if (!content.endsWith("\n") || content.endsWith("\n\n")) fail();
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    fail();
  }
  if (canonicalJson(parsed) !== content) fail();
  return parsed;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(value) {
  return String(value).replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function identifierColumn(columns, kind) {
  const candidates = kind === "session"
    ? ["id", "session_id", "sessionId"]
    : kind === "message" ? ["id", "message_id", "messageId"] : ["id", "part_id", "partId"];
  for (const candidate of candidates) {
    const match = columns.find((column) => normalizedKey(column?.name) === normalizedKey(candidate));
    if (match) return columns.indexOf(match);
  }
  return -1;
}

async function validateSemanticRefs(value, rawTables) {
  const validateRawRef = async (ref, expectedKind = null) => {
    if (!isObject(ref) || Object.keys(ref).some((key) => !["path", "row", "sha256"].includes(key))
      || typeof ref.path !== "string" || !Number.isSafeInteger(ref.row) || ref.row < 0
      || !/^[0-9a-f]{64}$/.test(String(ref.sha256))) fail();
    const kind = Object.entries(rawTables).find(([, table]) => table.path === ref.path)?.[0];
    const table = kind ? rawTables[kind] : null;
    if (!table || (expectedKind && kind !== expectedKind) || ref.row >= table.rows.length) fail();
    const row = table.rows[ref.row];
    if (!Array.isArray(row) || await digest(textEncoder.encode(JSON.stringify(row))) !== ref.sha256) fail();
    return { kind, row };
  };
  const rawIdentity = (ref, kind) => [kind, ref.path, ref.row, ref.sha256];
  const sameRawIdentity = (left, right, kind) => {
    const a = rawIdentity(left, kind);
    const b = rawIdentity(right, kind);
    return a.every((value, index) => value === b[index]);
  };
  const equalRef = (left, right, kind) => isObject(left) && isObject(right)
    && left.kind === kind && right.kind === kind && left.id === right.id
    && left.sessionAlias === right.sessionAlias
    && sameRawIdentity(left.rawRef, right.rawRef, kind);
  const validateSemanticRef = async (current, expectedKind) => {
    if (!isObject(current) || !["session", "message", "part"].includes(current.kind)
      || (expectedKind && current.kind !== expectedKind)
      || typeof current.id !== "string" || !current.id
      || Object.keys(current).some((key) => !["kind", "id", "sessionAlias", "rawRef"].includes(key))
      || (Object.hasOwn(current, "sessionAlias") && (typeof current.sessionAlias !== "string" || !current.sessionAlias))) fail();
    const { kind, row } = await validateRawRef(current.rawRef, current.kind);
    const index = identifierColumn(rawTables[kind].columns, kind);
    const identifier = index >= 0 ? row[index] : null;
    if (!isObject(identifier) || identifier.type !== "text" || identifier.value !== current.id) fail();
    return current;
  };
  const validateProjection = async (projection, kind, alias) => {
    if (!isObject(projection) || typeof projection.id !== "string" || !projection.id
      || !isObject(projection.rawRef) || !isObject(projection.ref)
      || Object.keys(projection).some((key) => !["id", "rawRef", "ref", "type", "role", "tool", "segments", "anomalies", "sessionId", "messageId", "status", "toolCall", "parts"].includes(key))) fail();
    await validateRawRef(projection.rawRef, kind);
    await validateSemanticRef(projection.ref, kind);
    if (projection.ref.id !== projection.id || projection.ref.sessionAlias !== alias
      || !sameRawIdentity(projection.rawRef, projection.ref.rawRef, kind)) fail();
    if (Array.isArray(projection.parts)) {
      for (const part of projection.parts) await validateProjection(part, "part", alias);
    }
    if (projection.toolCall?.sources !== undefined) {
      if (!isObject(projection.toolCall.sources)) fail();
      for (const source of Object.values(projection.toolCall.sources)) {
        if (!isObject(source) || !isObject(source.rawRef)) fail();
        await validateRawRef(source.rawRef, kind === "part" ? "part" : "message");
        if (!sameRawIdentity(source.rawRef, projection.rawRef, kind)) fail();
      }
    }
  };
  if (!isObject(value) || value.kind !== "opencode-visible-chat" || value.schemaVersion !== 1
    || value.linkagePolicy !== "parent-session-only" || !isObject(value.sessionsByAlias)
    || !Array.isArray(value.sessionOrder) || !isObject(value.rootSessionRef)
    || Object.keys(value).some((key) => !["schemaVersion", "kind", "linkagePolicy", "rootSessionRef", "sessionOrder", "sessionsByAlias", "subagentDeepDives"].includes(key))) fail();
  if (new Set(value.sessionOrder).size !== value.sessionOrder.length
    || value.sessionOrder.some((alias) => typeof alias !== "string" || !isObject(value.sessionsByAlias[alias]))) fail();
  await validateSemanticRef(value.rootSessionRef, "session");
  const sessions = new Map();
  for (const alias of value.sessionOrder) {
    const session = value.sessionsByAlias[alias];
    if (!isObject(session) || !isObject(session.sessionRef) || !Array.isArray(session.messages)
      || !Array.isArray(session.unattachedParts) || !Array.isArray(session.childSessionRefs) || !isObject(session.deepDiveWindow)
      || !Array.isArray(session.deepDiveWindow.messages) || !Array.isArray(session.deepDiveWindow.unattachedParts)
      || Object.keys(session).some((key) => !["sessionRef", "parentSessionRef", "childSessionRefs", "messages", "unattachedParts", "deepDiveWindow"].includes(key))
     || session.deepDiveWindow.messages.length !== session.messages.length
     || session.deepDiveWindow.unattachedParts.length !== session.unattachedParts.length) fail();
    await validateSemanticRef(session.sessionRef, "session");
    if (session.sessionRef.sessionAlias !== alias || sessions.has(session.sessionRef.id)) fail();
    sessions.set(session.sessionRef.id, { alias, session });
    if (session.parentSessionRef !== null) {
      if (!isObject(session.parentSessionRef)) fail();
      await validateSemanticRef(session.parentSessionRef, "session");
    }
    for (const ref of session.childSessionRefs) await validateSemanticRef(ref, "session");
    for (const message of session.messages) await validateProjection(message, "message", alias);
    for (const part of session.unattachedParts) await validateProjection(part, "part", alias);
    await validateSemanticRef(session.deepDiveWindow.sessionRef, "session");
    if (!equalRef(session.deepDiveWindow.sessionRef, session.sessionRef, "session")) fail();
    for (let index = 0; index < session.messages.length; index++) {
      await validateSemanticRef(session.deepDiveWindow.messages[index], "message");
      if (!equalRef(session.deepDiveWindow.messages[index], session.messages[index].ref, "message")) fail();
    }
    for (let index = 0; index < session.unattachedParts.length; index++) {
      await validateSemanticRef(session.deepDiveWindow.unattachedParts[index], "part");
      if (!equalRef(session.deepDiveWindow.unattachedParts[index], session.unattachedParts[index].ref, "part")) fail();
    }
  }
  const root = sessions.get(value.rootSessionRef.id);
  if (!root || !equalRef(root.session.sessionRef, value.rootSessionRef, "session") || root.session.parentSessionRef !== null) fail();
  for (const { session } of sessions.values()) {
    const parentId = session.parentSessionRef?.id ?? null;
    const childIds = session.childSessionRefs.map((ref) => ref.id);
    if (new Set(childIds).size !== childIds.length) fail();
    for (const child of session.childSessionRefs) {
      const target = sessions.get(child.id);
      if (!target || !equalRef(target.session.sessionRef, child, "session")
        || !target.session.parentSessionRef || !equalRef(target.session.parentSessionRef, session.sessionRef, "session")) fail();
    }
    if (parentId !== null) {
      const parent = sessions.get(parentId);
      if (!parent || !parent.session.childSessionRefs.some((ref) => equalRef(ref, session.sessionRef, "session"))) fail();
    }
  }
  if (!Array.isArray(value.subagentDeepDives) || value.subagentDeepDives.length !== sessions.size - 1) fail();
  const dives = new Set();
  for (const dive of value.subagentDeepDives) {
      if (!isObject(dive) || !isObject(dive.sessionRef) || !isObject(dive.parentSessionRef)
        || dive.invocationRef !== null || !isObject(dive.window) || !Array.isArray(dive.assistantOutputRefs)
        || !Array.isArray(dive.window.messages) || !Array.isArray(dive.window.unattachedParts)) fail();
      await validateSemanticRef(dive.sessionRef, "session");
      await validateSemanticRef(dive.parentSessionRef, "session");
      await validateSemanticRef(dive.window.sessionRef, "session");
      const target = sessions.get(dive.sessionRef.id);
       if (!target || target.session.parentSessionRef === null || dives.has(dive.sessionRef.id)
         || !equalRef(dive.sessionRef, target.session.sessionRef, "session")
         || !equalRef(dive.parentSessionRef, target.session.parentSessionRef, "session")
        || !equalRef(dive.window.sessionRef, target.session.sessionRef, "session")
        || dive.window.messages.length !== target.session.messages.length
        || dive.window.unattachedParts.length !== target.session.unattachedParts.length) fail();
      dives.add(dive.sessionRef.id);
      for (let index = 0; index < dive.window.messages.length; index++) {
        const ref = dive.window.messages[index];
        await validateSemanticRef(ref, "message");
        if (!equalRef(ref, target.session.messages[index].ref, "message")) fail();
      }
      for (let index = 0; index < dive.window.unattachedParts.length; index++) {
        const ref = dive.window.unattachedParts[index];
        await validateSemanticRef(ref, "part");
        if (!equalRef(ref, target.session.unattachedParts[index].ref, "part")) fail();
      }
      for (const ref of dive.assistantOutputRefs) await validateSemanticRef(ref);
      const expectedOutputs = target.session.messages.filter((message) => message.role === "assistant").flatMap((message) => [
        ...message.segments.map(() => message.ref),
        ...message.parts.filter((part) => part.toolCall).map((part) => part.ref),
      ]);
      if (dive.assistantOutputRefs.length !== expectedOutputs.length
        || dive.assistantOutputRefs.some((ref, index) => !equalRef(ref, expectedOutputs[index], ref.kind))) fail();
    }
  if (dives.size !== sessions.size - 1 || dives.has(value.rootSessionRef.id)) fail();
}

function aliasFromFilename(filename) {
  const match = /^opencode-session-contents-([0-9a-f]{16})\.zip$/.exec(String(filename));
  return match?.[1] ?? null;
}

async function digest(bytes) {
  if (!globalThis.crypto?.subtle) fail();
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

export async function validateSessionExport(bundle) {
  if (!isObject(bundle) || bundle.bundleSchemaVersion !== 2 || !Array.isArray(bundle.files)) fail();
  if (bundle.files.length !== EXPORT_PATHS.length) fail();
  const filenameAlias = aliasFromFilename(bundle.filename);
  if (!filenameAlias || bundle.filename !== `opencode-session-contents-${filenameAlias}.zip`) fail();
  const byPath = new Map();
  for (const file of bundle.files) {
    if (!isObject(file) || typeof file.path !== "string" || typeof file.content !== "string" || byPath.has(file.path)) fail();
    if (!EXPORT_PATHS.includes(file.path) || file.mediaType !== "application/json; charset=utf-8") fail();
    const bytes = textEncoder.encode(file.content);
    if (!Number.isSafeInteger(file.bytes) || file.bytes !== bytes.byteLength) fail();
    if (!/^[0-9a-f]{64}$/.test(String(file.sha256))) fail();
    if (await digest(bytes) !== file.sha256) fail();
    parseCanonicalJson(file.content);
    byPath.set(file.path, { ...file, bytes: new Uint8Array(bytes) });
  }
  if (EXPORT_PATHS.some((path) => !byPath.has(path))) fail();
  const manifestBytes = byPath.get("manifest.json").bytes;
  const manifest = parseCanonicalJson(new TextDecoder().decode(manifestBytes));
  if (!isObject(manifest) || manifest.bundleSchemaVersion !== 2 || manifest.kind !== "opencode-session-contents") fail();
  if (manifest.filename !== bundle.filename || manifest.coverage?.mode !== "snapshot-only") fail();
  if (manifest.coverage?.runtimeSnapshot?.included !== true
    || manifest.coverage?.runtimeSnapshot?.consistency !== "single-sqlite-read-transaction"
    || manifest.coverage?.liveTelemetry?.included !== false
    || manifest.coverage?.liveTelemetry?.reason !== "not-connected") fail();
  if (!Array.isArray(manifest.files) || manifest.files.length !== 7) fail();
  const manifestPaths = new Set();
  const expectedManifestPaths = new Set(EXPORT_PATHS.slice(1));
  for (const declared of manifest.files) {
    const actual = byPath.get(declared?.path);
    if (manifestPaths.has(declared?.path) || !expectedManifestPaths.has(declared?.path)) fail();
    manifestPaths.add(declared.path);
    if (!actual || declared.mediaType !== actual.mediaType || declared.bytes !== actual.bytes.byteLength || declared.sha256 !== await digest(actual.bytes)) fail();
  }
  if (manifestPaths.size !== expectedManifestPaths.size || [...expectedManifestPaths].some((path) => !manifestPaths.has(path))) fail();
  if (manifest.selected?.alias !== filenameAlias) fail();
  const rawTables = {};
  for (const [kind, path] of [["session", "raw/sessions.json"], ["message", "raw/messages.json"], ["part", "raw/parts.json"]]) {
    const table = parseCanonicalJson(new TextDecoder().decode(byPath.get(path).bytes));
    if (!isObject(table) || !Array.isArray(table.columns) || !Array.isArray(table.rows)) fail();
    rawTables[kind] = { ...table, path };
  }
  const chat = parseCanonicalJson(new TextDecoder().decode(byPath.get("chat.json").bytes));
  await validateSemanticRefs(chat, rawTables);
  return { bundle, manifest, files: [...byPath.values()] };
}

export function makeZip32(bundle) {
  const inputFiles = Array.isArray(bundle) ? bundle : bundle?.files;
  if (!Array.isArray(inputFiles)) fail();
  if (inputFiles.length !== EXPORT_PATHS.length) fail();
  if (inputFiles.some((file) => !isObject(file) || typeof file.path !== "string")) fail();
  const files = [...inputFiles].sort((left, right) => codeUnitCompare(left.path, right.path));
  if (files.length > 0xffff) fail();
  if (files.some((file, index) => file?.path !== EXPORT_PATHS.slice().sort(codeUnitCompare)[index])) fail();
  const encoded = files.map((file) => {
    if (typeof file.path !== "string" || !EXPORT_PATHS.includes(file.path)
      || file.path.includes("\\") || file.path.startsWith("/") || file.path.split("/").some((part) => !part || part === "." || part === "..")) fail();
    const name = textEncoder.encode(file.path);
    const data = file.bytes instanceof Uint8Array
      ? file.bytes
      : typeof file.content === "string" ? textEncoder.encode(file.content) : null;
    if (!data) fail();
    if (name.byteLength > 0xffff || data.byteLength > 0xffffffff) fail();
    return { name, data, crc: crc32(data) };
  });
  let centralSize = 0;
  let localSize = 0;
  for (const file of encoded) {
    localSize += 30 + file.name.byteLength + file.data.byteLength;
    centralSize += 46 + file.name.byteLength;
  }
  const endSize = 22;
  if (!Number.isSafeInteger(localSize) || !Number.isSafeInteger(centralSize)
    || localSize > 0xffffffff || centralSize > 0xffffffff
    || !Number.isSafeInteger(localSize + centralSize + endSize)
    || localSize + centralSize + endSize > 0xffffffff) fail();
  const output = new Uint8Array(localSize + centralSize + endSize);
  const view = new DataView(output.buffer);
  const offsets = [];
  let offset = 0;
  for (const file of encoded) {
    offsets.push(offset);
    writeU32(view, offset, ZIP_LOCAL);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, 0);
    writeU16(view, offset + 8, 0);
    writeU16(view, offset + 10, 0);
    writeU16(view, offset + 12, DOS_DATE);
    writeU32(view, offset + 14, file.crc);
    writeU32(view, offset + 18, file.data.byteLength);
    writeU32(view, offset + 22, file.data.byteLength);
    writeU16(view, offset + 26, file.name.byteLength);
    writeU16(view, offset + 28, 0);
    output.set(file.name, offset + 30);
    output.set(file.data, offset + 30 + file.name.byteLength);
    offset += 30 + file.name.byteLength + file.data.byteLength;
  }
  const centralOffset = offset;
  encoded.forEach((file, index) => {
    writeU32(view, offset, ZIP_CENTRAL);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, 20);
    writeU16(view, offset + 8, 0);
    writeU16(view, offset + 10, 0);
    writeU16(view, offset + 12, 0);
    writeU16(view, offset + 14, DOS_DATE);
    writeU32(view, offset + 16, file.crc);
    writeU32(view, offset + 20, file.data.byteLength);
    writeU32(view, offset + 24, file.data.byteLength);
    writeU16(view, offset + 28, file.name.byteLength);
    writeU16(view, offset + 30, 0);
    writeU16(view, offset + 32, 0);
    writeU16(view, offset + 34, 0);
    writeU16(view, offset + 36, 0);
    writeU32(view, offset + 38, FIXED_EXTERNAL_ATTRIBUTES);
    writeU32(view, offset + 42, offsets[index]);
    output.set(file.name, offset + 46);
    offset += 46 + file.name.byteLength;
  });
  writeU32(view, offset, ZIP_END);
  writeU16(view, offset + 4, 0);
  writeU16(view, offset + 6, 0);
  writeU16(view, offset + 8, encoded.length);
  writeU16(view, offset + 10, encoded.length);
  writeU32(view, offset + 12, centralSize);
  writeU32(view, offset + 16, centralOffset);
  writeU16(view, offset + 20, 0);
  return output;
}

export async function fetchSessionExport(rootAlias, fetchImpl = globalThis.fetch) {
  if (!/^[0-9a-f]{16}$/.test(String(rootAlias ?? "")) || typeof fetchImpl !== "function") fail();
  const response = await fetchImpl(`/api/session-export?root=${encodeURIComponent(rootAlias)}`, {
    cache: "no-store",
    headers: { "X-OpenCode-Export": EXPORT_HEADER },
  });
  if (!response?.ok) fail();
  let payload;
  try { payload = await response.json(); } catch { fail(); }
  return validateSessionExport(payload);
}

export async function downloadSessionExport(validated, documentRef = globalThis.document, urlApi = globalThis.URL) {
  if (!validated?.bundle || !documentRef?.createElement || !urlApi?.createObjectURL) fail();
  const bytes = makeZip32(validated.files);
  const blob = new Blob([bytes], { type: "application/zip" });
  const objectUrl = urlApi.createObjectURL(blob);
  try {
    const link = documentRef.createElement("a");
    link.href = objectUrl;
    link.download = validated.bundle.filename;
    link.rel = "noopener";
    link.click();
  } finally {
    urlApi.revokeObjectURL?.(objectUrl);
  }
  return bytes;
}

export { crc32 };
