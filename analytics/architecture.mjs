import { deepFreeze, finiteNumber, fraction, makeAvailability, normalizeConfidence, normalizeLabel, normalizeSampleEvidence, safeRate } from './contract.mjs';
import { clampInterval } from './time.mjs';
import { pricingForModel } from '../pricing.mjs';

/** Primary-role claims require both a useful sample and this confidence. */
export const PRIMARY_ROLE_CONFIDENCE_THRESHOLD = 0.6;
const PRIMARY_ROLE_SCORE_THRESHOLD = 0.35;
const PRIMARY_ROLE_SEPARATION_THRESHOLD = 0.1;

const ROLE_ORDER = Object.freeze(["orchestrator", "implementor", "reviewer", "specialist"]);
const NODE_ORDER = Object.freeze(["agent", "model", "tool", "run"]);
const EDGE_ORDER = Object.freeze(["delegates-to", "uses-model", "calls-tool"]);
const BUILTIN_TOOLS = new Set([
  "apply_patch", "bash", "edit", "exec", "glob", "grep", "ls", "read", "search", "shell", "task", "write",
  "webfetch", "websearch",
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function number(value, fallback = 0) {
  const result = finiteNumber(value);
  return result === null ? fallback : Math.max(0, result);
}

function text(value, fallback = "unknown") {
  return normalizeLabel(value, fallback);
}

function compareEntity(left, right) {
  const leftInterval = object(left?.interval) ?? {};
  const rightInterval = object(right?.interval) ?? {};
  return (leftInterval.start ?? Number.MAX_SAFE_INTEGER) - (rightInterval.start ?? Number.MAX_SAFE_INTEGER) ||
    (leftInterval.end ?? Number.MAX_SAFE_INTEGER) - (rightInterval.end ?? Number.MAX_SAFE_INTEGER) ||
    text(left?.id, "").localeCompare(text(right?.id, ""));
}

function entityId(entity, index) {
  return text(entity?.id, `entity-${index + 1}`);
}

function identity(entity) {
  const source = object(entity?.identity) ?? {};
  return { agent: text(source.agent), model: text(source.model) };
}

function clippedInterval(entity, range) {
  return clampInterval(entity?.interval, range);
}

function tokenTotal(entity) {
  const tokens = object(entity?.tokens) ?? {};
  const explicit = finiteNumber(tokens.total);
  if (explicit !== null) return number(explicit);
  return ["input", "output", "reasoning", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + number(tokens[key]), 0);
}

function tokenBuckets(entity) {
  const tokens = object(entity?.tokens) ?? {};
  const buckets = Object.fromEntries(["input", "output", "reasoning", "cacheRead", "cacheWrite"]
    .map((key) => [key, number(tokens[key])]));
  return { ...buckets, total: tokenTotal(entity) };
}

function estimatedUsd(entity) {
  return number(object(entity?.cost)?.usd);
}

function eventCalls(event) {
  return number(event?.count, 1);
}

function eventDuration(event, range) {
  return clippedInterval(event, range)?.durationMs ?? 0;
}

function runCalls(run) {
  return list(run?.toolEvents).reduce((sum, event) => sum + eventCalls(event), 0);
}

function runErrors(run) {
  return list(run?.errors).reduce((sum, error) => sum + number(error?.count, 1), 0);
}

function sample(count, observed = count, denominator = count) {
  return normalizeSampleEvidence({ count, observed, denominator });
}

function aliases(values, prefix) {
  const map = new Map();
  [...new Set(values.filter((value) => typeof value === "string" && value !== ""))]
    .sort((left, right) => left.localeCompare(right))
    .forEach((value, index) => map.set(value, `${prefix}-${String(index + 1).padStart(3, "0")}`));
  return map;
}

function sortedRuns(snapshot) {
  return list(snapshot?.runs).map((run, index) => ({ run, key: entityId(run, index), index }))
    .sort((left, right) => compareEntity(left.run, right.run) || left.index - right.index);
}

function prepare(snapshot) {
  const range = object(snapshot?.range) ?? null;
  const ordered = sortedRuns(snapshot);
  const runs = ordered.map(({ run, key }) => ({ run, key }));
  const runKeys = new WeakMap(runs.map(({ run, key }) => [run, key]));
  const runByKey = new Map(runs.map(({ run, key }) => [key, run]));
  const runById = new Map(runs.map(({ run, key }) => [key, key]));
  const runBySession = new Map(runs.filter(({ run }) => run?.sessionId !== null && run?.sessionId !== undefined)
    .map(({ run, key }) => [text(run.sessionId, ""), key]));
  const parentKey = (run) => {
    const parent = run?.parentId === null || run?.parentId === undefined ? null : text(run.parentId, "");
    if (!parent) return null;
    const key = runById.get(parent) ?? runBySession.get(parent);
    const self = runKeys.get(run) ?? entityId(run, 0);
    return key && key !== self ? key : null;
  };
  const agentLabels = runs.map(({ run }) => identity(run).agent);
  const modelLabels = runs.map(({ run }) => identity(run).model);
  const toolLabels = runs.flatMap(({ run }) => list(run?.toolEvents).map((event) => text(event?.tool)));
  return {
    range,
    runs,
    runKeys,
    runByKey,
    parentKey,
    agentAliases: aliases(agentLabels, "agent"),
    modelAliases: aliases(modelLabels, "model"),
    toolAliases: aliases(toolLabels, "tool"),
  };
}

function parentFor(prepared, run) {
  return prepared.parentKey(run) ?? null;
}

function parentMap(prepared) {
  const map = new Map();
  prepared.runs.forEach(({ run, key }) => map.set(key, parentFor(prepared, run)));
  return map;
}

function depthMap(parents) {
  const memo = new Map();
  const visit = (alias, stack = new Set()) => {
    if (memo.has(alias)) return memo.get(alias);
    if (stack.has(alias)) return 0;
    const parent = parents.get(alias);
    if (!parent || !parents.has(parent)) {
      memo.set(alias, 0);
      return 0;
    }
    const next = new Set(stack);
    next.add(alias);
    const depth = visit(parent, next) + 1;
    memo.set(alias, depth);
    return depth;
  };
  for (const alias of parents.keys()) visit(alias);
  return memo;
}

function childrenMap(parents) {
  const children = new Map();
  for (const [child, parent] of parents) {
    if (!parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  for (const values of children.values()) values.sort((left, right) => left.localeCompare(right));
  return children;
}

function criticalPath(prepared, parents, children) {
  const durations = new Map();
  prepared.runs.forEach(({ run, key }) => durations.set(key, clippedInterval(run, prepared.range)?.durationMs ?? 0));
  const memo = new Map();
  const visit = (alias, stack = new Set()) => {
    if (memo.has(alias)) return memo.get(alias);
    if (stack.has(alias)) return 0;
    const next = new Set(stack);
    next.add(alias);
    const childPath = Math.max(0, ...(children.get(alias) ?? []).map((child) => visit(child, next)));
    const value = (durations.get(alias) ?? 0) + childPath;
    memo.set(alias, value);
    return value;
  };
  return Math.max(0, ...[...parents.keys()].map((alias) => visit(alias)));
}

function createWeight() {
  return { calls: 0, tokens: 0, estimatedUsd: 0, durationMs: 0 };
}

function addWeight(target, value) {
  target.calls += number(value.calls);
  target.tokens += number(value.tokens);
  target.estimatedUsd += number(value.estimatedUsd);
  target.durationMs += number(value.durationMs);
}

function edgeKey(type, source, target) {
  return `${type}\u0000${source}\u0000${target}`;
}

function addEdge(edges, type, source, target, weight) {
  if (!source || !target) return;
  const key = edgeKey(type, source, target);
  if (!edges.has(key)) edges.set(key, { type, source, target, weight: createWeight() });
  addWeight(edges.get(key).weight, weight);
}

function classifyTool(tool) {
  const value = String(tool).trim().toLowerCase();
  const explicit = [
    ["mcp", /^(?:mcp|mcp-server|server):[a-z0-9._-]+$/],
    ["plugin", /^(?:plugin|extension):[a-z0-9._-]+$/],
    ["builtin", /^builtin:[a-z0-9._-]+$/],
  ].filter(([, pattern]) => pattern.test(value)).map(([kind]) => kind);
  const bare = value.replace(/^builtin:/, "");
  if (explicit.length === 1) {
    return { classification: explicit[0], confidence: 0.98, reason: "explicit-prefix", evidence: [`prefix:${explicit[0]}`] };
  }
  if (explicit.length > 1) return { classification: "unknown", confidence: null, reason: "conflicting-prefix", evidence: ["conflicting-prefix"] };
  if (BUILTIN_TOOLS.has(bare)) return { classification: "builtin", confidence: 0.9, reason: "known-builtin-name", evidence: ["known-builtin-name"] };
  return { classification: "unknown", confidence: null, reason: "insufficient-evidence", evidence: [] };
}

function toolRows(prepared) {
  const byTool = new Map();
  for (const { run } of prepared.runs) {
    const agent = identity(run).agent;
    for (const event of list(run?.toolEvents)) {
      const tool = text(event?.tool);
      if (!byTool.has(tool)) byTool.set(tool, { calls: 0, routes: new Map() });
      const row = byTool.get(tool);
      const calls = eventCalls(event);
      row.calls += calls;
      row.routes.set(agent, (row.routes.get(agent) ?? 0) + calls);
    }
  }
  return [...byTool.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([tool, value]) => {
    const classification = classifyTool(tool);
    const denominator = value.calls;
    const routes = [...value.routes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([agent, numerator]) => ({
      agent,
      agentAlias: prepared.agentAliases.get(agent) ?? "agent-unknown",
      numerator,
      denominator,
      share: safeRate(numerator, denominator),
    }));
    const evidence = normalizeSampleEvidence({ count: denominator, observed: denominator, denominator });
    return {
      tool,
      toolAlias: prepared.toolAliases.get(tool) ?? "tool-unknown",
      classification: classification.classification,
      classificationEvidence: classification.evidence,
      confidence: normalizeConfidence(classification.confidence, {
        basis: classification.confidence === null ? "unknown" : "inferred",
        reason: classification.reason,
        sample: evidence,
      }),
      calls: denominator,
      denominator,
      routes,
    };
  });
}

function roleEvidence(role, signal, numerator, denominator, value) {
  return { role, signal, numerator, denominator, value: fraction(value) };
}

function pricingTier(model) {
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  const name = String(pricing.model ?? "").toLowerCase();
  if (name.startsWith("sol")) return 1;
  if (name.startsWith("terra")) return 0.66;
  if (name.startsWith("luna")) return 0.33;
  return null;
}

function attributableReview(value) {
  const reviewer = object(value);
  const agent = text(reviewer?.agent, "");
  return agent !== "" && agent !== "unknown" && (reviewer?.verdict === "PASS" || reviewer?.verdict === "ISSUE");
}

function roleReasoning(agent, primaryRole, contributions, missing, pricingTieBreak = null) {
  const contributionText = contributions.filter((entry) => entry.value !== null).map((entry) =>
    `${entry.label} ${(entry.value * 100).toFixed(0)}%`).join(", ");
  const missingText = missing.length ? missing.join(", ").replaceAll("explicit mutation tools; execution alone is not mutation evidence", "mutation evidence") : "none";
  const pricingText = pricingTieBreak ? " Price prior gated by behavior." : "";
  const text = `${primaryRole ?? "No primary role"}: ${contributionText || "none"}.${pricingText} Missing: ${missingText}.`;
  if (text.length <= 156) return text;
  const clipped = text.slice(0, 155).replace(/\s+\S*$/, "").trim();
  return `${clipped}…`;
}

function roleRows(prepared, parents, children) {
  const byAgent = new Map();
  const allRuns = prepared.runs;
  const reviewerAttributions = new Map();
  const reviewerIssues = new Map();
  const ensureAgent = (agent) => {
    if (!byAgent.has(agent)) byAgent.set(agent, []);
  };
  for (const [index, entry] of allRuns.entries()) {
    const { run } = entry;
    const agent = identity(run).agent;
    ensureAgent(agent);
    byAgent.get(agent).push({ run, key: prepared.runKeys.get(run) ?? entityId(run, index), index });
    const reviewer = object(run?.reviewer);
    const reviewerAgent = text(reviewer?.agent, "");
    if (reviewerAgent && reviewerAgent !== "unknown" && attributableReview(reviewer)) {
      ensureAgent(reviewerAgent);
      reviewerAttributions.set(reviewerAgent, (reviewerAttributions.get(reviewerAgent) ?? 0) + 1);
      if (reviewer.verdict === "ISSUE") reviewerIssues.set(reviewerAgent, (reviewerIssues.get(reviewerAgent) ?? 0) + 1);
    }
  }
  return [...byAgent.keys()].sort((left, right) => left.localeCompare(right)).map((agent) => {
    const agentRuns = byAgent.get(agent);
    const denominator = allRuns.length;
    const count = agentRuns.length;
    const childRuns = agentRuns.filter(({ key }) => parents.get(key)).length;
    const rootRuns = agentRuns.filter(({ key }) => !parents.get(key)).length;
    const reviewedRuns = agentRuns.filter(({ run }) => attributableReview(run?.reviewer)).length;
    const issueRuns = agentRuns.filter(({ run }) => attributableReview(run?.reviewer) && run?.reviewer?.verdict === "ISSUE").length;
    const parentRuns = agentRuns.filter(({ key }) => (children.get(key) ?? []).length > 0);
    const fanOutTotal = parentRuns.reduce((sum, { key }) => sum + (children.get(key) ?? []).length, 0);
    const childRunEntries = agentRuns.flatMap(({ key }) => (children.get(key) ?? []).map((child) => ({ run: prepared.runByKey.get(child) })));
    const successfulChildRuns = childRunEntries.filter(({ run }) => run && runErrors(run) === 0).length;
    const failedChildRuns = childRunEntries.filter(({ run }) => run && runErrors(run) > 0).length;
    const attributedReviews = reviewerAttributions.get(agent) ?? 0;
    const attributedIssues = reviewerIssues.get(agent) ?? 0;
    const toolCounts = new Map();
    for (const { run } of agentRuns) for (const event of list(run?.toolEvents)) {
      const tool = text(event?.tool).toLowerCase();
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + eventCalls(event));
    }
    const totalCalls = [...toolCounts.values()].reduce((sum, value) => sum + value, 0);
    const coordinationCalls = [...toolCounts.entries()].filter(([tool]) => /(?:task|agent|delegate|spawn|parallel|workflow)/.test(tool))
      .reduce((sum, [, value]) => sum + value, 0);
    const mutationCalls = [...toolCounts.entries()].filter(([tool]) => /(?:write|edit|patch|apply|create|delete|remove|rename|move|copy|mkdir|chmod)/.test(tool))
      .reduce((sum, [, value]) => sum + value, 0);
    const executionCalls = [...toolCounts.entries()].filter(([tool]) => /(?:bash|shell|exec|run|compile|build)/.test(tool))
      .reduce((sum, [, value]) => sum + value, 0);
    const verificationCalls = [...toolCounts.entries()].filter(([tool]) => /(?:test|check|lint|typecheck|verify|validate|inspect|audit|diff|status)/.test(tool))
      .reduce((sum, [, value]) => sum + value, 0);
    const specialistCalls = [...toolCounts.entries()].filter(([tool]) => /(?:read|glob|grep|search|query|inspect|analy)/.test(tool))
      .reduce((sum, [, value]) => sum + value, 0);
    const rootShare = safeRate(rootRuns, count) ?? 0;
    const childShare = safeRate(childRuns, count) ?? 0;
    const reviewShare = safeRate(reviewedRuns, count) ?? 0;
    const issueShare = safeRate(issueRuns, reviewedRuns) ?? 0;
    const attributionShare = safeRate(attributedReviews, allRuns.length) ?? 0;
    const attributedIssueShare = safeRate(attributedIssues, attributedReviews) ?? 0;
    const parentShare = safeRate(parentRuns.length, count) ?? 0;
    const averageFanOut = safeRate(fanOutTotal, parentRuns.length);
    const fanOutSignal = averageFanOut === null ? 0 : Math.min(1, averageFanOut / 4);
    const childSuccessShare = safeRate(successfulChildRuns, successfulChildRuns + failedChildRuns);
    const coordinationShare = safeRate(coordinationCalls, totalCalls) ?? 0;
    const mutationShare = safeRate(mutationCalls, totalCalls) ?? 0;
    const executionShare = safeRate(executionCalls, totalCalls) ?? 0;
    const specialistShare = safeRate(specialistCalls, totalCalls) ?? 0;
    const reviewShapedRuns = agentRuns.filter(({ run }) => {
      const runTools = list(run?.toolEvents).map((event) => [text(event?.tool).toLowerCase(), eventCalls(event)]);
      const runMutations = runTools.filter(([tool]) => /(?:write|edit|patch|apply|create|delete|remove|rename|move|copy|mkdir|chmod)/.test(tool))
        .reduce((sum, [, value]) => sum + value, 0);
      const runVerifications = runTools.filter(([tool]) => /(?:test|check|lint|typecheck|verify|validate|inspect|audit|diff|status)/.test(tool))
        .reduce((sum, [, value]) => sum + value, 0);
      const runCoordination = runTools.filter(([tool]) => /(?:task|agent|delegate|spawn|parallel|workflow)/.test(tool))
        .reduce((sum, [, value]) => sum + value, 0);
      return runMutations === 0 && runVerifications > 0 && runCoordination === 0;
    }).length;
    const reviewShaped = reviewShapedRuns > 0;
    const reviewShapedShare = safeRate(reviewShapedRuns, count) ?? 0;
    const modelTier = pricingTier(agentRuns.map(({ run }) => identity(run).model).find((model) => model !== "unknown") ?? "");
    const explicitRole = {
      orchestrator: /\b(?:orchestrator|coordinator|planner|lead)\b/i.test(agent),
      implementor: /\b(?:implementor|worker|builder|coder|developer)\b/i.test(agent),
      reviewer: /\breviewer\b/i.test(agent),
      specialist: /\b(?:specialist|researcher|analyst)\b/i.test(agent),
    };
    const orchestrator = Math.min(1,
      rootShare * 0.15 + parentShare * 0.2 + fanOutSignal * 0.2 + coordinationShare * 0.2 +
      (childSuccessShare ?? 0) * 0.15 + (explicitRole.orchestrator ? 0.35 : 0));
    const implementor = Math.min(1,
      mutationShare * 0.4 + executionShare * 0.2 + childShare * 0.2 + (childSuccessShare ?? 0) * 0.1 +
      (totalCalls > 0 ? (1 - reviewShare) * 0.1 : 0) + (explicitRole.implementor ? 0.15 : 0));
    const reviewer = Math.min(1,
      attributionShare * 0.55 + attributedIssueShare * 0.1 + reviewShapedShare * 0.25 +
      (explicitRole.reviewer && (attributedReviews > 0 || reviewShaped) ? 0.1 : 0));
    const specialist = totalCalls > 0
      ? Math.min(1, specialistShare * 0.8 +
        (explicitRole.specialist ? 0.2 : 0))
      : (explicitRole.specialist ? 0.2 : 0);
    const scores = { orchestrator, implementor, reviewer, specialist };
    const pricingTieBreak = {
      orchestrator: modelTier !== null && (coordinationCalls > 0 || parentRuns.length > 0) ? modelTier * 0.03 : 0,
      reviewer: modelTier !== null && (reviewShaped || attributedReviews > 0) ? modelTier * 0.02 : 0,
    };
    const evidence = [
      roleEvidence("orchestrator", "root-share", rootRuns, count, rootShare),
      roleEvidence("orchestrator", "child-run-share", childRuns, count, childShare),
      roleEvidence("orchestrator", "coordination-tool-share", coordinationCalls, totalCalls, coordinationShare),
      roleEvidence("orchestrator", "parent-run-share", parentRuns.length, count, parentShare),
      roleEvidence("orchestrator", "average-parent-fan-out", fanOutTotal, parentRuns.length, averageFanOut),
      roleEvidence("orchestrator", "successful-child-share", successfulChildRuns, successfulChildRuns + failedChildRuns, childSuccessShare),
      roleEvidence("orchestrator", "explicit-role-name", explicitRole.orchestrator ? 1 : 0, 1, explicitRole.orchestrator ? 1 : 0),
      roleEvidence("implementor", "child-run-share", childRuns, count, childShare),
      roleEvidence("implementor", "modifying-tool-share", mutationCalls, totalCalls, mutationShare),
      roleEvidence("implementor", "execution-tool-share", executionCalls, totalCalls, executionShare),
      roleEvidence("implementor", "read-vs-modify-tool-mix", mutationCalls, specialistCalls + mutationCalls, safeRate(mutationCalls, specialistCalls + mutationCalls)),
      roleEvidence("implementor", "successful-child-share", successfulChildRuns, successfulChildRuns + failedChildRuns, childSuccessShare),
      roleEvidence("implementor", "explicit-role-name", explicitRole.implementor ? 1 : 0, 1, explicitRole.implementor ? 1 : 0),
      roleEvidence("reviewer", "reviewer-attribution-share", reviewedRuns, count, reviewShare),
      roleEvidence("reviewer", "issue-verdict-share", issueRuns, reviewedRuns, issueShare),
      roleEvidence("reviewer", "reviewer-attribution-share", attributedReviews, allRuns.length, attributionShare),
      roleEvidence("reviewer", "attributed-issue-share", attributedIssues, attributedReviews, attributedIssueShare),
      roleEvidence("reviewer", "review-shaped-verification-runs", reviewShapedRuns, count, reviewShapedShare),
      roleEvidence("reviewer", "explicit-role-name", explicitRole.reviewer ? 1 : 0, 1, explicitRole.reviewer ? 1 : 0),
      roleEvidence("specialist", "read-search-tool-share", specialistCalls, totalCalls, specialistShare),
      roleEvidence("specialist", "modifying-tool-share", mutationCalls, totalCalls, mutationShare),
      roleEvidence("specialist", "read-vs-modify-tool-mix", specialistCalls, specialistCalls + mutationCalls, safeRate(specialistCalls, specialistCalls + mutationCalls)),
      roleEvidence("specialist", "explicit-role-name", explicitRole.specialist ? 1 : 0, 1, explicitRole.specialist ? 1 : 0),
      ...(pricingTieBreak.orchestrator > 0 ? [roleEvidence("orchestrator", "pricing-tier-tie-breaker", pricingTieBreak.orchestrator, 1, pricingTieBreak.orchestrator)] : []),
      ...(pricingTieBreak.reviewer > 0 ? [roleEvidence("reviewer", "pricing-tier-tie-breaker", pricingTieBreak.reviewer, 1, pricingTieBreak.reviewer)] : []),
    ];
    const observedRuns = agentRuns.filter(({ run }) => identity(run).agent !== "unknown").length;
    const evidenceCount = count + attributedReviews;
    const observedEvidence = observedRuns + attributedReviews;
    const roleSample = sample(evidenceCount, observedEvidence, Math.max(denominator, evidenceCount));
    const confidenceValue = evidenceCount === 0 ? null : Math.min(1, observedEvidence / 10) *
      (totalCalls === 0 && !explicitRole.orchestrator && !explicitRole.implementor && !explicitRole.reviewer && !explicitRole.specialist ? 0.7 : 1) *
      (reviewShaped && attributedReviews === 0 ? 0.75 : 1);
    const confidence = normalizeConfidence(confidenceValue, {
      basis: "derived",
      reason: reviewShaped && attributedReviews === 0 ? "review-shaped-without-attributable-verdict" : evidenceCount >= 10 ? "sampled" : attributedReviews > 0 ? "reviewer-attribution" : "limited-sample",
      sample: roleSample,
    });
    const rankingScore = (role) => scores[role] + (pricingTieBreak[role] ?? 0);
    const primaryCandidate = ROLE_ORDER.slice().sort((left, right) => rankingScore(right) - rankingScore(left) || ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right))[0];
    const runnerUp = ROLE_ORDER.filter((role) => role !== primaryCandidate).sort((left, right) => rankingScore(right) - rankingScore(left) || ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right))[0];
    const roleSeparation = rankingScore(primaryCandidate) - rankingScore(runnerUp);
    const meaningfulEvidence = totalCalls > 0 || parentRuns.length > 0 || attributedReviews > 0 || reviewShaped || explicitRole[primaryCandidate];
    const missingEvidence = [];
    if (totalCalls === 0) missingEvidence.push("tool-call behavior");
    if (primaryCandidate === "orchestrator" && parentRuns.length === 0 && coordinationCalls === 0) missingEvidence.push("parent/delegation behavior");
    if (primaryCandidate === "implementor" && mutationCalls === 0) missingEvidence.push("explicit mutation tools; execution alone is not mutation evidence");
    if (primaryCandidate === "reviewer" && attributedReviews === 0) missingEvidence.push("attributable PASS/ISSUE reviewer outcomes");
    if (primaryCandidate === "reviewer" && reviewShapedRuns === 0) missingEvidence.push("non-edit verification runs");
    const primaryRole = confidence.value !== null && confidence.value >= PRIMARY_ROLE_CONFIDENCE_THRESHOLD &&
      rankingScore(primaryCandidate) >= PRIMARY_ROLE_SCORE_THRESHOLD && roleSeparation >= PRIMARY_ROLE_SEPARATION_THRESHOLD && meaningfulEvidence
      ? primaryCandidate : null;
    return {
      agent,
      agentAlias: prepared.agentAliases.get(agent) ?? "agent-unknown",
      scores,
      primaryRole,
      evidence,
      sample: roleSample,
      confidence,
      reasoning: roleReasoning(agent, primaryRole, [
        { label: "orch", value: orchestrator },
        { label: "impl", value: implementor },
        { label: "review", value: reviewer },
        { label: "specialist", value: specialist },
      ], missingEvidence, pricingTieBreak.orchestrator > 0 || pricingTieBreak.reviewer > 0),
    };
  });
}

function executionRows(prepared, depths) {
  const aggregates = new Map();
  const addBuckets = (target, source) => {
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]) {
      target[key] += number(source?.[key]);
    }
  };
  for (const { run, key } of prepared.runs) {
    const interval = clippedInterval(run, prepared.range);
    const identityValue = identity(run);
    const depth = depths.get(key) ?? 0;
    const aggregateKey = `${depth}\u0000${identityValue.agent}\u0000${identityValue.model}`;
    if (!aggregates.has(aggregateKey)) aggregates.set(aggregateKey, {
      depth,
      agent: identityValue.agent,
      model: identityValue.model,
      count: 0,
      durationMs: 0,
      tokens: 0,
      tokenBuckets: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      estimatedUsd: 0,
      costBasisCounts: {},
      toolCalls: 0,
      errors: 0,
    });
    const row = aggregates.get(aggregateKey);
    row.count += 1;
    row.durationMs += interval?.durationMs ?? 0;
    row.tokens += tokenTotal(run);
    addBuckets(row.tokenBuckets, tokenBuckets(run));
    row.estimatedUsd += estimatedUsd(run);
    const basis = text(object(run?.cost)?.basis, "unavailable");
    if (basis !== "unavailable") row.costBasisCounts[basis] = (row.costBasisCounts[basis] ?? 0) + 1;
    row.toolCalls += runCalls(run);
    row.errors += runErrors(run);
  }
  return [...aggregates.values()].map((row) => {
    const bases = Object.keys(row.costBasisCounts).sort();
    const costBasis = bases.length === 1 ? bases[0] : bases.length > 1 ? "mixed" : "unavailable";
    const { costBasisCounts: ignored, ...publicRow } = row;
    return { ...publicRow, costBasis };
  }).sort((left, right) => left.depth - right.depth || left.agent.localeCompare(right.agent) || left.model.localeCompare(right.model));
}

