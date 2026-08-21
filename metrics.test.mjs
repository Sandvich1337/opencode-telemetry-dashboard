import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateRows,
  computeMetrics,
  openReadOnlyDatabase,
  parseVerdict,
} from "./metrics.mjs";
import { PRICING_CATALOG } from "./pricing.mjs";

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-metrics-"));
  const path = join(directory, "fixture.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      agent TEXT,
      model TEXT,
      summary TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `);
  const insertSession = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  const base = 1_700_000_000_000;

  insertSession.run("root-1", null, base, base + 10_000, "build", "session-model", null, 0, 0, 0);
  insertSession.run("review-1", "root-1", base + 1_000, base + 2_000, "luna-reviewer", "review-model", null, 0, 0, 0);
  insertSession.run("review-2", "root-1", base + 3_000, base + 4_000, "luna-reviewer", "review-model", null, 0, 0, 0);
  insertSession.run("review-3", "root-1", base + 5_000, base + 6_000, "luna-reviewer", "review-model", null, 0, 0, 0);
  insertMessage.run(
    "message-root",
    "root-1",
    base + 1_000,
    base + 2_000,
    JSON.stringify({
      role: "assistant",
      agent: "build",
      model: { providerID: "provider", modelID: "model-a" },
      tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 2, write: 1 } },
      cost: 0.5,
      text: "private reviewer-looking text /should/not/be-visible",
    }),
  );
  insertMessage.run(
    "message-review-1",
    "review-1",
    base + 1_100,
    base + 1_200,
    JSON.stringify({ role: "assistant", agent: "luna-reviewer", text: "VERDICT: PASS" }),
  );
  insertMessage.run(
    "message-review-2",
    "review-2",
    base + 3_100,
    base + 3_200,
    JSON.stringify({ role: "assistant", agent: "luna-reviewer", text: "VERDICT: ISSUE" }),
  );
  insertMessage.run(
    "message-review-3",
    "review-3",
    base + 5_100,
    base + 5_200,
    JSON.stringify({ role: "assistant", agent: "luna-reviewer", text: "No verdict marker" }),
  );
  insertPart.run(
    "part-read",
    "root-1",
    "message-root",
    base + 2_000,
    base + 2_100,
    JSON.stringify({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "/private/secret.txt" },
        metadata: {
          files: [
            { path: "/private/secret.txt", additions: 3, deletions: 1 },
            { path: "/private/secret.txt", additions: 3, deletions: 1 },
            { path: "/private/other.txt", additions: 2, deletions: 4 },
          ],
          additions: 999,
          deletions: 999,
        },
      },
      metadata: { additions: 777, deletions: 777 },
    }),
  );
  insertPart.run(
    "part-error",
    "root-1",
    "message-root",
    base + 2_200,
    base + 2_300,
    JSON.stringify({ type: "tool", tool: "shell", state: { status: "error", output: "private output" } }),
  );
  db.close();
  return { directory, path, base };
}

function makeToolUsageFixture() {
  const sessionId = "tool-usage-session";
  const model = (name) => ({ providerID: "provider", modelID: `gpt-5.6-${name}` });
  const part = (id, messageId, createdAt, data) => ({
    id,
    sessionId,
    messageId,
    createdAt,
    updatedAt: createdAt,
    data,
  });

  return {
    sessions: [{
      id: sessionId,
      model: "provider/gpt-5.6-luna",
      createdAt: 1,
      updatedAt: 500,
    }],
    messages: [
      {
        id: "message-one-tool",
        sessionId,
        createdAt: 100,
        updatedAt: 103,
        data: {
          role: "assistant",
          model: model("luna"),
          tokens: { input: 7, output: 5, reasoning: 1, cache: { read: 3, write: 2 }, total: 18 },
        },
      },
      {
        id: "message-multiple-tools",
        sessionId,
        createdAt: 200,
        updatedAt: 209,
        data: {
          role: "assistant",
          model: model("terra"),
          tokens: { input: 10, output: 7, reasoning: 5, cacheRead: 4, cacheWrite: 2, total: 28 },
        },
      },
      {
        id: "message-zero-tools",
        sessionId,
        createdAt: 300,
        updatedAt: 301,
        data: {
          role: "assistant",
          model: model("sol"),
          tokens: { input: 2, output: 1, reasoning: 0, cacheRead: 1, cacheWrite: 0, total: 4 },
        },
      },
      {
        id: "message-mismatched-steps",
        sessionId,
        createdAt: 400,
        updatedAt: 404,
        data: {
          role: "assistant",
          model: model("luna-fast"),
          tokens: { input: 9, output: 5, reasoning: 4, cacheRead: 2, cacheWrite: 1, total: 21 },
        },
      },
    ],
    parts: [
      part("one-start", "message-one-tool", 101, { type: "step-start" }),
      part("one-read", "message-one-tool", 102, { type: "tool", tool: "read", state: { status: "completed" } }),
      part("one-finish", "message-one-tool", 103, {
        type: "step-finish",
        tokens: { input: 7, output: 5, reasoning: 1, cacheRead: 3, cacheWrite: 2, total: 18 },
      }),
      part("multiple-start-one", "message-multiple-tools", 201, { type: "step-start" }),
      part("multiple-shell-one", "message-multiple-tools", 202, { type: "tool", tool: "shell", state: { status: "completed" } }),
      part("multiple-read-one", "message-multiple-tools", 203, { type: "tool", tool: "read", state: { status: "error" } }),
      part("multiple-finish-one", "message-multiple-tools", 204, {
        type: "step-finish",
        state: { tokens: { input: 5, output: 4, reasoning: 2, cache: { read: 1, write: 1 }, total: 13 } },
      }),
      part("multiple-start-two", "message-multiple-tools", 205, { type: "step-start" }),
      part("multiple-read-two-a", "message-multiple-tools", 206, { type: "tool", tool: "read", state: { status: "completed" } }),
      part("multiple-shell-two", "message-multiple-tools", 207, { type: "tool", tool: "shell", state: { status: "completed" } }),
      part("multiple-read-two-b", "message-multiple-tools", 208, { type: "tool", tool: "read", state: { status: "completed" } }),
      part("multiple-finish-two", "message-multiple-tools", 209, {
        type: "step-finish",
        tokens: { input: 5, output: 3, reasoning: 3, cacheRead: 3, cacheWrite: 1, total: 15 },
      }),
      part("mismatch-start", "message-mismatched-steps", 401, { type: "step-start" }),
      part("mismatch-write", "message-mismatched-steps", 402, { type: "tool", tool: "write", state: { status: "completed" } }),
      part("mismatch-shell", "message-mismatched-steps", 403, { type: "tool", tool: "shell", state: { status: "completed" } }),
      part("mismatch-finish", "message-mismatched-steps", 404, {
        type: "step-finish",
        state: { tokens: { input: 8, output: 5, reasoning: 4, cacheRead: 2, cacheWrite: 1, total: 20 } },
      }),
    ],
  };
}

test("parses only the exact uppercase VERDICT marker", () => {
  assert.equal(parseVerdict("luna-reviewer VERDICT: PASS"), "PASS");
  assert.equal(parseVerdict("lowercase verdict: PASS"), null);
  assert.equal(parseVerdict("VERDICT: FAIL; VERDICT: PASS"), "PASS");
});

test("aggregates the supported tables without exposing text or paths", () => {
  const fixture = makeFixture();
  const db = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    const metrics = computeMetrics(db, { now: fixture.base + 20_000 });
    assert.equal(metrics.schema.ok, true);
    assert.equal(metrics.summary.runs, 4);
    assert.equal(metrics.summary.subagents, 3);
    assert.equal(metrics.summary.tokens.input, 10);
    assert.equal(metrics.summary.tokens.output, 20);
    assert.equal(metrics.summary.tokens.total, 36);
    assert.equal(metrics.summary.tools, 2);
    assert.deepEqual(metrics.summary.toolBreakdown, { read: 1, shell: 1 });
    assert.equal(metrics.summary.reads, 1);
    assert.equal(metrics.summary.errors, 1);
    assert.deepEqual(metrics.summary.files, { additions: 5, deletions: 5 });
    assert.equal(Object.hasOwn(metrics, "reviewers"), false);
    assert.deepEqual(metrics.reviewerSummary.counts, { PASS: 1, ISSUE: 1, UNKNOWN: 1 });
    assert.equal(metrics.reviewerSummary.rates.PASS, 1 / 3);
    assert.deepEqual(metrics.reviewerSummary.bySlot["1"].rates, { PASS: 1, ISSUE: 0, UNKNOWN: 0 });
    assert.deepEqual(metrics.reviewerSummary.bySlot["2"].rates, { PASS: 0, ISSUE: 1, UNKNOWN: 0 });
    assert.deepEqual(metrics.reviewerSummary.bySlot["3"].rates, { PASS: 0, ISSUE: 0, UNKNOWN: 1 });
    assert.deepEqual(metrics.reviewerSummary.secondAfterFirstPass, {
      eligible: 1,
      pass: 0,
      issue: 1,
      unknown: 0,
      rate: 1,
    });
    const serialized = JSON.stringify(metrics);
    assert.equal(serialized.includes("private/secret.txt"), false);
    assert.equal(serialized.includes("private reviewer-looking text"), false);
    assert.equal(serialized.includes("private output"), false);
  } finally {
    db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("filters message and part activity at inclusive range boundaries", () => {
  const fixture = makeFixture();
  const db = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    const metrics = computeMetrics(db, {
      from: fixture.base + 1_000,
      to: fixture.base + 2_100,
    });
    assert.equal(metrics.range.label, "Custom range");
    assert.equal(metrics.summary.runs, 2);
    assert.equal(metrics.summary.tools, 1);
    assert.equal(metrics.summary.errors, 0);
    assert.deepEqual(metrics.summary.files, { additions: 5, deletions: 5 });
    assert.equal(metrics.reviewerSummary.total, 1);
    assert.equal(metrics.reviewerSummary.secondAfterFirstPass.eligible, 0);
  } finally {
    db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("uses only a nonzero session summary when file metadata is absent", () => {
  const rows = {
    sessions: [{ id: "summary-only", parentId: null, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, summary: JSON.stringify({ additions: 7, deletions: 8 }) }],
    messages: [],
    parts: [],
  };
  assert.deepEqual(aggregateRows(rows).summary.files, { additions: 7, deletions: 8 });
  assert.deepEqual(aggregateRows(rows, { sessionSummaryFallback: false }).summary.files, { additions: 0, deletions: 0 });
});

test("opens the database read-only", () => {
  const fixture = makeFixture();
  const db = openReadOnlyDatabase(fixture.path);
  try {
    assert.throws(() => db.prepare("INSERT INTO session VALUES ('x', NULL, 1, 1, 'x', 'y', NULL, 0, 0, 0)").run());
  } finally {
    db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("estimates short, long, fast, terra, unknown, and reasoning pricing", () => {
  const rows = {
    sessions: [
      { id: "short", model: "luna", createdAt: 1, updatedAt: 2 },
      { id: "long", model: "luna", createdAt: 1, updatedAt: 2 },
      { id: "fast", model: "luna-fast", createdAt: 1, updatedAt: 2 },
      { id: "terra", model: "terra", createdAt: 1, updatedAt: 2 },
      { id: "unknown", model: "gpt-unknown", createdAt: 1, updatedAt: 2 },
    ],
    messages: [
      { id: "m-short", sessionId: "short", data: { tokens: { input: 100_000, output: 1_000_000, reasoning: 500_000 } } },
      { id: "m-long", sessionId: "long", data: { tokens: { input: 272_001 } } },
      { id: "m-fast", sessionId: "fast", data: { tokens: { input: 100_000 } } },
      { id: "m-terra", sessionId: "terra", data: { tokens: { cacheRead: 100_000 } } },
      { id: "m-unknown", sessionId: "unknown", data: { tokens: { input: 1_000_000 } } },
    ],
    parts: [],
  };
  const metrics = aggregateRows(rows);
  assert.ok(Math.abs(metrics.summary.estimatedCost.usd - 1.9888004) < 1e-12);
  const expectedComponents = {
    input: 0.1 * 0.2 + 272_001 / 1_000_000 * 0.4 + 0.1 * 0.4,
    cacheRead: 0.1 * 0.2,
    cacheWrite: 0,
    output: 1.8,
  };
  for (const [name, expected] of Object.entries(expectedComponents)) {
    assert.ok(Math.abs(metrics.summary.estimatedCost.components[name] - expected) < 1e-12);
  }
  assert.deepEqual(metrics.summary.estimatedCost.coverage, { priced: 4, unpriced: 1 });
  assert.equal(metrics.summary.cost, 0);
});

test("publishes the official pricing source", () => {
  assert.equal(PRICING_CATALOG.source, "https://platform.openai.com/docs/pricing");
});

test("publishes reported and catalog-estimated run cost with an explicit basis", () => {
  const reported = aggregateRows({
    sessions: [{ id: "reported", agent: "sol-build", model: "gpt-5.6-sol", createdAt: 1, updatedAt: 2 }],
    messages: [{ id: "reported-message", sessionId: "reported", data: { tokens: { input: 10 }, cost: 3.5 } }],
    parts: [],
  });
  const estimated = aggregateRows({
    sessions: [{ id: "estimated", agent: "luna-worker", model: "gpt-5.6-luna", createdAt: 1, updatedAt: 2 }],
    messages: [{ id: "estimated-message", sessionId: "estimated", data: { tokens: { input: 10 } } }],
    parts: [],
  });
  const zeroReported = aggregateRows({
    sessions: [{ id: "zero-reported", agent: "luna-worker", model: "gpt-5.6-luna", createdAt: 1, updatedAt: 2 }],
    messages: [{ id: "zero-message", sessionId: "zero-reported", data: { tokens: { input: 10 }, cost: 0 } }],
    parts: [],
  });
  assert.equal(reported.analytics.execution.runs[0].costBasis, "reported");
  assert.equal(estimated.analytics.execution.runs[0].costBasis, "estimated");
  assert.equal(estimated.analytics.execution.runs[0].estimatedUsd > 0, true);
  assert.equal(zeroReported.analytics.execution.runs[0].costBasis, "estimated");
  assert.equal(zeroReported.analytics.execution.runs[0].estimatedUsd > 0, true);
  assert.equal(estimated.analytics.advice.decisionSupport.principles.find((row) => row.key === "cost").reasoning.includes("catalog-estimated"), false);
});

test("allocates ordered tool steps with exact bucket and cost conservation", () => {
  const metrics = aggregateRows(makeToolUsageFixture());
  const usage = metrics.toolUsage;
  const buckets = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
  const expectedBuckets = {
    input: 28,
    output: 18,
    reasoning: 10,
    cacheRead: 10,
    cacheWrite: 5,
    total: 71,
  };

  assert.equal(usage.conservation.exact, true);
  assert.deepEqual(usage.conservation.summary, expectedBuckets);
  assert.deepEqual(usage.conservation.rows, expectedBuckets);
  assert.deepEqual(usage.conservation.delta, {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  assert.deepEqual(usage.methods, {
    stepFinish: 2,
    messageTools: 1,
    noTool: 1,
    noTokens: 0,
    nonAssistant: 0,
  });
  assert.equal(metrics.summary.tools, 8);
  assert.deepEqual(metrics.summary.toolBreakdown, { read: 4, shell: 3, write: 1 });
  assert.equal(metrics.summary.errors, 1);

  assert.deepEqual(usage.rows.map((row) => [row.tool, row.total, row.calls]), [
    ["read", 33, 4],
    ["shell", 22, 3],
    ["write", 12, 1],
    ["Unattributed / no tool", 4, 0],
  ]);
  const read = usage.rows[0];
  assert.deepEqual(Object.fromEntries(buckets.map((key) => [key, read[key]])), {
    input: 12,
    output: 9,
    reasoning: 4,
    cacheRead: 5,
    cacheWrite: 3,
  });
  assert.equal(read.cache, 8);
  assert.equal(read.errors, 1);
  assert.ok(usage.rows.some((row) => row.tool === "Unattributed / no tool"));
  assert.deepEqual(
    Object.fromEntries(usage.rows.map((row) => [row.tool, { calls: row.calls, errors: row.errors }])),
    {
      read: { calls: 4, errors: 1 },
      shell: { calls: 3, errors: 0 },
      write: { calls: 1, errors: 0 },
      "Unattributed / no tool": { calls: 0, errors: 0 },
    },
  );
  for (const row of usage.rows) {
    assert.equal(row.total, buckets.reduce((sum, key) => sum + row[key], 0));
    assert.equal(typeof row.estimatedUSD, "number");
  }
  const allocatedCost = usage.rows.reduce((sum, row) => sum + row.estimatedUSD, 0);
  assert.ok(Math.abs(allocatedCost - metrics.summary.estimatedCost.usd) < 1e-12);
  assert.deepEqual(metrics.summary.estimatedCost.coverage, { priced: 4, unpriced: 0 });
});

test("attributes analytics to one message sample without duplicating step events", () => {
  const metrics = aggregateRows(makeToolUsageFixture());
  const execution = metrics.analytics.execution;
  const run = execution.runs[0];
  assert.equal(execution.runs.length, 1);
  assert.equal(run.tokens, 71);
  assert.equal(run.model, "provider/gpt-5.6-luna");
  assert.deepEqual(run.tokenBuckets, {
    input: 28,
    output: 18,
    reasoning: 10,
    cacheRead: 10,
    cacheWrite: 5,
    total: 71,
  });
  assert.equal(metrics.analytics.efficiency.tokens.total, 71);
  assert.equal(metrics.analytics.efficiency.cost.estimatedUSD > 0, true);
  assert.equal(metrics.analytics.efficiency.estimatedCacheSavings.available, true);
  assert.deepEqual(metrics.analytics.advice.decisionSupport.principles.map((row) => row.key), ["intelligence", "cost", "speed"]);
  assert.equal(metrics.analytics.advice.decisionSupport.principles.find((row) => row.key === "cost").score, null);
  for (const row of metrics.analytics.advice.decisionSupport.principles) {
    assert.deepEqual(Object.keys(row), ["key", "label", "score", "conclusion", "reasoning", "evidence", "sample", "confidence"]);
    assert.ok(row.evidence.length > 0);
    assert.ok(row.reasoning.length < 160);
  }
  assert.ok(metrics.analytics.advice.decisionSupport.conclusions.every((row) => row.reasoning.length < 160 && !row.reasoning.includes("…") && !/^Because .*?,/i.test(row.reasoning)));
  assert.ok(metrics.analytics.advice.items.every((item) => item.reasoning.length < 160 && !item.reasoning.includes("…")));
  assert.ok(metrics.analytics.architecture.roles.every((role) => role.reasoning.length < 160));

  const toolNodes = metrics.analytics.architecture.nodes.filter((node) => node.type === "tool");
  const toolEdges = metrics.analytics.architecture.edges.filter((edge) => edge.type === "calls-tool");
  const agentNode = metrics.analytics.architecture.nodes.find((node) => node.type === "agent");
  const modelNode = metrics.analytics.architecture.nodes.find((node) => node.type === "model");
  assert.equal(agentNode.tokens, 71);
  assert.equal(modelNode.tokens, 71);
  assert.equal(metrics.analytics.architecture.nodes.some((node) => node.type === "run"), false);
  assert.equal(toolEdges.reduce((sum, edge) => sum + edge.weight.calls, 0), 8);
  assert.equal(toolNodes.reduce((sum, node) => sum + node.calls, 0), 8);
  assert.equal(toolNodes.reduce((sum, node) => sum + node.tokens, 0) > 0, true);
  assert.equal(toolNodes.reduce((sum, node) => sum + node.estimatedUsd, 0) > 0, true);
  const nodeIds = new Set(metrics.analytics.architecture.nodes.map((node) => node.id));
  for (const edge of metrics.analytics.architecture.edges) {
    assert.equal(nodeIds.has(edge.source), true);
    assert.equal(nodeIds.has(edge.target), true);
  }
});

test("scopes roots to descendants and child sessions exactly without leaking identifiers", () => {
  const base = 1_700_000_000_000;
  const ids = {
    root: "PRIVATE-ROOT-SESSION-ID",
    child: "PRIVATE-CHILD-SESSION-ID",
    grandchild: "PRIVATE-GRANDCHILD-SESSION-ID",
    unrelated: "PRIVATE-UNRELATED-SESSION-ID",
    orphan: "PRIVATE-ORPHAN-SESSION-ID",
    cycleA: "PRIVATE-CYCLE-A-SESSION-ID",
    cycleB: "PRIVATE-CYCLE-B-SESSION-ID",
  };
  const sessions = [
    { id: ids.root, parentId: null, createdAt: base, updatedAt: base + 10, agent: "sol-build", model: "gpt-5.6-sol", title: "PRIVATE TITLE" },
    { id: ids.child, parentId: ids.root, createdAt: base + 1, updatedAt: base + 10, agent: "luna-worker", model: "gpt-5.6-luna", path: "PRIVATE PATH" },
    { id: ids.grandchild, parentId: ids.child, createdAt: base + 2, updatedAt: base + 10, agent: "luna-reviewer", model: "gpt-5.6-luna" },
    { id: ids.unrelated, parentId: null, createdAt: base + 3, updatedAt: base + 10, agent: "general", model: "gpt-5.6-luna" },
    { id: ids.orphan, parentId: "MISSING-PRIVATE-PARENT-ID", createdAt: base + 4, updatedAt: base + 10, agent: "explore", model: "gpt-5.6-luna" },
    { id: ids.cycleA, parentId: ids.cycleB, createdAt: base + 5, updatedAt: base + 10, agent: "cycle-a", model: "gpt-5.6-luna" },
    { id: ids.cycleB, parentId: ids.cycleA, createdAt: base + 6, updatedAt: base + 10, agent: "cycle-b", model: "gpt-5.6-luna" },
  ];
  const messages = sessions.map((session, index) => ({
    id: `SAFE-MESSAGE-${index}`,
    sessionId: session.id,
    createdAt: base + index,
    updatedAt: base + 10,
    data: {
      role: "assistant",
      agent: session.agent,
      model: { providerID: "openai", modelID: session.model },
      tokens: { input: index + 1 },
      text: "PRIVATE PROMPT",
    },
  }));
  const parts = sessions.map((session, index) => ({
    id: `SAFE-PART-${index}`,
    sessionId: session.id,
    messageId: `SAFE-MESSAGE-${index}`,
    createdAt: base + index,
    updatedAt: base + 10,
    data: { type: "tool", tool: "read", state: { status: "completed" } },
  }));
  const rows = { sessions, messages, parts };
  const all = aggregateRows(rows);
  const optionFor = (agent) => all.sessionOptions.find((option) => option.agent === agent);
  assert.equal(all.sessionOptions[0].agent, "cycle-b");
  for (const option of all.sessionOptions) assert.match(option.alias, /^[0-9a-f]{16}$/);
  assert.equal(aggregateRows(rows).sessionOptions[0].alias, all.sessionOptions[0].alias);

  const root = aggregateRows(rows, { session: optionFor("sol-build").alias });
  assert.deepEqual(root.scope, {
    mode: "session",
    selectedAlias: optionFor("sol-build").alias,
    metadata: optionFor("sol-build"),
    found: true,
    count: 3,
  });
  assert.equal(root.summary.runs, 3);
  assert.equal(root.summary.subagents, 2);
  assert.equal(root.summary.tokens.input, 1 + 2 + 3);
  assert.equal(root.summary.tools, 3);
  assert.equal(root.toolUsage.conservation.exact, true);

  const child = aggregateRows(rows, { session: optionFor("luna-worker").alias });
  assert.equal(child.scope.count, 1);
  assert.equal(child.summary.runs, 1);
  assert.equal(child.summary.tokens.input, 2);
  assert.equal(child.summary.tools, 1);

  const invalid = aggregateRows(rows, { session: "0000000000000000" });
  assert.equal(invalid.scope.found, false);
  assert.equal(invalid.summary.runs, 0);
  assert.equal(invalid.summary.tokens.total, 0);

  const cycle = aggregateRows(rows, { session: optionFor("cycle-a").alias });
  assert.equal(cycle.scope.count, 1);
  assert.equal(cycle.summary.runs, 1);
  const orphan = aggregateRows(rows, { session: optionFor("explore").alias });
  assert.equal(orphan.scope.count, 1);

  for (const block of root.toolUsage.byAgent) {
    assert.equal(block.conservation.exact, true);
    assert.deepEqual(block.conservation.delta, {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  }
  assert.equal(root.toolUsage.conservation.exact, true);

  const serialized = JSON.stringify(root);
  for (const privateValue of [
    ...Object.values(ids),
    "MISSING-PRIVATE-PARENT-ID",
    "PRIVATE TITLE",
    "PRIVATE PATH",
    "PRIVATE PROMPT",
  ]) assert.equal(serialized.includes(privateValue), false);
});

test("keeps session titles private unless explicitly requested", () => {
  const rows = {
    sessions: [
      { id: "private-title", title: "PRIVATE TITLE", createdAt: 1, updatedAt: 2 },
      { id: "private-child", parentId: "private-title", title: "PRIVATE CHILD TITLE", createdAt: 2, updatedAt: 3 },
    ],
    messages: [],
    parts: [],
  };
  const hidden = aggregateRows(rows);
  assert.equal(Object.hasOwn(hidden.sessionOptions[0], "title"), false);
  assert.equal(JSON.stringify(hidden).includes("PRIVATE TITLE"), false);
  assert.equal(hidden.privacy.sessionTitlesIncluded, false);

  const visible = aggregateRows(rows, { includeSessionTitles: true });
  const visibleRoot = visible.sessionOptions.find((option) => option.kind === "root");
  const visibleChild = visible.sessionOptions.find((option) => option.kind === "child");
  assert.equal(visibleRoot.title, "PRIVATE TITLE");
  assert.equal(Object.hasOwn(visibleChild, "title"), false);
  assert.equal(JSON.stringify(visible).includes("PRIVATE CHILD TITLE"), false);
  assert.equal(visible.scope.metadata, null);
  assert.equal(visible.privacy.sessionTitlesIncluded, true);
});

test("reports cacheWrite presence without treating missing values as reported zero", () => {
  const rows = {
    sessions: [{ id: "cache-reporting", createdAt: 1, updatedAt: 2 }],
    messages: [
      { id: "missing", sessionId: "cache-reporting", data: { tokens: { input: 1, total: 1 } } },
      { id: "zero", sessionId: "cache-reporting", data: { tokens: { input: 2, cacheWrite: 0, total: 2 } } },
      { id: "positive", sessionId: "cache-reporting", data: { tokens: { input: 3, cacheWrite: 4, total: 7 } } },
    ],
    parts: [],
  };
  const metrics = aggregateRows(rows);
  assert.equal(metrics.summary.tokens.cacheWrite, 4);
  assert.deepEqual(metrics.summary.cacheWriteReporting, { observed: 2, samples: 3 });
});

test("conserves tool tokens by agent with session-message-part identity fallback", () => {
  const rows = {
    sessions: [
      { id: "session-wins", agent: "session-agent", model: "luna", createdAt: 1, updatedAt: 2 },
      { id: "part-fallback", model: "luna", createdAt: 1, updatedAt: 2 },
    ],
    messages: [
      {
        id: "message-wins",
        sessionId: "session-wins",
        data: { role: "assistant", agent: "message-agent", tokens: { input: 8, total: 8 } },
      },
      {
        id: "message-fallback",
        sessionId: "part-fallback",
        data: { role: "assistant", tokens: { input: 10, total: 10 } },
      },
    ],
    parts: [
      { id: "part-wins", sessionId: "session-wins", messageId: "message-wins", data: { type: "tool", tool: "read", agent: "part-agent" } },
      { id: "part-fallback-a", sessionId: "part-fallback", messageId: "message-fallback", data: { type: "tool", tool: "shell", agent: "part-agent" } },
      { id: "part-fallback-b", sessionId: "part-fallback", messageId: "message-fallback", data: { type: "tool", tool: "write", agent: "part-agent" } },
    ],
  };
  const usage = aggregateRows(rows).toolUsage;
  assert.deepEqual(
    Object.fromEntries(usage.rows.map((row) => [row.tool, row.calls])),
    { read: 1, shell: 1, write: 1 },
  );
  assert.deepEqual(usage.byAgent.map((block) => block.agent).sort(), ["part-agent", "session-agent"]);
  assert.equal(usage.conservation.exact, true);
  for (const block of usage.byAgent) assert.equal(block.conservation.exact, true);
  const partAgent = usage.byAgent.find((block) => block.agent === "part-agent");
  const sessionAgent = usage.byAgent.find((block) => block.agent === "session-agent");
  assert.equal(partAgent.totals.input, 10);
  assert.equal(sessionAgent.totals.input, 8);
});

test("orchestrates one filtered analytics snapshot with deterministic privacy-safe output", () => {
  const sessions = [
    { id: "PRIVATE-ROOT-SESSION-ID", parentId: null, createdAt: 0, updatedAt: 100, agent: "orchestrator", model: "root-model" },
    { id: "PRIVATE-WORKER-SESSION-ID", parentId: "PRIVATE-ROOT-SESSION-ID", createdAt: 10, updatedAt: 60, agent: "worker", model: "worker-model" },
    { id: "PRIVATE-REVIEW-SESSION-ID", parentId: "PRIVATE-ROOT-SESSION-ID", createdAt: 20, updatedAt: 50, agent: "reviewer", model: "review-model", reviewer: { agent: "reviewer", verdict: "PASS" } },
    { id: "PRIVATE-ZERO-SESSION-ID", parentId: null, createdAt: 70, updatedAt: 70, agent: "zero-duration", model: "zero-model" },
  ];
  const messages = sessions.map((session, index) => ({
    id: `PRIVATE-MESSAGE-${index}`,
    sessionId: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    data: {
      role: "assistant",
      model: { providerID: "provider", modelID: session.model },
      tokens: { input: index + 1, output: 2, reasoning: 1 },
      text: "SECRET PAYLOAD MUST NOT LEAK",
    },
  }));
  const parts = [
    { id: "PRIVATE-PART-TASK", sessionId: sessions[0].id, messageId: messages[0].id, createdAt: 10, updatedAt: 20, data: { type: "tool", tool: "task", state: { status: "completed" } } },
    { id: "PRIVATE-PART-READ", sessionId: sessions[1].id, messageId: messages[1].id, createdAt: 20, updatedAt: 30, data: { type: "tool", tool: "read", state: { status: "completed" } } },
    { id: "PRIVATE-PART-ERROR", sessionId: sessions[2].id, messageId: messages[2].id, createdAt: 30, updatedAt: 40, data: { type: "tool", tool: "shell", state: { status: "error", output: "SECRET COMMAND RESULT" } } },
  ];
  const options = {
    from: 0,
    to: 100,
    inspectEnvironment: true,
    includeEnvironment: true,
    environmentOptions: {
      candidates: [
        { type: "agent", name: "configured-agent", version: "v1.0.0", metadata: { token: "SECRET" } },
        { type: "model", name: "configured-model", version: "2026.08" },
      ],
    },
  };
  const first = aggregateRows({ sessions, messages, parts }, options);
  const second = aggregateRows({ sessions: [...sessions].reverse(), messages: [...messages].reverse(), parts: [...parts].reverse() }, options);

  assert.deepEqual(first.analytics, second.analytics);
  assert.deepEqual(Object.keys(first.analytics), [
    "schemaVersion", "availability", "throughput", "architecture", "execution", "efficiency",
    "comparisons", "failures", "trends", "environment", "advice",
  ]);
  assert.equal(first.analytics.schemaVersion, 1);
  assert.deepEqual(Object.keys(first.analytics.availability), [
    "architecture", "throughput", "reviewerAttribution", "configuredEnvironment",
  ]);
  assert.equal(first.analytics.availability.architecture.available, true);
  assert.equal(first.analytics.availability.throughput.available, true);
  assert.equal(first.analytics.availability.reviewerAttribution.available, true);
  assert.equal(first.analytics.availability.configuredEnvironment.available, true);
  assert.equal(first.analytics.execution.runs.length, 4);
  assert.equal(first.analytics.architecture.delegation.delegations, 2);
  assert.ok(first.analytics.throughput.basis.parallelism > 1);
  assert.deepEqual(first.analytics.comparisons.byModel.map(({ model }) => model), ["review-model", "root-model", "worker-model", "zero-model"]);
  assert.deepEqual(first.analytics.failures.totals.errors, 1);
  assert.ok(first.analytics.architecture.roles.some(({ agent, confidence }) => agent === "reviewer" && confidence.value !== null));
  assert.equal(first.analytics.trends.availability.available, false);
  assert.equal(first.analytics.trends.availability.reason, "previous-unavailable");
  assert.equal(first.analytics.advice.items.some(({ code }) => code.startsWith("delegation-")), false);
  assert.deepEqual(first.analytics.environment.configured.agents.map(({ name }) => name), ["configured-agent"]);
  const requestGated = aggregateRows({ sessions, messages, parts }, { ...options, includeEnvironment: false });
  assert.equal(requestGated.analytics.availability.configuredEnvironment.available, false);
  assert.equal(requestGated.analytics.availability.configuredEnvironment.reason, "request-opt-in-required");
  const startupGated = aggregateRows({ sessions, messages, parts }, { ...options, inspectEnvironment: false });
  assert.equal(startupGated.analytics.availability.configuredEnvironment.available, false);
  assert.equal(startupGated.analytics.availability.configuredEnvironment.reason, "startup-opt-in-required");
  for (const forbidden of ["PRIVATE-ROOT-SESSION-ID", "PRIVATE-MESSAGE-0", "PRIVATE-PART-TASK", "SECRET PAYLOAD", "SECRET COMMAND RESULT"]) {
    assert.equal(JSON.stringify(first.analytics).includes(forbidden), false, `leaked ${forbidden}`);
  }

  const zero = aggregateRows({ sessions: [], messages: [], parts: [] });
  assert.equal(zero.analytics.schemaVersion, 1);
  assert.deepEqual(Object.keys(zero.analytics.availability), [
    "architecture", "throughput", "reviewerAttribution", "configuredEnvironment",
  ]);
  for (const value of Object.values(zero.analytics.availability)) assert.equal(value.available, false);
  assert.equal(zero.analytics.throughput.totals.rates.processedTokensPerMinute, null);
  assert.equal(zero.analytics.throughput.rateReasons.processedTokensPerMinute, "no-positive-denominator");
  assert.equal(zero.analytics.environment.configured.availability.reason, "startup-opt-in-required");
});

test("extends zero and capability responses with unavailable analytics", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const result = computeMetrics(db, { session: "missing-session" });
    assert.equal(result.schema.ok, false);
    assert.equal(result.analytics.schemaVersion, 1);
    for (const value of Object.values(result.analytics.availability)) assert.equal(value.available, false);
    assert.equal(result.analytics.availability.architecture.reason, "no-runs");
    assert.equal(result.analytics.throughput.availability.available, false);
    assert.equal(result.analytics.environment.observed.available, true);
    assert.ok(result.analytics.environment.observed.capabilities.length > 0);
    assert.equal(result.analytics.environment.configured.availability.available, false);
    assert.equal(result.analytics.advice.availability.available, false);
    assert.ok(result.analytics.advice.items.some(({ code }) => code === "capability-unavailable"));
  } finally {
    db.close();
  }
});
