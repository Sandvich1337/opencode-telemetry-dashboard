import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSnapshot } from "./analytics/snapshot.mjs";
import { collectConfiguredEnvironment, collectObservedEnvironment } from "./environment.mjs";

function walk(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  for (const child of Object.values(value)) walk(child, callback);
}

function observedFixture(reverse = false) {
  const sessions = [
    { id: "root-secret-id", createdAt: 0, updatedAt: 100, agent: "build-agent", model: "safe-model" },
    { id: "child-secret-id", parentId: "root-secret-id", createdAt: 40, updatedAt: 80, agent: "review-agent", model: "review-model", reviewer: { agent: "review-agent", verdict: "PASS" } },
  ];
  const parts = [
    { id: "part-secret-id", sessionId: "root-secret-id", createdAt: 20, updatedAt: 30, data: { type: "tool", tool: "read", state: { input: { path: "C:/private/secret.txt" } } } },
    { id: "part-error-secret-id", sessionId: "root-secret-id", createdAt: 30, updatedAt: 40, data: { type: "tool", tool: "shell", state: { status: "error", output: "SECRET COMMAND RESULT" }, command: "rm -rf /" } },
  ];
  const input = {
    range: { from: 0, to: 100 },
    provenance: { capabilities: { messages: { available: true }, parts: { available: false } } },
    sessions: reverse ? [...sessions].reverse() : sessions,
    parts,
  };
  return normalizeSnapshot(input);
}

test("observed inventory is normalized, deterministic, and deeply frozen", () => {
  const first = collectObservedEnvironment(observedFixture());
  const second = collectObservedEnvironment(observedFixture(true));
  assert.deepEqual(first, second);
  assert.equal(first.mode, "observed");
  assert.equal(first.available, true);
  assert.equal(first.availability.available, true);
  assert.ok(first.confidence.sample);
  assert.deepEqual(first.agents.map(({ name }) => name), ["build-agent", "review-agent"]);
  assert.deepEqual(first.models.map(({ name }) => name), ["review-model", "safe-model"]);
  assert.deepEqual(first.tools.map(({ name }) => name), ["read", "shell"]);
  assert.deepEqual(first.capabilities.map(({ name, available }) => ({ name, available })), [
    { name: "messages", available: true },
    { name: "parts", available: false },
  ]);
  assert.ok(Object.isFrozen(first));
  walk(first, (value) => assert.ok(Object.isFrozen(value)));
  assert.throws(() => first.agents.push({}), TypeError);
});

test("observed projection drops hostile normalized labels without copying telemetry values", () => {
  const snapshot = normalizeSnapshot({
    sessions: [{ id: "session-secret-id", agent: "https://user:password@example.test/private", model: "../relative/path" }],
    parts: [{ sessionId: "session-secret-id", data: { type: "tool", tool: "token-command", command: "curl https://secret.test" } }],
  });
  const output = JSON.stringify(collectObservedEnvironment(snapshot));
  for (const forbidden of ["https://", "password", "../relative", "token-command", "curl", "secret.test", "session-secret-id"]) {
    assert.equal(output.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test("configured collection is unavailable without touching candidates when disabled", async () => {
  const candidates = new Proxy({}, {
    get() { throw new Error("candidate inspected"); },
    ownKeys() { throw new Error("candidate inspected"); },
  });
  const output = await collectConfiguredEnvironment({ enabled: false, candidates });
  assert.equal(output.mode, "configured");
  assert.equal(output.available, false);
  assert.equal(output.provenance.basis, "unavailable");
  assert.equal(output.provenance.scope, "disabled");
  assert.deepEqual(output.agents, []);
});

test("configured collection uses an allowlist, rejects hostile content recursively, and does not mutate input", async () => {
  const candidates = [
    {
      type: "agent",
      name: "build-agent",
      version: "v1.2.3",
      capabilities: { tools: true, streaming: false, authorization: true, nested: { password: "secret" } },
      metadata: { path: "C:/private", token: "do-not-copy" },
    },
    { type: "model", name: "safe-model", version: "2026.08", value: "do-not-copy", headers: { authorization: "Bearer secret" } },
    { type: "tool", name: "read", capabilities: { files: true, command: "rm -rf /" } },
    { type: "tool", name: "https://host.test/private", version: "1.0.0" },
    { type: "model", name: "../relative/path", version: "1.0.0" },
    { type: "provider", name: "unknown-type" },
  ];
  const before = JSON.stringify(candidates);
  const output = await collectConfiguredEnvironment({
    enabled: true,
    candidates,
    config: { capabilities: { structuredOutput: true, apiKey: true, headers: false } },
    ignored: { token: "must not be inspected or copied" },
  });
  const serialized = JSON.stringify(output);
  for (const forbidden of ["do-not-copy", "C:/private", "authorization", "Bearer", "secret", "rm -rf", "https://", "relative", "api-key", "headers", "ignored"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `leaked ${forbidden}`);
  }
  assert.equal(output.mode, "configured");
  assert.equal(output.provenance.source, "caller");
  assert.deepEqual(output.agents[0].capabilities, { streaming: false, tools: true });
  assert.deepEqual(output.capabilities.map(({ name, available }) => ({ name, available })), [{ name: "structuredoutput", available: true }]);
  assert.ok(Object.isFrozen(output));
  walk(output, (value) => assert.ok(Object.isFrozen(value)));
  assert.equal(JSON.stringify(candidates), before);
});
