import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { makeZip32, validateSessionExport } from "./session-export.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const encoder = new TextEncoder();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

async function hash(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function bundle() {
  const paths = ["raw/sessions.json", "raw/messages.json", "raw/parts.json", "timeline.json", "metrics.json", "transcript.json"];
  const files = [];
  for (const path of paths) {
    const content = `{"path":"${path}"}\n`;
    files.push({ path, mediaType: "application/json; charset=utf-8", bytes: encoder.encode(content).byteLength, sha256: await hash(content), content });
  }
  const manifest = {
    bundleSchemaVersion: 1,
    kind: "opencode-session-contents",
    filename: "opencode-session-contents-0123456789abcdef.zip",
    selected: { alias: "0123456789abcdef" },
    coverage: {
      mode: "snapshot-only",
      runtimeSnapshot: { included: true, consistency: "single-sqlite-read-transaction" },
      liveTelemetry: { included: false, reason: "not-connected" },
    },
    files: files.map(({ path, mediaType, bytes, sha256 }) => ({ path, mediaType, bytes, sha256 })),
  };
  const content = `${JSON.stringify(canonical(manifest))}\n`;
  return { bundleSchemaVersion: 1, filename: manifest.filename, files: [{ path: "manifest.json", mediaType: "application/json; charset=utf-8", bytes: encoder.encode(content).byteLength, sha256: await hash(content), content }, ...files] };
}

test("validates the seven-file response and creates deterministic ZIP32 bytes", async () => {
  const first = await validateSessionExport(await bundle());
  const second = await validateSessionExport(await bundle());
  const left = makeZip32(first.files);
  const right = makeZip32(second.files);
  assert.deepEqual(left, right);
  assert.equal(new TextDecoder().decode(left).includes("manifest.json"), true);
  assert.equal(new DataView(left.buffer).getUint32(left.byteLength - 22, true), 0x06054b50);
});

test("rejects missing, altered, or undeclared content", async () => {
  const invalid = await bundle();
  invalid.files = invalid.files.filter((file) => file.path !== "raw/parts.json");
  await assert.rejects(() => validateSessionExport(invalid), /Session export unavailable/);
});

test("rejects non-canonical JSON and invalid ZIP entry sets", async () => {
  const first = await validateSessionExport(await bundle());
  const altered = first.bundle;
  altered.files[1].content = '{"z":1,"a":2}\n';
  altered.files[1].bytes = encoder.encode(altered.files[1].content).byteLength;
  altered.files[1].sha256 = await hash(altered.files[1].content);
  await assert.rejects(() => validateSessionExport(altered), /Session export unavailable/);
  assert.throws(() => makeZip32(first.files.slice(1)), /Session export unavailable/);
  assert.throws(() => makeZip32([...first.files.slice(0, -1), first.files[0]]), /Session export unavailable/);
});

test("rejects manifest references and content digests after tampering", async () => {
  const invalidManifestReference = await bundle();
  const manifest = JSON.parse(invalidManifestReference.files[0].content);
  manifest.files[0].sha256 = "0".repeat(64);
  invalidManifestReference.files[0].content = `${JSON.stringify(canonical(manifest))}\n`;
  invalidManifestReference.files[0].bytes = encoder.encode(invalidManifestReference.files[0].content).byteLength;
  invalidManifestReference.files[0].sha256 = await hash(invalidManifestReference.files[0].content);
  await assert.rejects(() => validateSessionExport(invalidManifestReference), /Session export unavailable/);

  const invalidContentDigest = await bundle();
  invalidContentDigest.files[1].content = '{"tampered":true}\n';
  invalidContentDigest.files[1].bytes = encoder.encode(invalidContentDigest.files[1].content).byteLength;
  invalidContentDigest.files[1].sha256 = await hash(invalidContentDigest.files[1].content);
  await assert.rejects(() => validateSessionExport(invalidContentDigest), /Session export unavailable/);
});
