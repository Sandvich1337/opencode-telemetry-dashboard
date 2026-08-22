import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { makeZip32, validateSessionExport } from "./session-export.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const encoder = new TextEncoder();

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
    coverage: { mode: "snapshot-only", runtimeSnapshot: { included: true }, liveTelemetry: { included: false } },
    files: files.map(({ path, mediaType, bytes, sha256 }) => ({ path, mediaType, bytes, sha256 })),
  };
  const content = `${JSON.stringify(manifest)}\n`;
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
