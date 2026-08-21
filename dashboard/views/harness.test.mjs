import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createHarnessView, renderHarnessView } from "./harness.mjs";

test("exposes exactly one named Harness region through the panel heading", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const panel = html.match(/<section id="harnessViewPanel"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(panel, /aria-labelledby="harness-view-title"/);
  assert.equal((panel.match(/aria-labelledby="harness-view-title"/g) || []).length, 1);
  assert.doesNotMatch(panel, /harness-view-label|class="sr-only"/);
  assert.equal((panel.match(/role="region"/g) || []).length, 0);
  assert.equal((panel.match(/aria-label="Harness"/g) || []).length, 0);
});

test("uses one visible Harness h2 followed by descending h3 subsections", () => {
  const html = renderHarnessView();
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/g)].map((match) => Number(match[1]));
  assert.deepEqual(headings, [2, 3, 3, 3, 3]);
  assert.match(html, /<h2 id="harness-view-title">Harness<\/h2>/);
  assert.equal((html.match(/<h2\b/g) || []).length, 1);
  assert.equal((html.match(/<h1\b/g) || []).length, 0);
});

test("renders the planned formula with explicit unavailable values", () => {
  const html = renderHarnessView();
  assert.match(html, /total attributable harness cost in scope \/ unique verified accepted changes in scope/);
  assert.match(html, /Unavailable — harness outcome data is not connected/);
  assert.match(html, /<span class="harness-unavailable" role="status">Unavailable — harness outcome data is not connected<\/span>/);
  assert.match(html, /Eligible task volume/);
  assert.match(html, /Unique verified accepted changes/);
  assert.match(html, /Verification\/review\/gate coverage/);
  assert.match(html, /Repair loops per accepted change/);
  assert.match(html, /Route-tier\/escalation mix/);
  assert.doesNotMatch(html, /reviewerPassEconomics|reviewer[- ]linked PASS|estimated/i);
  assert.doesNotMatch(html, />0(?:\.0+)?</);
});

test("renders only the evidenced T5 guarantees and no fabricated lower-tier matrix", () => {
  const html = renderHarnessView();
  assert.match(html, /Any critical, expensive-to-be-wrong, destructive\/irreversible, security-sensitive, migratory, or externally contractual condition routes to T5/);
  assert.match(html, /T5 requires Sol Architect Max, independent review, Sol Gate, and one bounded writer/);
  assert.match(html, /Ambiguity that could increase risk must re-escalate and must not downgrade/);
  assert.match(html, /No complete T0–T4 matrix is claimed/);
  assert.match(html, /role="region" aria-label="Evidenced T5 routing guarantees" tabindex="0"/);
  assert.match(html, /<caption>Evidenced T5 routing guarantees<\/caption>/);
});

test("names exactly four independent future pass-rate dimensions with audit fields", () => {
  const html = renderHarnessView();
  assert.equal((html.match(/data-harness-dimension=/g) || []).length, 4);
  for (const dimension of ["task category", "difficulty", "risk", "oracle quality"]) assert.match(html, new RegExp(`>${dimension}<`));
  assert.match(html, /Unknown observations retained; eventual rows require numerator, denominator, rate, sample\/coverage, basis, and policy\/schema version\./);
  assert.match(html, /no Cartesian or cross-dimension rates are claimed/);
});

test("is deterministic, idempotent, and clears on destroy", () => {
  const target = { innerHTML: "" };
  const view = createHarnessView();
  const first = view.mount({ element: target });
  assert.equal(target.innerHTML, first);
  assert.equal(first, renderHarnessView());
  const second = view.update({ element: target, payload: { analytics: { efficiency: { reviewerPassEconomics: { cost: 1 } } } } });
  assert.equal(target.innerHTML, second);
  assert.equal(second, first);
  view.destroy();
  assert.equal(target.innerHTML, "");
});

function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))]
    .map((match) => match[1])
    .find((block) => block.includes("--foreground")) || "";
}

function hexToken(block, token) {
  return block.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-f]{6})`, "i"))?.[1] || "";
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const values = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset + 1, offset + 3), 16));
  return 0.2126 * channel(values[0]) + 0.7152 * channel(values[1]) + 0.0722 * channel(values[2]);
}

function contrast(foreground, background) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

test("uses the theme-aware foreground token with verified contrast and no old fallback", () => {
  const harnessCss = readFileSync(new URL("./harness.css", import.meta.url), "utf8");
  const sharedCss = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(harnessCss, /#a16207/i);
  assert.match(harnessCss, /--harness-unavailable:\s*var\(--foreground\)/);
  assert.match(harnessCss, /\.harness-unavailable\s*\{[^}]*color:\s*var\(--harness-unavailable\)/s);

  const light = cssBlock(sharedCss, ":root");
  const dark = cssBlock(sharedCss, 'html[data-theme="dark"]');
  const systemDark = [...sharedCss.matchAll(/html\[data-theme="system"\]\s*\{([\s\S]*?)\}/g)]
    .map((match) => match[1]).find((block) => block.includes("--foreground")) || "";
  for (const theme of [light, dark, systemDark]) {
    const foreground = hexToken(theme, "--foreground");
    assert.ok(foreground, "theme foreground token must be defined");
    for (const surface of ["--background", "--card", "--surface-raised", "--muted"]) {
      const background = hexToken(theme, surface);
      assert.ok(background, `${surface} must be defined for contrast verification`);
      assert.ok(contrast(foreground, background) >= 4.5, `${surface} contrast must be at least 4.5:1`);
    }
  }
});