function baseEvidence(runs, reason = "present") {
  const observed = runs.filter(({ run }) => identity(run).agent !== "unknown").length;
  const sampleEvidence = sample(runs.length, observed, runs.length);
  return {
    availability: makeAvailability(runs.length > 0, { basis: runs.length > 0 ? "observed" : "unavailable", reason: runs.length > 0 ? reason : "no-runs", sample: sampleEvidence }),
    sample: sampleEvidence,
    confidence: normalizeConfidence(runs.length === 0 ? null : Math.min(1, observed / 10), {
      basis: "derived",
      reason: runs.length >= 10 ? "sampled" : "limited-sample",
      sample: sampleEvidence,
    }),
  };
}

function delegationSummary(prepared, parents, depths, children) {
  const delegations = [...parents.values()].filter(Boolean).length;
  const parentCount = children.size;
  const childTokens = prepared.runs.reduce((sum, { run, key }) => parents.get(key) ? sum + tokenTotal(run) : sum, 0);
  const parentTokens = prepared.runs.reduce((sum, { run, key }) => children.has(key) ? sum + tokenTotal(run) : sum, 0);
  const fanOut = safeRate(delegations, parentCount);
  const maxDepth = Math.max(0, ...depths.values());
  const evidence = sample(prepared.runs.length, delegations, prepared.runs.length);
  return {
    availability: makeAvailability(delegations > 0, {
      basis: delegations > 0 ? "observed" : "unavailable",
      reason: delegations > 0 ? "parent-links" : "no-delegations",
      sample: evidence,
    }),
    sample: evidence,
    confidence: normalizeConfidence(delegations > 0 ? Math.min(1, delegations / 10) : null, {
      basis: "derived",
      reason: delegations >= 10 ? "sampled" : delegations > 0 ? "limited-sample" : "no-delegations",
      sample: evidence,
    }),
    delegations,
    parentCount,
    fanOut,
    maxFanOut: Math.max(0, ...[...children.values()].map((values) => values.length)),
    maxDepth,
    parentChildTokenRatio: safeRate(childTokens, parentTokens),
    parentTokens,
    childTokens,
    approximateCriticalPathMs: criticalPath(prepared, parents, children),
  };
}

