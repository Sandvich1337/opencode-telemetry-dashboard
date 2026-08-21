import { analyzeArchitecture, analyzeExecution } from './architecture.mjs';
import { analyzeEfficiency } from './efficiency.mjs';
import { analyzeThroughput } from './throughput.mjs';
import { deepFreeze, makeAvailability, normalizeConfidence, normalizeEvidence, normalizeSampleEvidence } from './contract.mjs';

const RUN_THRESHOLD = 10;
const CALL_THRESHOLD = 20;
const SEVERITY_ORDER = Object.freeze({ error: 0, warning: 1, info: 2 });
const ACCESS_CHANNEL_ORDER = Object.freeze([
  "web", "memory", "code-graph", "indexed-code", "delegation", "execution", "editing", "filesystem", "other",
]);
const ACCESS_CHANNEL_LABELS = Object.freeze({
  web: "Web access",
  memory: "Memory access",
  "code-graph": "Code graph",
  "indexed-code": "Indexed code",
  delegation: "Delegation",
  execution: "Execution",
  editing: "Editing",
  filesystem: "Filesystem",
  other: "Other tools",
});
const BUILTIN_TOOL_NAMES = new Set([
  "apply_patch", "bash", "edit", "exec", "glob", "grep", "ls", "read", "search", "shell", "task", "write",
  "webfetch", "websearch",
]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function sample(count, observed = count, denominator = count) {
  return normalizeSampleEvidence({ count, observed, denominator });
}

function confidence(value, reason, evidenceSample, basis = "derived") {
  return normalizeConfidence(value, { basis, reason, sample: evidenceSample });
}

function item(code, severity, title, evidence, itemSample, itemConfidence, suggestion, reasoning) {
  return {
    code,
    severity,
    title,
    evidence: [...evidence],
    sample: itemSample,
    confidence: itemConfidence,
    suggestion,
    reasoning: causalReasoning(reasoning),
  };
}

function nonNegative(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? Math.max(0, result) : fallback;
}

function conciseText(value, limit = 156) {
  const text = String(value ?? "").replace(/[;&|<>$`]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit - 1).replace(/\s+\S*$/, "").trim();
  return `${clipped}…`;
}

function causalReasoning(value) {
  const text = String(value ?? "").replace(/[;&|<>$`]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length >= 160) throw new Error("Advice reasoning must be explicit and shorter than 160 characters");
  return text;
}

function contributionReasoning(contributions, missing = []) {
  const contributionText = contributions.filter((entry) => entry.value !== null).map((entry) =>
    `${entry.label} ${(entry.value * 100).toFixed(0)}%`).join(", ");
  const missingText = missing.length ? missing.map((entry) => String(entry)
    .replace("navigation target 2/run", "navigation target")
    .replace("PASS/ISSUE outcomes per parent", "review outcomes")
    .replace("attributable PASS/ISSUE reviewer outcomes", "review outcomes")
    .replace("established coordinator", "coordinator")
    .replace("coordinator reads <=50%", "read guard")).join(", ") : "none";
  return conciseText(`Contributions: ${contributionText || "none"}. Missing evidence: ${missingText}.`);
}

function runAgent(run) {
  const identity = object(run?.identity);
  return String(identity?.agent ?? run?.agent ?? "unknown").trim() || "unknown";
}

function runCalls(run) {
  return list(run?.toolEvents).reduce((sum, event) => sum + nonNegative(event?.count, 1), 0);
}

function runErrors(run) {
  return list(run?.errors).reduce((sum, error) => sum + nonNegative(error?.count, 1), 0);
}

function runCost(run) {
  const cost = object(run?.cost);
  return nonNegative(cost?.usd ?? cost?.estimatedUSD ?? run?.cost);
}

function attributableReviewer(run) {
  const reviewer = object(run?.reviewer);
  const agent = String(reviewer?.agent ?? "").trim().toLowerCase();
  return Boolean(agent && agent !== "unknown" && (reviewer?.verdict === "PASS" || reviewer?.verdict === "ISSUE"));
}

function toolName(event) {
  return String(event?.tool ?? "unknown").trim() || "unknown";
}

function explicitProvider(tool) {
  const value = tool.toLowerCase();
  if (/(?:^|[\s:/._@#-])openchamber-web(?:$|[\s:/._@#-])/.test(value)) return "openchamber-web";
  if (/(?:^|[\s:/._@#-])websearch(?:$|[\s:/._@#-])/.test(value)) return "websearch";
  if (/(?:^|[\s:/._@#-])webfetch(?:$|[\s:/._@#-])/.test(value)) return "webfetch";
  if (/(?:^|[:._-])argus(?:$|[:._-])/.test(value)) return "argus";
  if (/(?:^|[:._-])native-web(?:$|[:._-])/.test(value)) return "native-web";
  if (/(?:^|[:._-])exa(?:$|[:._-])/.test(value)) return "exa";
  if (/(?:^|[\s:/._@#-])mcp(?:$|[\s:/._@#-])/.test(value)) return "mcp";
  return "unknown";
}

function accessClassification(tool) {
  const value = tool.toLowerCase();
  if (/^(?:mcp|mcp-server|server)[\s:/._@#-][a-z0-9._@#/-]+$/.test(value)) return "mcp";
  if (/^(?:plugin|extension):[a-z0-9._-]+$/.test(value)) return "plugin";
  if (/^builtin:[a-z0-9._-]+$/.test(value) || BUILTIN_TOOL_NAMES.has(value.replace(/^builtin:/, ""))) return "builtin";
  return "unknown";
}

function accessChannel(tool) {
  const value = tool.toLowerCase();
  if (/graphify/.test(value)) return "code-graph";
  if (/(?:^|[._:-])aft(?:$|[._:-])/.test(value)) return "indexed-code";
  if (/(?:web|browser|fetch|exa)/.test(value)) return "web";
  if (/(?:memory|recall|context)/.test(value) || /^ctx(?:$|[._:-])/.test(value)) return "memory";
  if (/(?:task|agent|delegate|spawn|parallel|workflow)/.test(value)) return "delegation";
  if (/(?:bash|shell|exec|run|python|node)/.test(value)) return "execution";
  if (/(?:write|edit|patch|apply)/.test(value)) return "editing";
  if (/(?:read|glob|grep|find|ls|file|search)/.test(value)) return "filesystem";
  return "other";
}

function accessChannels(snapshot) {
  const byChannel = new Map();
  for (const run of list(snapshot?.runs)) for (const event of list(run?.toolEvents)) {
    const tool = toolName(event);
    const key = accessChannel(tool);
    if (!byChannel.has(key)) byChannel.set(key, { calls: 0, tools: new Map() });
    const channel = byChannel.get(key);
    const calls = nonNegative(event?.count, 1);
    channel.calls += calls;
    if (!channel.tools.has(tool)) channel.tools.set(tool, {
      calls: 0,
      classification: accessClassification(tool),
      provider: explicitProvider(tool),
    });
    channel.tools.get(tool).calls += calls;
  }
  return ACCESS_CHANNEL_ORDER.filter((key) => byChannel.has(key)).map((key) => {
    const source = byChannel.get(key);
    const tools = [...source.tools.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([tool, value]) => ({
      tool,
      calls: value.calls,
      classification: value.classification,
      provider: value.provider,
    }));
    const providers = [...new Set(tools.map((tool) => tool.provider).filter((provider) => provider !== "unknown"))]
      .sort((left, right) => left.localeCompare(right));
    return {
      key,
      label: ACCESS_CHANNEL_LABELS[key],
      calls: source.calls,
      tools,
      evidence: [`calls:${source.calls}`, `tools:${tools.length}`, ...(providers.length ? [`providers:${providers.join(",")}`] : ["providers:unknown"])],
    };
  });
}

function totalCalls(rows) {
  return rows.reduce((sum, run) => sum + runCalls(run), 0);
}

function readSearchCalls(rows) {
  return rows.flatMap((run) => list(run?.toolEvents)).filter((event) =>
    /(?:read|grep|glob|search|query|inspect|analy)/i.test(toolName(event))).reduce((sum, event) => sum + nonNegative(event?.count, 1), 0);
}

function roleRunCounts(snapshot, architecture) {
  const rows = list(snapshot?.runs);
  const roles = list(architecture?.roles);
  const byAgent = new Map();
  for (const run of rows) byAgent.set(runAgent(run), (byAgent.get(runAgent(run)) ?? 0) + 1);
  return roles.map((role) => ({ ...role, runCount: byAgent.get(role.agent) ?? 0 })).sort((left, right) =>
    (Number(right.scores?.orchestrator ?? 0) - Number(left.scores?.orchestrator ?? 0)) || String(left.agent).localeCompare(String(right.agent)));
}

function coordinatorReadAdvice(snapshot, architecture) {
  const rows = list(snapshot?.runs);
  const calls = totalCalls(rows);
  if (rows.length < RUN_THRESHOLD || calls < CALL_THRESHOLD) return [];
  const roleRows = roleRunCounts(snapshot, architecture);
  const coordinator = roleRows.find((role) => Number(role.scores?.orchestrator ?? 0) >= Number(role.scores?.implementor ?? 0) &&
    Number(role.scores?.orchestrator ?? 0) >= 0.5 && role.runCount > 0);
  if (!coordinator) return [];
  const coordinatorRuns = rows.filter((run) => runAgent(run) === coordinator.agent);
  const coordinatorCalls = totalCalls(coordinatorRuns);
  const coordinatorReadSearchCalls = readSearchCalls(coordinatorRuns);
  const cost = coordinatorRuns.reduce((sum, run) => sum + runCost(run), 0);
  const totalCost = rows.reduce((sum, run) => sum + runCost(run), 0);
  const navigationCalls = coordinatorRuns.flatMap((run) => list(run.toolEvents)).filter((event) =>
    /graphify|(?:^|[._:-])aft(?:$|[._:-])/i.test(toolName(event))).reduce((sum, event) => sum + nonNegative(event?.count, 1), 0);
  const readShare = coordinatorCalls > 0 ? coordinatorReadSearchCalls / coordinatorCalls : 0;
  const costShare = totalCost > 0 ? cost / totalCost : 0;
  const navigationShare = coordinatorCalls > 0 ? navigationCalls / coordinatorCalls : null;
  if (coordinatorReadSearchCalls < Math.max(10, coordinatorCalls * 0.5) || cost <= 0 || costShare < 0.4 ||
    navigationShare === null || navigationShare >= 0.25) return [];
  const itemSample = sample(rows.length, coordinatorRuns.length, rows.length);
  return [item(
    "coordinator-read-search-cost",
    "warning",
    "Coordinator read/search work is high-cost with low Graphify/AFT navigation share",
    [
      `coordinator:${coordinator.agent}`,
      `coordinator-runs:${coordinatorRuns.length}`,
      `coordinator-calls:${coordinatorCalls}`,
      `read-search-calls:${coordinatorReadSearchCalls}`,
      `read-search-share:${readShare}`,
      `coordinator-cost-usd:${cost}`,
      `coordinator-cost-share:${costShare}`,
      `graphify-aft-calls:${navigationCalls}`,
      `graphify-aft-share:${navigationShare}`,
      ...(navigationCalls === 0 ? ["navigation-availability:when-available"] : []),
    ],
    itemSample,
    confidence(Math.min(1, Math.max(readShare, costShare)), "sampled", itemSample),
    "Prefer observed Graphify/AFT-style navigation when available before repeating broad read/search work.",
    "High coordinator search cost with low indexed navigation makes broad rereads the avoidable driver of this finding.",
  )];
}

function inferredWorkerAgents(architecture) {
  return new Set(list(architecture?.roles).filter((role) => {
    if (role?.primaryRole === "implementor" || role?.primaryRole === "specialist") return true;
    const scores = object(role?.scores) ?? {};
    const candidate = Number(scores.implementor ?? 0) >= Number(scores.specialist ?? 0) ? "implementor" : "specialist";
    return Number(scores[candidate] ?? 0) >= 0.2 && Number(scores[candidate] ?? 0) >= Number(scores.orchestrator ?? 0) &&
      Number(scores[candidate] ?? 0) >= Number(scores.reviewer ?? 0);
  }).map((role) => role.agent));
}

function relaunchMetrics(snapshot, architecture) {
  const rows = list(snapshot?.runs);
  const workerAgents = inferredWorkerAgents(architecture);
  const ordered = rows.slice().sort((left, right) => {
    const leftStart = Number(object(left?.interval)?.start ?? Number.MAX_SAFE_INTEGER);
    const rightStart = Number(object(right?.interval)?.start ?? Number.MAX_SAFE_INTEGER);
    return leftStart - rightStart || runAgent(left).localeCompare(runAgent(right)) || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
  });
  const workerErrors = ordered.filter((run) => runErrors(run) > 0 && workerAgents.has(runAgent(run)));
  const parentOf = (run) => {
    if (run?.parentId === undefined || run.parentId === null || String(run.parentId).trim() === "") return null;
    return String(run.parentId);
  };
  const pressureRows = workerErrors.flatMap((errorRun) => {
    const errorEnd = Number(object(errorRun?.interval)?.end ?? object(errorRun?.interval)?.start ?? -Infinity);
    const parent = parentOf(errorRun);
    if (parent === null) return [];
    const next = ordered.find((candidate) => candidate !== errorRun && runAgent(candidate) === runAgent(errorRun) &&
      Number(object(candidate?.interval)?.start ?? Number.MAX_SAFE_INTEGER) >= errorEnd && parentOf(candidate) === parent);
    return next ? [{ errorRun, next, parent }] : [];
  });
  return { workerAgents, workerErrors, pressureRows };
}

function workerRelaunchAdvice(snapshot, architecture) {
  const rows = list(snapshot?.runs);
  const calls = totalCalls(rows);
  if (rows.length < RUN_THRESHOLD || calls < CALL_THRESHOLD) return [];
  const { workerAgents, workerErrors, pressureRows } = relaunchMetrics(snapshot, architecture);
  if (!workerErrors.length || !pressureRows.length) return [];
  const itemSample = sample(rows.length, workerErrors.length, rows.length);
  return [item(
    "worker-relaunch-pressure",
    "warning",
    "Ordered worker relaunch pressure follows observed errors",
    [
      `inferred-worker-agents:${[...workerAgents].sort((left, right) => String(left).localeCompare(String(right))).join(",")}`,
      `worker-error-runs:${workerErrors.length}`,
      `same-parent-runs-after-error:${pressureRows.length}`,
      "proxy:ordered-same-agent-same-parent-run-after-error",
      `parent-attribution:${pressureRows.every(({ parent }) => parent !== null) ? "observed" : "root-parent"}`,
      "cause-and-exhaustion-limit:unestablished",
    ],
    itemSample,
    confidence(Math.min(1, pressureRows.length / workerErrors.length), "ordered-error-proxy", itemSample),
    "Review worker restart boundaries and failure context; telemetry establishes an ordered relaunch proxy, not a cause or exhaustion limit.",
    "Ordered same-parent post-error runs show relaunch pressure, but not its cause or any exhaustion limit.",
  )];
}

function parentShareAdvice(snapshot, architecture, execution) {
  const rows = list(snapshot?.runs);
  const calls = totalCalls(rows);
  if (rows.length < RUN_THRESHOLD || calls < CALL_THRESHOLD) return [];
  const roles = roleRunCounts(snapshot, architecture);
  const coordinators = new Set(roles.filter((role) => Number(role.scores?.orchestrator ?? 0) >= 0.5).map((role) => role.agent));
  const coordinatorRuns = rows.filter((run) => coordinators.has(runAgent(run))).length;
  const coordinatorShare = coordinatorRuns / rows.length;
  const delegation = object(architecture?.delegation) ?? {};
  const parentShare = Number(delegation.parentCount) > 0 ? Number(delegation.parentCount) / rows.length : 0;
  if (Math.max(coordinatorShare, parentShare) < 0.6) return [];
  const itemSample = sample(rows.length, coordinatorRuns, rows.length);
  return [item(
    "parent-orchestrator-share",
    "warning",
    "Parent/orchestrator run share is high",
    [`orchestrator-runs:${coordinatorRuns}`, `orchestrator-share:${coordinatorShare}`, `parent-runs:${delegation.parentCount ?? 0}`, `parent-share:${parentShare}`, `delegations:${delegation.delegations ?? 0}`],
    itemSample,
    confidence(Math.min(1, Math.max(coordinatorShare, parentShare)), "sampled", itemSample),
    "Review coordinator boundaries so parent work and delegated work remain proportionate to the observed workload.",
    "A large parent/coordinator share leaves less work delegated, so review boundaries before adding more parent work.",
  )];
}

function reviewerEvidenceAdvice(snapshot) {
  const rows = list(snapshot?.runs);
  if (rows.length < RUN_THRESHOLD) return [];
  const attributable = rows.filter(attributableReviewer).length;
  if (attributable > 0) return [];
  const records = rows.filter((run) => run?.reviewer).length;
  const itemSample = sample(rows.length, 0, rows.length);
  return [item(
    "reviewer-evidence-missing",
    "warning",
    "Reviewer evidence is missing",
    [`runs:${rows.length}`, `attributable-review-runs:${attributable}`, `reviewer-records:${records}`, "reviewer-verdicts:PASS-or-ISSUE-required"],
    itemSample,
    confidence(null, "insufficient-reviewer-evidence", itemSample, "unknown"),
    "Capture attributable PASS or ISSUE reviewer outcomes before using reviewer quality comparisons.",
    "Zero attributable PASS or ISSUE outcomes make reviewer quality unobservable rather than good or bad.",
  )];
}

function accessVisibilityAdvice(channels, rows) {
  const observed = channels.filter((channel) => ["web", "memory"].includes(channel.key) || channel.tools.some((tool) => tool.provider === "mcp"));
  const calls = observed.reduce((sum, channel) => sum + channel.calls, 0);
  if (!observed.length || rows.length < RUN_THRESHOLD || calls < CALL_THRESHOLD) return [];
  const itemSample = sample(rows.length, observed.length, rows.length);
  return [item(
    "access-channel-visibility",
    "info",
    "Observed web, memory, or MCP access is visible",
    [`channels:${observed.map((channel) => channel.key).sort((left, right) => left.localeCompare(right)).join(",")}`, `calls:${calls}`, `tools:${observed.reduce((sum, channel) => sum + channel.tools.length, 0)}`, "provider-evidence:explicit-names-only"],
    itemSample,
    confidence(Math.min(1, calls / CALL_THRESHOLD), "sampled", itemSample),
    "Use the observed access-channel inventory to review external, memory, and MCP boundaries without inferring hidden providers.",
    "Named web, memory, or MCP channels expose explicit boundaries, but do not reveal unlisted providers.",
  )];
}

function principle(key, label, score, conclusion, evidence, itemSample, itemConfidence) {
  return { key, label, score: score === null ? null : Math.min(100, Math.max(0, Math.round(score))), conclusion, evidence: [...evidence], sample: itemSample, confidence: itemConfidence };
}

function finiteValue(value) {
  const result = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(result) ? result : null;
}

function decisionSupport(snapshot, architecture, throughput, efficiency, conclusions, channels) {
  const rows = list(snapshot?.runs);
  const calls = totalCalls(rows);
  const itemSample = sample(rows.length, rows.length, rows.length);
  const enoughRuns = rows.length >= RUN_THRESHOLD;
  const enoughCalls = calls >= CALL_THRESHOLD;
  const roleRows = list(architecture?.roles);
  const indexedCalls = channels.filter((channel) => channel.key === "code-graph" || channel.key === "indexed-code").reduce((sum, channel) => sum + channel.calls, 0);
  const delegationCalls = channels.find((channel) => channel.key === "delegation")?.calls ?? 0;
  const tokenSource = object(efficiency?.tokens);
  const tokenKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
  const tokenValues = Object.fromEntries(tokenKeys.map((key) => [key, finiteValue(tokenSource?.[key]) ?? 0]));
  const tokenTotal = tokenKeys.reduce((sum, key) => sum + tokenValues[key], 0);
  const tokenMeasured = finiteValue(efficiency?.measuredSamples?.tokens) ?? 0;
  const tokenEvidence = tokenMeasured > 0 && tokenTotal > 0;
  const tokenSample = sample(rows.length, Math.min(rows.length, tokenMeasured), rows.length);
  const throughputTotals = object(throughput?.totals);
  const throughputBasis = object(throughput?.basis);
  const throughputCostAvailability = object(throughput?.costAvailability);
  const throughputCost = throughputCostAvailability?.available === true ? finiteValue(throughputTotals?.estimatedUsd) : null;
  const costRows = rows.filter((run) => {
    const cost = object(run?.cost);
    return cost && finiteValue(cost.usd) !== null && cost.basis !== "unavailable";
  });
  const costBasisCounts = new Map();
  for (const run of costRows) {
    const basis = String(object(run?.cost)?.basis ?? "unknown");
    costBasisCounts.set(basis, (costBasisCounts.get(basis) ?? 0) + 1);
  }
  const runCostTotal = costRows.length ? costRows.reduce((sum, run) => sum + (finiteValue(run.cost.usd) ?? 0), 0) : null;
  const positiveRunCost = runCostTotal !== null && runCostTotal > 0 ? runCostTotal : null;
  const positiveThroughputCost = throughputCost !== null && throughputCost > 0 ? throughputCost : null;
  const reportedCost = positiveRunCost ?? positiveThroughputCost ?? runCostTotal ?? throughputCost;
  const costEvidenceCount = costRows.length || (throughputCost !== null ? rows.length : 0);
  const costBasis = positiveRunCost !== null
    ? costBasisCounts.size === 1 ? [...costBasisCounts.keys()][0] : costBasisCounts.size > 1 ? "mixed" : "reported"
    : positiveThroughputCost !== null ? String(throughputCostAvailability?.basis ?? "observed") : "unavailable";
  const activeWallMs = finiteValue(throughputBasis?.activeWallMs);
  const summedWorkMs = finiteValue(throughputBasis?.summedWorkMs) ?? finiteValue(efficiency?.timing?.durationMs);
  const parallelism = finiteValue(throughputBasis?.parallelism) ?? (activeWallMs > 0 && summedWorkMs !== null ? summedWorkMs / activeWallMs : null);
  const criticalPathMs = finiteValue(architecture?.delegation?.approximateCriticalPathMs);
  const errors = rows.reduce((sum, run) => sum + runErrors(run), 0);
  const relaunch = relaunchMetrics(snapshot, architecture);
  const relaunchCount = relaunch.pressureRows.length;
  const errorDrag = Math.min(1, (errors + relaunchCount) / Math.max(1, rows.length * 2));
  const reviewerCount = rows.filter(attributableReviewer).length;
  const delegation = object(architecture?.delegation);
  const delegationTarget = finiteValue(delegation?.delegations) ?? 0;
  const parentCount = finiteValue(delegation?.parentCount) ?? 0;
  const establishedCoordinator = roleRows.find((role) => role?.primaryRole === "orchestrator") ?? null;
  const dominantCoordinator = establishedCoordinator;
  const coordinatorRuns = dominantCoordinator ? rows.filter((run) => runAgent(run) === dominantCoordinator.agent) : [];
  const coordinatorReadShare = dominantCoordinator
    ? readSearchCalls(coordinatorRuns) / Math.max(1, totalCalls(coordinatorRuns))
    : 0;
  const navigationCoverage = rows.length > 0 ? Math.min(1, indexedCalls / (rows.length * 2)) : 0;
  const delegationCoverage = delegationTarget > 0 ? Math.min(1, delegationCalls / delegationTarget) : 0;
  const reviewerCoverage = parentCount > 0 ? Math.min(1, reviewerCount / parentCount) : 0;
  const coordinatorCoverage = establishedCoordinator ? 1 : 0;
  const readGuardrail = establishedCoordinator && coordinatorReadShare <= 0.5
    ? 1
    : establishedCoordinator ? Math.max(0, 1 - ((coordinatorReadShare - 0.5) / 0.5)) : 0;
  const intelligenceEvidence = indexedCalls > 0 || delegationCalls > 0 || delegationTarget > 0 || reviewerCount > 0 || establishedCoordinator !== null;
  const intelligenceComponents = [
    { label: "navigation", value: navigationCoverage, weight: 0.3 },
    { label: "delegation", value: delegationCoverage, weight: 0.25 },
    { label: "reviewer", value: reviewerCoverage, weight: 0.15 },
    { label: "coordinator", value: coordinatorCoverage, weight: 0.2 },
    { label: "read guardrail", value: readGuardrail, weight: 0.1 },
  ];
  const intelligenceScore = enoughRuns && enoughCalls && intelligenceEvidence
    ? 100 * intelligenceComponents.reduce((sum, component) => sum + component.value * component.weight, 0)
    : null;
  const productiveShare = tokenTotal > 0 ? (tokenValues.output + tokenValues.reasoning) / tokenTotal : null;
  const contextTokens = tokenValues.input + tokenValues.cacheRead;
  const cacheReadShare = contextTokens > 0 ? tokenValues.cacheRead / contextTokens : null;
  const cacheWriteShare = tokenTotal > 0 ? tokenValues.cacheWrite / tokenTotal : null;
  const usdPerKToken = reportedCost !== null && tokenTotal > 0 ? reportedCost / tokenTotal * 1_000 : null;
  const costRateScore = usdPerKToken === null ? null : 100 / (1 + Math.max(0, usdPerKToken));
  const bucketComponents = [
    productiveShare === null ? null : [productiveShare, 0.65],
    cacheReadShare === null ? null : [cacheReadShare, 0.25],
    cacheWriteShare === null ? null : [1 - cacheWriteShare, 0.1],
  ].filter(Boolean);
  const bucketWeight = bucketComponents.reduce((sum, [, weight]) => sum + weight, 0);
  const bucketUseScore = bucketWeight > 0
    ? 100 * bucketComponents.reduce((sum, [value, weight]) => sum + value * weight, 0) / bucketWeight
    : null;
  const costScore = enoughRuns && enoughCalls && tokenEvidence && costEvidenceCount > 0 && reportedCost !== null && costRateScore !== null && bucketUseScore !== null
    ? costRateScore * 0.45 + bucketUseScore * 0.3 + (1 - errorDrag) * 100 * 0.25
    : null;
  const activeShare = activeWallMs !== null && summedWorkMs !== null && summedWorkMs > 0 ? Math.min(1, activeWallMs / summedWorkMs) : null;
  const parallelismScore = parallelism !== null && parallelism > 0 ? Math.min(1, parallelism / 4) : null;
  const criticalPathScore = activeWallMs !== null && criticalPathMs !== null && criticalPathMs > 0 ? Math.min(1, activeWallMs / criticalPathMs) : null;
  const tokenRate = tokenEvidence && activeWallMs !== null && activeWallMs > 0 ? tokenTotal / activeWallMs * 60_000 : null;
  const tokenRateScore = tokenRate === null ? null : tokenRate / (tokenRate + 1_000);
  const speedScore = enoughRuns && enoughCalls && tokenEvidence && activeShare !== null && parallelismScore !== null &&
    criticalPathScore !== null && tokenRateScore !== null
    ? 100 * (tokenRateScore * 0.25 + activeShare * 0.2 + parallelismScore * 0.25 + criticalPathScore * 0.15 + (1 - errorDrag) * 0.15)
    : null;
  const intelligenceMissing = [];
  if (navigationCoverage < 1) intelligenceMissing.push("navigation target 2/run");
  if (delegationTarget <= 0 || delegationCoverage < 1) intelligenceMissing.push("delegation target");
  if (parentCount <= 0 || reviewerCoverage < 1) intelligenceMissing.push("PASS/ISSUE outcomes per parent");
  if (!establishedCoordinator) intelligenceMissing.push("established coordinator");
  if (readGuardrail < 1) intelligenceMissing.push("coordinator reads <=50%");
  const costMissing = [];
  if (!enoughRuns) costMissing.push(`at least ${RUN_THRESHOLD} runs`);
  if (!enoughCalls) costMissing.push(`at least ${CALL_THRESHOLD} calls`);
  if (!tokenEvidence) costMissing.push("measured token buckets");
  if (!costEvidenceCount || reportedCost === null) costMissing.push("reported or catalog-estimated run cost");
  if (bucketUseScore === null) costMissing.push("token bucket allocation");
  const speedMissing = [];
  if (!enoughRuns) speedMissing.push(`at least ${RUN_THRESHOLD} runs`);
  if (!enoughCalls) speedMissing.push(`at least ${CALL_THRESHOLD} calls`);
  if (!tokenEvidence) speedMissing.push("measured token buckets");
  if (activeShare === null) speedMissing.push("active and summed work time");
  if (parallelismScore === null) speedMissing.push("parallelism");
  if (criticalPathScore === null) speedMissing.push("approximate critical-path timing");
  if (tokenRateScore === null) speedMissing.push("positive active time for token rate");
  const basis = "Observed workflow allocation/efficiency heuristic; not provider or model intelligence.";
  const principles = [
    principle("intelligence", "Intelligence allocation", intelligenceScore,
      intelligenceScore === null ? "Unavailable — insufficient observed workflow allocation evidence." : "Uses fixed target coverage for navigation, delegation, strict reviewer outcomes, coordinator evidence, and a 50% coordinator-read guardrail; missing dimensions remain zero.",
      [basis, `runs:${rows.length}`, `calls:${calls}`, `indexed-navigation-calls:${indexedCalls}`, `delegation-calls:${delegationCalls}`, `reviewer-outcomes:${reviewerCount}`, `coordinator-read-share:${coordinatorReadShare}`], itemSample,
      confidence(intelligenceScore === null ? null : Math.min(1, Math.max(rows.length / RUN_THRESHOLD, calls / CALL_THRESHOLD)), intelligenceScore === null ? "insufficient-sample" : "workflow-allocation", itemSample, intelligenceScore === null ? "unknown" : "derived")),
    principle("cost", "Cost efficiency", costScore,
      costScore === null ? "Unavailable — measured token buckets, cost, and sufficient workflow evidence are required." : "Scores token-bucket allocation and reported or catalog-estimated USD per thousand tokens, then applies observed error and relaunch-proxy drag.",
      [basis, `runs:${rows.length}`, `calls:${calls}`, `token-input:${tokenValues.input}`, `token-output:${tokenValues.output}`, `token-reasoning:${tokenValues.reasoning}`, `token-cache-read:${tokenValues.cacheRead}`, `token-cache-write:${tokenValues.cacheWrite}`, `run-cost-usd:${reportedCost ?? "unavailable"}`, `cost-basis:${costBasis}`, `usd-per-thousand-tokens:${usdPerKToken ?? "unavailable"}`, `error-count:${errors}`, `relaunch-proxy-count:${relaunchCount}`], tokenSample,
      confidence(costScore === null ? null : Math.min(1, Math.max(tokenMeasured / Math.max(1, rows.length), costEvidenceCount / Math.max(1, rows.length))), costScore === null ? "insufficient-cost-evidence" : "workflow-cost-allocation", tokenSample, costScore === null ? "unknown" : "derived")),
    principle("speed", "Speed efficiency", speedScore,
      speedScore === null ? "Unavailable — token buckets, active/summed time, parallelism, and critical-path evidence are required." : "Scores token throughput over active time with summed-work overlap, parallelism, critical-path, and observed error/relaunch drag.",
      [basis, `runs:${rows.length}`, `calls:${calls}`, `token-total:${tokenTotal}`, `token-output:${tokenValues.output}`, `token-reasoning:${tokenValues.reasoning}`, `token-cache-read:${tokenValues.cacheRead}`, `active-wall-ms:${activeWallMs ?? "unavailable"}`, `summed-work-ms:${summedWorkMs ?? "unavailable"}`, `parallelism:${parallelism ?? "unavailable"}`, `critical-path-ms:${criticalPathMs ?? "unavailable"}`, `error-count:${errors}`, `relaunch-proxy-count:${relaunchCount}`], tokenSample,
      confidence(speedScore === null ? null : Math.min(1, Math.max(tokenMeasured / Math.max(1, rows.length), activeWallMs ? 1 : 0)), speedScore === null ? "insufficient-duration-evidence" : "workflow-speed-allocation", tokenSample, speedScore === null ? "unknown" : "derived")),
  ];
  principles[0].reasoning = contributionReasoning(intelligenceComponents.map((component) => ({
    label: component.label,
    value: component.value * component.weight,
  })), intelligenceMissing);
  principles[1].reasoning = contributionReasoning([
    { label: "cost rate", value: costRateScore === null ? null : costRateScore / 100 },
    { label: "token bucket use", value: bucketUseScore === null ? null : bucketUseScore / 100 },
    { label: "error and relaunch resilience", value: 1 - errorDrag },
  ], costMissing);
  principles[2].reasoning = contributionReasoning([
    { label: "token rate", value: tokenRateScore },
    { label: "active-time share", value: activeShare },
    { label: "parallelism", value: parallelismScore },
    { label: "critical path", value: criticalPathScore },
    { label: "error and relaunch resilience", value: 1 - errorDrag },
  ], speedMissing);
  const available = rows.length > 0 || channels.length > 0;
  return {
    availability: makeAvailability(available, { basis: available ? "derived" : "unavailable", reason: available ? "workflow-decision-support" : "no-observed-workflow", sample: itemSample }),
    sample: itemSample,
    confidence: confidence(available ? Math.min(1, Math.max(rows.length / RUN_THRESHOLD, calls / CALL_THRESHOLD)) : null, available ? "workflow-decision-support" : "no-observed-workflow", itemSample, available ? "derived" : "unknown"),
    principles,
    conclusions: conclusions.map((entry) => ({ ...entry, evidence: [...entry.evidence] })),
    accessChannels: channels,
  };
}

function capabilityAdvice(snapshot) {
  const unavailable = list(snapshot?.provenance?.capabilities).filter((capability) => capability?.available === false);
  if (!unavailable.length) return [];
  const evidence = unavailable.map((capability) => `capability:${String(capability.name ?? "unknown")}`).sort((left, right) => left.localeCompare(right));
  const itemSample = sample(unavailable.length, unavailable.length, unavailable.length);
  return [item(
    "capability-unavailable",
    "error",
    "Required telemetry capabilities are unavailable",
    evidence,
    itemSample,
    confidence(1, "capability-failure", itemSample, "unavailable"),
    "Enable or restore the missing telemetry capability before relying on derived advice.",
    "Missing telemetry capability leaves its derived dimension unavailable, so dependent advice may be incomplete.",
  )];
}

function errorAdvice(execution) {
  const rows = list(execution?.runs);
  const withErrors = rows.filter((run) => Number(run?.errors) > 0);
  const totalErrors = withErrors.reduce((sum, run) => sum + Math.max(0, Number(run.errors) || 0), 0);
  if (!totalErrors) return [];
  const itemSample = sample(rows.length, withErrors.length, rows.length);
  return [item(
    "execution-errors",
    "error",
    "Execution errors were observed",
    [`runs-with-errors:${withErrors.length}`, `error-count:${totalErrors}`],
    itemSample,
    confidence(1, "hard-error", itemSample, "observed"),
    "Inspect the failing run class and error kind before comparing throughput or role signals.",
    "Observed errors can confound throughput and role comparisons, so inspect the failing run class and kind first.",
  )];
}

function delegationAdvice(architecture, execution) {
  const delegation = object(architecture?.delegation) ?? {};
  const rows = list(execution?.runs);
  const advice = [];
  const runSample = sample(rows.length, rows.length, rows.length);
  if (rows.length >= RUN_THRESHOLD && (Number(delegation.maxFanOut) >= 8 || Number(delegation.fanOut) >= 4)) {
    advice.push(item(
      "delegation-fanout",
      "warning",
      "Delegation fan-out is high",
      [`average-fan-out:${delegation.fanOut}`, `max-fan-out:${delegation.maxFanOut}`, `delegations:${delegation.delegations}`],
      runSample,
      confidence(Math.min(1, Math.max(Number(delegation.fanOut) / 4, Number(delegation.maxFanOut) / 8)), "sampled", runSample),
      "Review coordinator boundaries and batch small child tasks where practical.",
      "Observed fan-out exceeds guidance, so batching child tasks can reduce coordination overhead.",
    ));
  }
  if (rows.length >= RUN_THRESHOLD && Number(delegation.maxDepth) >= 4) {
    advice.push(item(
      "delegation-depth",
      "warning",
      "Delegation depth is high",
      [`max-depth:${delegation.maxDepth}`, `critical-path-ms:${delegation.approximateCriticalPathMs}`],
      runSample,
      confidence(Math.min(1, Number(delegation.maxDepth) / 6), "sampled", runSample),
      "Flatten unnecessary parent-child hops to reduce coordination latency.",
      "Observed depth adds parent-child coordination hops, so flattening unnecessary layers can reduce latency.",
    ));
  }
  return advice;
}

function toolAdvice(architecture) {
  const tools = list(architecture?.toolRouting);
  const advice = [];
  for (const tool of tools) {
    const denominator = Number(tool?.denominator) || 0;
    if (denominator < CALL_THRESHOLD) continue;
    const routes = list(tool?.routes);
    const dominant = routes.slice().sort((left, right) => Number(right.share ?? -1) - Number(left.share ?? -1) ||
      String(left.agent).localeCompare(String(right.agent)))[0];
    if (dominant && Number(dominant.share) >= 0.8 && routes.length > 1) {
      const itemSample = sample(denominator, denominator, denominator);
      advice.push(item(
        "tool-routing-concentration",
        "info",
        `Tool routing is concentrated for ${tool.tool}`,
        [`tool-calls:${denominator}`, `dominant-agent:${dominant.agent}`, `dominant-share:${dominant.share}`],
        itemSample,
        confidence(Number(dominant.share), "sampled", itemSample),
        "Confirm the dominant route is intentional and document the ownership boundary.",
        "Most calls for this tool route through one agent, so confirm that ownership boundary is intentional.",
      ));
    }
    if (tool.classification === "unknown") {
      const itemSample = sample(denominator, denominator, denominator);
      advice.push(item(
        "tool-classification-unknown",
        "info",
        `Tool classification is unknown for ${tool.tool}`,
        [`tool-calls:${denominator}`],
        itemSample,
        confidence(null, "insufficient-evidence", itemSample, "unknown"),
        "Provide an explicit builtin, MCP, or plugin classification rather than inferring from usage.",
        "Provider metadata is insufficient, so usage alone cannot distinguish builtin, MCP, or plugin classification.",
      ));
    }
  }
  return advice;
}

function reviewerAdvice(execution, snapshot = {}) {
  const sourceRows = list(snapshot?.runs);
  const rows = sourceRows.length ? sourceRows : list(execution?.runs);
  const verdictOf = (run) => run?.reviewer?.verdict ?? run?.reviewerVerdict;
  const reviewed = rows.filter((run) => verdictOf(run) === "PASS" || verdictOf(run) === "ISSUE");
  const issues = reviewed.filter((run) => verdictOf(run) === "ISSUE");
  if (issues.length === 0 || reviewed.length < RUN_THRESHOLD) return [];
  const itemSample = sample(reviewed.length, issues.length, reviewed.length);
  return [item(
    "review-issues",
    "warning",
    "Reviewer issues are recurring",
    [`reviewed-runs:${reviewed.length}`, `issue-runs:${issues.length}`, `issue-share:${issues.length / reviewed.length}`],
    itemSample,
    confidence(issues.length / reviewed.length, "sampled", itemSample),
    "Group reviewer issues by stable evidence and address the most frequent failure mode first.",
    "Recurring ISSUE outcomes mark a repeated reviewed failure pattern, so address the most frequent evidence-backed mode first.",
  )];
}

function sortAdvice(items) {
  return items.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    left.code.localeCompare(right.code) || left.title.localeCompare(right.title));
}

/** Build local, deterministic recommendations from analyzer results. */
export function buildAdvice(snapshot = {}, analysis = {}) {
  const architecture = object(analysis?.architecture) ?? (object(analysis)?.nodes ? analysis : analyzeArchitecture(snapshot));
  const execution = object(analysis?.execution) ?? (object(analysis)?.runs ? analysis : analyzeExecution(snapshot));
  const throughput = object(analysis?.throughput) ?? analyzeThroughput(snapshot);
  const efficiency = object(analysis?.efficiency) ?? analyzeEfficiency(snapshot);
  const allRuns = list(execution?.runs);
  const channels = accessChannels(snapshot);
  const allItems = sortAdvice([
    ...capabilityAdvice(snapshot),
    ...errorAdvice(execution),
    ...delegationAdvice(architecture, execution),
    ...toolAdvice(architecture),
    ...reviewerAdvice(execution, snapshot),
    ...coordinatorReadAdvice(snapshot, architecture),
    ...workerRelaunchAdvice(snapshot, architecture),
    ...parentShareAdvice(snapshot, architecture, execution),
    ...reviewerEvidenceAdvice(snapshot),
    ...accessVisibilityAdvice(channels, list(snapshot?.runs)),
  ]);
  const topSample = sample(allRuns.length, allRuns.length, allRuns.length);
  const available = architecture?.availability?.available !== false || execution?.availability?.available !== false;
  const support = decisionSupport(snapshot, architecture, throughput, efficiency, allItems, channels);
  return deepFreeze({
    availability: makeAvailability(available && (allRuns.length > 0 || list(snapshot?.provenance?.capabilities).length > 0), {
      basis: allItems.length ? "derived" : available ? "observed" : "unavailable",
      reason: allItems.length ? "actionable-findings" : allRuns.length ? "no-actionable-findings" : "no-runs",
      sample: topSample,
    }),
    sample: topSample,
    confidence: confidence(allItems.length ? 0.8 : allRuns.length ? 0.6 : null, allItems.length ? "deterministic-rules" : "no-findings", topSample),
    provenance: {
      source: "normalized-snapshot",
      method: "deterministic-local-rules",
      sample: topSample,
    },
    items: allItems,
    decisionSupport: support,
    summary: allItems.length ? `${allItems.length} deterministic advice item${allItems.length === 1 ? "" : "s"}.` : "No actionable advice for the observed sample.",
  });
}
