export const EXPORT_HEADER = "session-contents-v1";
export const EXPORT_PATHS = Object.freeze([
  "manifest.json",
  "raw/sessions.json",
  "raw/messages.json",
  "raw/parts.json",
  "timeline.json",
  "metrics.json",
  "transcript.json",
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
  const encoded = JSON.stringify(canonicalize(value));
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
  if (!isObject(bundle) || bundle.bundleSchemaVersion !== 1 || !Array.isArray(bundle.files)) fail();
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
  if (!isObject(manifest) || manifest.bundleSchemaVersion !== 1 || manifest.kind !== "opencode-session-contents") fail();
  if (manifest.filename !== bundle.filename || manifest.coverage?.mode !== "snapshot-only") fail();
  if (manifest.coverage?.runtimeSnapshot?.included !== true
    || manifest.coverage?.runtimeSnapshot?.consistency !== "single-sqlite-read-transaction"
    || manifest.coverage?.liveTelemetry?.included !== false
    || manifest.coverage?.liveTelemetry?.reason !== "not-connected") fail();
  if (!Array.isArray(manifest.files) || manifest.files.length !== 6) fail();
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