function topology(prepared, parents) {
  const nodes = new Map();
  const edges = new Map();
  const ensureNode = (id, type, label) => {
    if (!nodes.has(id)) nodes.set(id, { id, type, label, runs: 0, calls: 0, tokens: 0, estimatedUsd: 0, durationMs: 0 });
    return nodes.get(id);
  };
  for (const { run, key } of prepared.runs) {
    const runIdentity = identity(run);
    const agentId = prepared.agentAliases.get(runIdentity.agent) ?? "agent-unknown";
    const modelId = prepared.modelAliases.get(runIdentity.model) ?? "model-unknown";
    const agentNode = ensureNode(agentId, "agent", runIdentity.agent);
    const modelNode = ensureNode(modelId, "model", runIdentity.model);
    const durationMs = clippedInterval(run, prepared.range)?.durationMs ?? 0;
    const tokens = tokenTotal(run);
    const usd = estimatedUsd(run);
    const calls = runCalls(run);
    for (const node of [agentNode, modelNode]) {
      node.runs += 1;
      node.tokens += tokens;
      node.estimatedUsd += usd;
      node.durationMs += durationMs;
    }
    agentNode.calls += calls;
    modelNode.calls += 1;
    addEdge(edges, "uses-model", agentId, modelId, { calls: 1, tokens, estimatedUsd: usd, durationMs });
    const parent = parents.get(key);
    const parentRun = parent ? prepared.runByKey.get(parent) : null;
    const parentIdentity = parentRun ? identity(parentRun) : null;
    const parentAgentId = parentIdentity ? prepared.agentAliases.get(parentIdentity.agent) ?? "agent-unknown" : null;
    if (parentAgentId) addEdge(edges, "delegates-to", parentAgentId, agentId, { calls: 1, tokens, estimatedUsd: usd, durationMs });
    for (const event of list(run?.toolEvents)) {
      const tool = text(event?.tool);
      const toolId = prepared.toolAliases.get(tool) ?? "tool-unknown";
      const toolNode = ensureNode(toolId, "tool", tool);
      const eventCallCount = eventCalls(event);
      const eventDurationMs = eventDuration(event, prepared.range);
      const eventTokens = tokenTotal(event);
      const eventUsd = estimatedUsd(event);
      toolNode.calls += eventCallCount;
      toolNode.tokens += eventTokens;
      toolNode.estimatedUsd += eventUsd;
      toolNode.durationMs += eventDurationMs;
      addEdge(edges, "calls-tool", agentId, toolId, {
        calls: eventCallCount,
        tokens: eventTokens,
        estimatedUsd: eventUsd,
        durationMs: eventDurationMs,
      });
    }
    // Run-level tokens/cost remain on their aggregate agent/model nodes rather
    // than being assigned to individual tool calls.
  }
  const orderedNodes = [...nodes.values()].sort((left, right) => NODE_ORDER.indexOf(left.type) - NODE_ORDER.indexOf(right.type) || left.id.localeCompare(right.id));
  const orderedEdges = [...edges.values()].sort((left, right) => EDGE_ORDER.indexOf(left.type) - EDGE_ORDER.indexOf(right.type) ||
    left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
  return { nodes: orderedNodes, edges: orderedEdges };
}

function summaryText(prepared, parents, tools) {
  const agents = new Set(prepared.runs.map(({ run }) => identity(run).agent)).size;
  const delegations = [...parents.values()].filter(Boolean).length;
  const calls = tools.reduce((sum, tool) => sum + tool.calls, 0);
  return `${agents} agent${agents === 1 ? "" : "s"} across ${prepared.runs.length} run${prepared.runs.length === 1 ? "" : "s"}; ` +
    `${delegations} delegation${delegations === 1 ? "" : "s"}; ${calls} tool call${calls === 1 ? "" : "s"} across ${tools.length} tool${tools.length === 1 ? "" : "s"}.`;
}

function analyzePrepared(prepared) {
  const parents = parentMap(prepared);
  const depths = depthMap(parents);
  const children = childrenMap(parents);
  const tools = toolRows(prepared);
  const evidence = baseEvidence(prepared.runs);
  const topologyResult = topology(prepared, parents);
  const delegation = delegationSummary(prepared, parents, depths, children);
  const roles = roleRows(prepared, parents, children);
  return { prepared, parents, depths, children, tools, evidence, topologyResult, delegation, roles };
}

export function analyzeArchitecture(snapshot = {}) {
  const result = analyzePrepared(prepare(snapshot));
  return deepFreeze({
    availability: result.evidence.availability,
    sample: result.evidence.sample,
    confidence: result.evidence.confidence,
    provenance: {
      source: "normalized-snapshot",
      method: "deterministic-topology",
      aliasing: "privacy-safe-deterministic",
      sample: result.evidence.sample,
    },
    nodes: result.topologyResult.nodes,
    edges: result.topologyResult.edges,
    roles: result.roles,
    toolRouting: result.tools,
    delegation: result.delegation,
    summary: summaryText(result.prepared, result.parents, result.tools),
  });
}

export function analyzeExecution(snapshot = {}) {
  const result = analyzePrepared(prepare(snapshot));
  const rows = executionRows(result.prepared, result.depths);
  const children = [...result.parents.values()].filter(Boolean).length;
  const roots = result.prepared.runs.length - children;
  const fanOut = result.delegation.fanOut;
  const summary = {
    roots,
    children,
    maxDepth: result.delegation.maxDepth,
    fanOut,
    approximateCriticalPathMs: result.delegation.approximateCriticalPathMs,
  };
  return deepFreeze({
    availability: result.evidence.availability,
    sample: result.evidence.sample,
    confidence: result.evidence.confidence,
    provenance: {
      source: "normalized-snapshot",
       method: "deterministic-execution-aggregates",
      aliasing: "privacy-safe-deterministic",
      sample: result.evidence.sample,
    },
    runs: rows,
    summary,
    summaryText: `${roots} root${roots === 1 ? "" : "s"}, ${children} child run${children === 1 ? "" : "s"}, ` +
      `maximum depth ${summary.maxDepth}, average fan-out ${fanOut === null ? "unknown" : fanOut}.`,
  });
}
