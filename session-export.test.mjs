import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSessionExport, canonicalJson } from "./session-export.mjs";
import { sessionAlias } from "./metrics.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-session-export-"));
  const path = join(directory, "fixture.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      time_created INTEGER,
      time_updated REAL,
      title TEXT,
      extra BLOB
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
  const session = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)");
  const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  session.run("root", null, 1_700_000_000_000, -0, "Root title", Buffer.from([0, 255]));
  session.run("child", "root", 1_700_000_000_100, 1_700_000_000_200, "Child", null);
  session.run("grandchild", "child", 1_700_000_000_300, 1_700_000_000_400, "Grandchild", null);
  session.run("unrelated", null, 1_700_000_000_500, 1_700_000_000_600, "Unrelated", null);
  session.run("orphan", "missing-parent", 1_700_000_000_700, 1_700_000_000_800, "Orphan", null);
  message.run("root-message", "root", 1_700_000_000_010, 1_700_000_000_020, JSON.stringify({ role: "user", text: "Keep exact" }));
  message.run("child-message", "child", 1_700_000_000_110, 1_700_000_000_120, JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Response" }] }));
  message.run("unrelated-message", "unrelated", 1_700_000_000_510, 1_700_000_000_520, JSON.stringify({ role: "user", text: "Excluded" }));
  part.run("root-part", "root", "root-message", 1_700_000_000_030, 1_700_000_000_040, JSON.stringify({ type: "tool", tool: "read", state: { status: "completed" } }));
  part.run("child-part", "child", "child-message", 1_700_000_000_130, 1_700_000_000_140, JSON.stringify({ type: "text", text: "Part text" }));
  part.run("unattached-part", "grandchild", null, 1_700_000_000_330, 1_700_000_000_340, JSON.stringify({ type: "unknown" }));
  db.close();
  return { directory, path };
}

