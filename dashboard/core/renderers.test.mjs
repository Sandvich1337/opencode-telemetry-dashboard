import assert from "node:assert/strict";
import test from "node:test";

import { createRenderers } from "./renderers.mjs";

function rootFixture() {
  return Array.from({ length: 12 }, (_, index) => [
    { id: `root-${index}`, kind: "root", timestamp: 1_000 + index },
    { id: `child-${index}`, kind: "child", parentAlias: `root-${index}`, timestamp: 1_001 + index },
  ]).flat();
}

function fakeRoot() {
  const elements = new Map([
    ["session", { innerHTML: "", value: "" }],
    ["showSessionTitles", { checked: false }],
    ["topology", { innerHTML: "" }],
  ]);
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: "", value: "" });
      return elements.get(id);
    },
    elements,
  };
}

test("session selector renders all roots and preserves an older selection", () => {
  const root = fakeRoot();
  const renderers = createRenderers(root);
  renderers.renderSessionOptions(rootFixture(), "root-0");
  const markup = root.elements.get("session").innerHTML;
  assert.equal((markup.match(/<option /g) || []).length, 13);
  assert.match(markup, /value="root-0"/);
  assert.match(markup, /value="root-1"/);
  assert.match(markup, /value="root-11"/);
  assert.equal(root.elements.get("session").value, "root-0");
});

test("unselected topology renders all roots while selected descendants remain available", () => {
  const root = fakeRoot();
  const renderers = createRenderers(root);
  const sessions = rootFixture();
  renderers.renderTopology(sessions);
  let markup = root.elements.get("topology").innerHTML;
  assert.equal((markup.match(/data-session="root-/g) || []).length, 12);
  assert.match(markup, /data-session="root-11"/);
  assert.match(markup, /data-session="root-1"/);

  renderers.renderTopology(sessions, "child-0");
  markup = root.elements.get("topology").innerHTML;
  assert.match(markup, /data-session="root-0"/);
  assert.match(markup, /data-session="child-0"/);
  assert.doesNotMatch(markup, /data-session="root-11"/);
});
