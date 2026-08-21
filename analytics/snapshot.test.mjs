import assert from "node:assert/strict";
import test from "node:test";

import {
  createSnapshot,
  normalizeSnapshot,
  sanitizePublic,
  sanitizeSnapshot,
  snapshotFingerprint,
} from "./snapshot.mjs";

function fixture(reverse = false) {
  const sessions = [
    {
      id: "child-secret-id",
      parentId: "root-secret-id",
      createdAt: 40,
      updatedAt: 80,
      agent: "review-agent",
      model: "review-model",
      reviewer: { agent: "review-agent", slot: 2, verdict: "ISSUE", confidence: { value: 0.5, reason: "sampled" } },
    },
    {
      id: "root-secret-id",
      createdAt: 0,
      updatedAt: 100,
      agent: "build-agent",
      model: { providerID: "provider", modelID: "model" },
    },
  ];
  const messages = [{
    id: "message-secret-id",
    sessionId: "root-secret-id",
    createdAt: 10,
    updatedAt: 20,
    data: {
      role: "assistant",
      tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 2, write: 0 }, total: 35 },
      cost: 0.25,
      text: "SECRET PROMPT TEXT must never cross the public boundary",
    },
  }];
  const parts = [
    {
      id: "part-read-secret-id",
      sessionId: "root-secret-id",
      messageId: "message-secret-id",
      createdAt: 20,
      updatedAt: 30,
      data: { type: "tool", tool: "read", state: { input: { path: "C:/private/secret.txt" } } },
    },
    {
      id: "part-error-secret-id",
      sessionId: "root-secret-id",
      messageId: "message-secret-id",
      createdAt: 30,
      updatedAt: 40,
      data: { type: "tool", tool: "shell", state: { status: "error", output: "SECRET COMMAND RESULT" }, command: "rm -rf /" },
    },
  ];
  return {
    range: { from: 0, to: 100 },
    scope: { kind: "session", sessionId: "root-secret-id" },
    provenance: {
      range: { available: true, basis: "reported", reason: "explicit" },
      scope: { available: true, basis: "derived", reason: "selected" },
      capabilities: {
        messages: { available: true, basis: "observed", reason: "present", sample: { count: 1, observed: 1, denominator: 1 } },
        parts: { available: false, basis: "unavailable", reason: "missing" },
      },
    },
    sessions: reverse ? [...sessions].reverse() : sessions,
    messages,
    parts,
  };
}

test("snapshot construction is normalized, immutable, and retains only internal join data", () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const snapshot = createSnapshot(input);
  assert.equal(snapshot.analytics.schemaVersion, 1);
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.runs.length, 2);
  assert.equal(snapshot.sessions[0].id, "root-secret-id");
  assert.equal(snapshot.sessions[1].parentId, "root-secret-id");
  assert.equal(snapshot.sessions[1].rootId, "root-secret-id");
  assert.equal(snapshot.sessions[0].tokens.total, 35);
  assert.equal(snapshot.sessions[0].tokens.cacheWriteReported, true);
  assert.equal(snapshot.sessions[0].toolEvents.length, 2);
  assert.equal(snapshot.sessions[0].toolEvents[1].error, true);
  assert.equal(snapshot.sessions[0].errors.length, 1);
  assert.equal(snapshot.sessions[0].reviewer, null);
  assert.equal(snapshot.sessions[1].reviewer.verdict, "ISSUE");
  assert.equal(JSON.stringify(snapshot).includes("SECRET PROMPT"), false);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.sessions[0]));
  assert.throws(() => { snapshot.sessions.push({}); }, TypeError);
  assert.equal(JSON.stringify(input), before);
});

test("malformed records fail closed and ordering is deterministic", () => {
  const snapshot = normalizeSnapshot({ sessions: [
    { id: "z", createdAt: Infinity, updatedAt: -Infinity, parentId: { secret: true } },
    null,
    { id: "a", createdAt: 10, updatedAt: 20 },
  ] });
  assert.equal(snapshot.sessions.length, 3);
  assert.deepEqual(snapshot.sessions[2].interval, { start: null, end: null, durationMs: 0 });
  assert.equal(snapshot.sessions[1].id, "session-2");
  assert.deepEqual(snapshot.sessions[0].interval, { start: 10, end: 20, durationMs: 10 });
  assert.equal(snapshot.sessions[0].parentId, null);
});

test("public sanitization exposes deterministic aliases and recursively rejects private material", () => {
  const first = sanitizeSnapshot(createSnapshot(fixture()));
  const second = sanitizeSnapshot(createSnapshot(fixture(true)));
  assert.deepEqual(first, second);
  assert.equal(first.analytics.schemaVersion, 1);
  assert.equal(first.scope.sessionAlias, "session-001");
  assert.match(first.sessions[0].alias, /^session-\d{3}$/);
  assert.match(first.sessions[0].identity.agent, /^agent-\d{3}$/);
  assert.equal(first.sessions[0].toolEvents[0].toolAlias, "tool-001");
  assert.equal(first.provenance.capabilities[0].name, "messages");
  const publicText = JSON.stringify(first);
  for (const secret of ["root-secret-id", "message-secret-id", "SECRET PROMPT", "C:/private", "rm -rf", "SECRET COMMAND RESULT"]) {
    assert.equal(publicText.includes(secret), false, `leaked ${secret}`);
  }
  const privateKeys = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      privateKeys.push(key);
      walk(child);
    }
  };
  walk(first);
  assert.equal(privateKeys.some((key) => /(?:id$|path|url|command|args|result|text|payload|raw)/i.test(key)), false);
  assert.deepEqual(sanitizePublic({
    text: "private text",
    nested: { rawId: "private id", path: "/private", url: "https://private", safeNumber: 4, secret: "drop" },
    output: { result: "drop" },
  }), { nested: { safeNumber: 4 } });
});

test("snapshot fingerprints are stable and omit raw fields", () => {
  const fingerprint = snapshotFingerprint(fixture());
  assert.equal(fingerprint.includes("root-secret-id"), false);
  assert.equal(fingerprint, snapshotFingerprint(fixture(true)));
});