test("builds a deterministic, raw-fidelity snapshot without changing SQLite", () => {
  const created = fixture();
  const alias = sessionAlias("root");
  const before = new DatabaseSync(created.path);
  const beforeVersion = before.prepare("PRAGMA data_version").get().data_version;
  const beforeSchema = before.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const beforeRows = before.prepare("SELECT * FROM session ORDER BY id").all();
  before.close();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    const first = buildSessionExport(db, alias);
    const second = buildSessionExport(db, alias);
    assert.deepEqual(first, second);
    assert.deepEqual(first.files.map((file) => file.path), [
      "manifest.json", "raw/sessions.json", "raw/messages.json", "raw/parts.json", "timeline.json", "metrics.json", "transcript.json", "chat.json",
    ]);
    const rawSessions = JSON.parse(first.files[1].content);
    assert.equal(rawSessions.rows.length, 3);
    assert.deepEqual(rawSessions.rows[2][5], { type: "blob", value: "AP8=" });
    assert.equal(rawSessions.rows[2][3].type, "real");
    assert.deepEqual(rawSessions.rows[0][5], { type: "null", value: null });
    assert.equal(rawSessions.rows[2][4].value, "Root title");
    const manifest = JSON.parse(first.files[0].content);
    assert.equal(manifest.coverage.mode, "snapshot-only");
    assert.equal(manifest.coverage.runtimeSnapshot.consistency, "single-sqlite-read-transaction");
    assert.equal(manifest.counts.sessions, 3);
    assert.equal(manifest.counts.messages, 2);
    assert.equal(manifest.counts.parts, 3);
    assert.equal(JSON.parse(first.files[4].content).events.length, 8);
    const transcript = JSON.parse(first.files[6].content);
    assert.equal(transcript.messages.length, 2);
    assert.equal(transcript.unattachedParts.length, 1);
    const chat = JSON.parse(first.files[7].content);
    assert.deepEqual(chat.sessionOrder, [sessionAlias("root"), sessionAlias("child"), sessionAlias("grandchild")]);
    assert.equal(chat.sessionsByAlias[sessionAlias("root")].messages[0].segments[0].text, "Keep exact");
    assert.equal(chat.sessionsByAlias[sessionAlias("root")].messages[0].parts[0].toolCall.name, "read");
    assert.deepEqual(chat.sessionsByAlias[sessionAlias("grandchild")].deepDiveWindow.unattachedParts.map((ref) => ref.id), ["unattached-part"]);
    assert.equal(chat.subagentDeepDives[0].invocationRef, null);
  } finally {
    db.close();
  }
  const after = new DatabaseSync(created.path);
  try {
    assert.equal(after.prepare("PRAGMA data_version").get().data_version, beforeVersion);
    assert.deepEqual(after.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), beforeSchema);
    assert.deepEqual(after.prepare("SELECT * FROM session ORDER BY id").all(), beforeRows);
  } finally {
    after.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("omits tool names and sources when no persisted tool metadata exists", () => {
  const created = fixture();
  const writer = new DatabaseSync(created.path);
  writer.prepare("UPDATE part SET data = ? WHERE id = 'root-part'").run(JSON.stringify({ type: "tool", state: { status: "completed" } }));
  writer.close();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    const chat = JSON.parse(buildSessionExport(db, sessionAlias("root")).files.find((file) => file.path === "chat.json").content);
    const toolCall = chat.sessionsByAlias[sessionAlias("root")].messages[0].parts[0].toolCall;
    assert.equal(Object.hasOwn(toolCall, "name"), false);
    assert.equal(Object.hasOwn(toolCall.sources, "name"), false);
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("preserves SQLite big integers and records unsupported content without inventing text", () => {
  const created = fixture();
  const writer = new DatabaseSync(created.path);
  writer.exec("ALTER TABLE session ADD COLUMN big_value INTEGER;");
  writer.prepare("UPDATE session SET big_value = ? WHERE id = 'root'").run(9007199254740993123n);
  writer.prepare("UPDATE part SET time_created = NULL, time_updated = NULL, data = ? WHERE id = 'unattached-part'").run(Buffer.from([0xff, 0xfe]));
  writer.close();

  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    const exported = buildSessionExport(db, sessionAlias("root"));
    const rawSessions = JSON.parse(exported.files[1].content);
    const root = rawSessions.rows.find((row) => row[0].value === "root");
    assert.deepEqual(root.at(-1), { type: "integer", value: "9007199254740993123" });
    const manifest = JSON.parse(exported.files[0].content);
    assert.ok(manifest.anomalies.includes("data-invalid-utf8"));
    assert.ok(manifest.anomalies.includes("time-missing"));
    const transcript = JSON.parse(exported.files.find((file) => file.path === "transcript.json").content);
    const unsupported = transcript.unattachedParts.find((part) => part.id === "unattached-part");
    assert.deepEqual(unsupported.segments, []);
    assert.ok(unsupported.anomalies.includes("data-invalid-utf8"));
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("canonical JSON has sorted keys and one trailing LF", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), '{\n  "a": {\n    "x": null,\n    "y": true\n  },\n  "z": 1\n}\n');
});

test("rejects child selection and unknown aliases without falling back to all sessions", () => {
  const created = fixture();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    assert.throws(() => buildSessionExport(db, sessionAlias("child")), /selected session is not a root/);
    assert.throws(() => buildSessionExport(db, "0000000000000000"), /unknown root selection/);
    assert.throws(() => buildSessionExport(db, sessionAlias("ROOT")), /unknown root selection/);
    assert.throws(() => buildSessionExport(db, `${sessionAlias("root")}x`), /invalid root selection/);
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("fails closed for a part whose direct session and message point across trees", () => {
  const created = fixture();
  const writer = new DatabaseSync(created.path);
  writer.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "cross-tree-part",
    "root",
    "unrelated-message",
    1,
    2,
    JSON.stringify({ type: "tool", tool: "task" }),
  );
  writer.close();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    assert.throws(() => buildSessionExport(db, sessionAlias("root")), /cross-tree part relation/);
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("fails closed for two distinct sessions with one public alias", () => {
  const created = fixture();
  const writer = new DatabaseSync(created.path);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run("alias-collision-a", null, 10, 11, "Collision A", null);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run("alias-collision-b", null, 12, 13, "Collision B", null);
  writer.close();

  const require = createRequire(import.meta.url);
  const crypto = require("node:crypto");
  const originalCreateHash = crypto.createHash;
  const collisionDigest = `${"0123456789abcdef"}${"0".repeat(48)}`;
  crypto.createHash = (algorithm, options) => {
    const hash = originalCreateHash(algorithm, options);
    let input = "";
    return {
      update(value, ...args) {
        input += String(value);
        hash.update(value, ...args);
        return this;
      },
      digest(...args) {
        if (algorithm === "sha256" && args[0] === "hex" && ["alias-collision-a", "alias-collision-b"].includes(input)) return collisionDigest;
        return hash.digest(...args);
      },
    };
  };
  syncBuiltinESMExports();

  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    assert.throws(() => buildSessionExport(db, "0123456789abcdef"), /ambiguous session alias/);
    assert.doesNotThrow(() => db.exec("BEGIN"));
    db.exec("ROLLBACK");
  } finally {
    db.close();
    crypto.createHash = originalCreateHash;
    syncBuiltinESMExports();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("owns one transaction and fails closed when called inside another", () => {
  const created = fixture();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    assert.doesNotThrow(() => buildSessionExport(db, sessionAlias("root")));
    assert.doesNotThrow(() => db.exec("BEGIN"));
    db.exec("ROLLBACK");
    db.exec("BEGIN");
    assert.throws(() => buildSessionExport(db, sessionAlias("root")), /transaction/i);
    db.exec("ROLLBACK");
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("handles reachable and disconnected session cycles without revisiting rows", () => {
  const created = fixture();
  const writer = new DatabaseSync(created.path);
  writer.exec(`
    INSERT INTO session VALUES ('cycle-a', 'child', 10, 11, 'Cycle A', NULL);
    INSERT INTO session VALUES ('cycle-b', 'cycle-a', 12, 13, 'Cycle B', NULL);
    INSERT INTO session VALUES ('disconnected-a', 'disconnected-b', 14, 15, 'Disconnected A', NULL);
    INSERT INTO session VALUES ('disconnected-b', 'disconnected-a', 16, 17, 'Disconnected B', NULL);
  `);
  writer.close();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    const exported = buildSessionExport(db, sessionAlias("root"));
    const manifest = JSON.parse(exported.files[0].content);
    assert.deepEqual(manifest.tree.sessionIds, ["root", "child", "cycle-a", "grandchild", "cycle-b"]);
    assert.equal(manifest.counts.sessions, 5);
    assert.equal(JSON.parse(exported.files[1].content).rows.some((row) => row[0].value === "disconnected-a"), false);
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("preserves exact timeline order and SQLite provenance", () => {
  const created = fixture();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    const exported = buildSessionExport(db, sessionAlias("root"));
    const timeline = JSON.parse(exported.files[4].content).events;
    assert.deepEqual(timeline.map((event) => event.id), [
      "root", "root-message", "root-part", "child", "child-message", "child-part", "grandchild", "unattached-part",
    ]);
    assert.ok(timeline.every((event) => event.provenance === "sqlite-snapshot"));
    assert.ok(timeline.every((event) => event.rawRef.path.startsWith("raw/")));
    assert.equal(timeline[0].time.evidence[0].source, "row.time_created");
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("keeps multiple task children and unknown causality explicit", () => {
  const created = fixture();
  const writer = new DatabaseSync(created.path);
  writer.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "task-message", "root", 40, 41, JSON.stringify({ role: "assistant", text: "task" }),
  );
  const part = writer.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  part.run("task-parent", "root", "task-message", 42, 43, JSON.stringify({ type: "tool", tool: "task" }));
  part.run("task-child-b", "root", "task-message", 44, 45, JSON.stringify({ type: "text", text: "child b" }));
  part.run("task-child-a", "root", "task-message", 46, 47, JSON.stringify({ type: "text", text: "child a" }));
  part.run("task-unknown", "root", "missing-task-message", 48, 49, JSON.stringify({ type: "unknown" }));
  writer.close();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    const exported = buildSessionExport(db, sessionAlias("root"));
    const transcript = JSON.parse(exported.files.find((file) => file.path === "transcript.json").content);
    const task = transcript.messages.find((message) => message.id === "task-message");
    assert.deepEqual(task.parts.map((part) => part.id), ["task-child-a", "task-child-b", "task-parent"]);
    assert.equal(transcript.unattachedParts.find((part) => part.id === "task-unknown").messageId, "missing-task-message");
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});
