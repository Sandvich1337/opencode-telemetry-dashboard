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
  const paths = ["raw/sessions.json", "raw/messages.json", "raw/parts.json", "timeline.json", "metrics.json", "transcript.json", "chat.json"];
  const files = [];
  for (const path of paths) {
    const kind = path.includes("sessions") ? "session" : path.includes("messages") ? "message" : path.includes("parts") ? "part" : null;
    const contentValue = kind
      ? { columns: [{ name: "id" }], rows: [[{ type: "text", value: kind === "session" ? "root" : kind }]] }
      : { kind: "opencode-visible-chat" };
    const content = `${JSON.stringify(canonical(contentValue), null, 2)}\n`;
    files.push({ path, mediaType: "application/json; charset=utf-8", bytes: encoder.encode(content).byteLength, sha256: await hash(content), content });
  }
  const sessions = JSON.parse(files[0].content);
  const sessionRef = { kind: "session", id: "root", sessionAlias: "0123456789abcdef", rawRef: { path: "raw/sessions.json", row: 0, sha256: await hash(JSON.stringify(sessions.rows[0])) } };
  const messageRows = JSON.parse(files[1].content).rows;
  const partRows = JSON.parse(files[2].content).rows;
  const messageRef = { kind: "message", id: "message", sessionAlias: "0123456789abcdef", rawRef: { path: "raw/messages.json", row: 0, sha256: await hash(JSON.stringify(messageRows[0])) } };
  const partRef = { kind: "part", id: "part", sessionAlias: "0123456789abcdef", rawRef: { path: "raw/parts.json", row: 0, sha256: await hash(JSON.stringify(partRows[0])) } };
  const message = { id: "message", rawRef: messageRef.rawRef, ref: messageRef, parts: [{ id: "part", rawRef: partRef.rawRef, ref: partRef, parts: [] }] };
  const chat = { schemaVersion: 1, kind: "opencode-visible-chat", linkagePolicy: "parent-session-only", rootSessionRef: sessionRef,
    sessionOrder: ["0123456789abcdef"], sessionsByAlias: { "0123456789abcdef": {
      sessionRef, parentSessionRef: null, childSessionRefs: [], messages: [message], unattachedParts: [],
      deepDiveWindow: { kind: "whole-session", sessionRef, messages: [messageRef], unattachedParts: [] },
    } }, subagentDeepDives: [] };
  const chatContent = `${JSON.stringify(canonical(chat), null, 2)}\n`;
  files[6] = { path: "chat.json", mediaType: "application/json; charset=utf-8", bytes: encoder.encode(chatContent).byteLength, sha256: await hash(chatContent), content: chatContent };
  const manifest = {
    bundleSchemaVersion: 2,
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
  const content = `${JSON.stringify(canonical(manifest), null, 2)}\n`;
  return { bundleSchemaVersion: 2, filename: manifest.filename, files: [{ path: "manifest.json", mediaType: "application/json; charset=utf-8", bytes: encoder.encode(content).byteLength, sha256: await hash(content), content }, ...files] };
}

async function resignedChatBundle(change) {
  const invalid = await bundle();
  const chatFile = invalid.files.find((file) => file.path === "chat.json");
  const chat = JSON.parse(chatFile.content);
  change(chat);
  chatFile.content = `${JSON.stringify(canonical(chat), null, 2)}\n`;
  chatFile.bytes = encoder.encode(chatFile.content).byteLength;
  chatFile.sha256 = await hash(chatFile.content);
  const manifestFile = invalid.files[0];
  const manifest = JSON.parse(manifestFile.content);
  const declaration = manifest.files.find((file) => file.path === "chat.json");
  declaration.bytes = chatFile.bytes;
  declaration.sha256 = chatFile.sha256;
  manifestFile.content = `${JSON.stringify(canonical(manifest), null, 2)}\n`;
  manifestFile.bytes = encoder.encode(manifestFile.content).byteLength;
  manifestFile.sha256 = await hash(manifestFile.content);
  return invalid;
}

test("validates the eight-file response and creates deterministic ZIP32 bytes", async () => {
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

test("rejects internally re-signed semantic-reference tampering", async () => {
  const invalid = await bundle();
  const chatFile = invalid.files.find((file) => file.path === "chat.json");
  const chat = JSON.parse(chatFile.content);
  chat.rootSessionRef.rawRef.row = 0;
  chat.rootSessionRef.id = "wrong";
  chatFile.content = `${JSON.stringify(canonical(chat), null, 2)}\n`;
  chatFile.bytes = encoder.encode(chatFile.content).byteLength;
  chatFile.sha256 = await hash(chatFile.content);
  const manifestFile = invalid.files[0];
  const manifest = JSON.parse(manifestFile.content);
  const declaration = manifest.files.find((file) => file.path === "chat.json");
  declaration.bytes = chatFile.bytes;
  declaration.sha256 = chatFile.sha256;
  manifestFile.content = `${JSON.stringify(canonical(manifest), null, 2)}\n`;
  manifestFile.bytes = encoder.encode(manifestFile.content).byteLength;
  manifestFile.sha256 = await hash(manifestFile.content);
  await assert.rejects(() => validateSessionExport(invalid), /Session export unavailable/);
});

test("rejects empty, misplaced, changed-kind, row, digest, and identifier references", async () => {
  const changes = [
    (chat) => { chat.sessionsByAlias["0123456789abcdef"].messages[0].ref = {}; },
    (chat) => { chat.arbitrary = { completeRef: chat.rootSessionRef }; },
    (chat) => { chat.rootSessionRef.kind = "message"; },
    (chat) => { chat.rootSessionRef.rawRef.row = 99; },
    (chat) => { chat.rootSessionRef.rawRef.sha256 = "0".repeat(64); },
    (chat) => { chat.rootSessionRef.id = "changed"; },
  ];
  for (const change of changes) {
    const invalid = await resignedChatBundle(change);
    await assert.rejects(() => validateSessionExport(invalid), /Session export unavailable/);
  }
});
