# Telemetry Investigation Suite

## Status

- Waves 1–5 are complete and accepted: analytics foundations, secure frontend shell, pure analyzers, backend/API integration, investigation views, and dashboard integration are implemented.
- The dashboard preserves the legacy sortable overview while wiring shared navigation, privacy filters, current/equal-length-prior requests, view lifecycles, environment opt-in, redacted baselines, and client-side exports.
- Current verification baseline: the 3 targeted Wave 5 integration tests pass; `npm test` passes 100 tests with one Windows-only symlink test skipped; `git diff --check` and Graphify refresh pass. Desktop and 375px browser smoke cover loading, prior-period data, navigation, architecture metric toggles, sorting, environment controls, responsive layout, and clean console/network/CSP behavior. AFT diagnostics remain unavailable because the local TypeScript language server crashes during initialization.
- NEXT WAVE: none — the telemetry investigation suite is complete.

## Objective

Turn the local dashboard into a privacy-safe investigation console for:

- inferred agent/subagent architecture and observed third-party tool topology;
- execution trees, delegation patterns, bottlenecks, and evidence-backed advice;
- workflow token throughput, context/cache efficiency, cost, and concurrency;
- agent/model comparisons, reviewer outcomes, failures, and regressions;
- observed and explicitly opted-in configured environment inventory;
- privacy-safe snapshots and exports.

The architecture view must answer questions such as: “`sol-build` behaves as the orchestrator, `luna-worker` behaves as the implementor, and 70% of tool X calls route through Luna versus 30% through Sol,” while showing the sample and inference confidence.

## Non-goals

- No raw prompts, message text, tool arguments/results, commands, paths, IDs, secrets, URLs, headers, or environment-variable values.
- No remote telemetry, hosted service, LLM-generated analysis, or automatic configuration changes.
- No claim that API-equivalent cost equals an invoice.
- No claim that workflow tokens/minute is provider decode speed.
- No inferred “retry” unless the recorded sequence supports the narrower label `repeat-after-error`.
- No opaque all-in-one efficiency score; expose interpretable components and samples.

## Current model

- Node ESM application with no frontend framework or build step.
- `metrics.mjs` reads SQLite in read-only mode and only uses `session`, `message`, and `part`.
- Sessions already expose internal parent relationships; public session aliases are hashed.
- Existing response: `schema`, `range`, `sessionOptions`, `scope`, `summary`, `groups`, `pricing`, `toolUsage`, `reviewerSummary`, and `privacy`.
- Existing `toolUsage.byAgent` conserves recorded token buckets and attributes calls/errors by agent.
- `server.mjs` serves one inline `index.html` and `/api/metrics`; requests are loopback-only.
- Titles remain opt-in. Child titles are never returned.

## Acceptance criteria

1. **Architecture view**
   - Render an accessible layered topology: inferred orchestrators, workers/reviewers/specialists, then observed tools.
   - Show parent→child delegation edges and agent→tool edges, selectable by calls, tokens, estimated cost, or duration.
   - Show role scores, confidence, evidence, sample sizes, tool-routing shares, and a short deterministic topology description.
   - Distinguish observed built-ins, MCP tools, plugins, and unknown tools; never present an unconfirmed third-party classification as fact.
   - Show deterministic bottleneck/advice cards that cite the measured evidence and suppress low-sample advice.

2. **Execution tree and delegation health**
   - Display privacy-safe root/subagent runs with agent, model, time, duration, tokens, cost, calls, errors, and reviewer result where attributable.
   - Report fan-out, maximum depth, parent/child token ratio, active parallelism, approximate critical path, and repeat-after-error events.
   - Default order and current range/session filtering remain consistent with the rest of the dashboard.

3. **Throughput and context efficiency**
   - Report processed tokens/minute, generated tokens/minute, output tokens/minute, tool calls/minute, and estimated USD/hour.
   - Report active wall time, summed work time, and parallelism so rates have an auditable denominator.
   - Provide per-agent rates and a time series.
   - Report cache-read share, estimated cache savings, reasoning/output mix, long-context crossings, and tokens/cost per reviewer PASS only when attributable.
   - Unavailable or zero-duration rates are `null` with a reason, never fabricated as zero.
   - UI labels these as workflow throughput. Provider generation tokens/second remains unavailable unless exact step timing is present and sufficiently covered.

4. **Comparison, failures, and trends**
   - Compare agents/models on runs, samples, tokens, cost, duration, calls, error rate, cache share, and reviewer outcomes.
   - Surface tool/agent/model error hotspots and repeat-after-error sequences without exposing payloads.
   - Render range trends and compare with the immediately preceding equal-length period.
   - Flag regressions only with explicit thresholds, minimum samples, and evidence.

5. **Environment**
   - Always show an observed inventory derived from selected telemetry: agents, models, tools, schema capabilities, and reporting coverage.
   - Configured inventory is disabled by default and requires server startup opt-in plus a request opt-in.
   - Configured inventory returns only redacted names/types/versions/capabilities. It never returns source paths, commands, URLs, headers, environment values, or config values.
   - Support saving a redacted local baseline and showing a current-vs-baseline diff.

6. **Export and quality**
   - Export the currently loaded aggregate payload as versioned JSON and principal tables as CSV, entirely client-side.
   - Preserve sortable tables, filters, title privacy, number/cost semantics, read-only DB access, loopback controls, and cache behavior.
   - Work at desktop and mobile widths, with keyboard navigation and non-visual summaries for charts/topologies.
   - Full unit/server suite and browser smoke acceptance pass.

## Architecture

### Data pipeline

```text
read-only SQLite rows
  -> existing normalization/range/scope logic
  -> internal TelemetrySnapshot (raw IDs allowed only in-process)
  -> pure analytics modules
  -> public sanitizer/versioned analytics response
  -> vanilla ESM dashboard views
```

- Keep database/schema handling in `metrics.mjs`.
- Put pure derivation in `analytics/*.mjs`; analyzers cannot read files, databases, globals, or the network.
- Raw IDs may be used for internal joins but public execution nodes use the existing deterministic session aliases.
- The configured-environment collector is a separate server-side module and is never invoked without startup opt-in.
- Split the inline UI into browser-native ESM/CSS modules. No framework, bundler, chart dependency, or external asset.
- Use deterministic SVG/layered layouts with semantic table/list equivalents; avoid force-layout instability.

### Public API compatibility

- Existing fields and meanings remain additive and unchanged.
- Add top-level `analytics` with `schemaVersion: 1`.
- All rates are numbers or `null`; fractions are in `[0, 1]`; durations are milliseconds; timestamps are epoch milliseconds.
- Arrays have deterministic tie-break ordering.
- Every derived/inferred section includes availability, sample size, and confidence/provenance.

```js
analytics: {
  schemaVersion: 1,
  availability: {
    architecture: { available, basis, reason },
    throughput: { available, basis, reason },
    reviewerAttribution: { available, basis, reason },
    configuredEnvironment: { available, basis, reason }
  },
  throughput,
  architecture,
  execution,
  efficiency,
  comparisons,
  failures,
  trends,
  environment,
  advice
}
```

### Throughput contract

- `processedTokens` uses the existing conserved `tokens.total` semantics.
- `generatedTokens = output + reasoning`; `outputTokens = output`.
- `activeWallMs` is the union of positive included-session intervals, clamped to the selected range. Parallel children do not double-count wall time.
- `summedWorkMs` is the sum of those intervals; `parallelism = summedWorkMs / activeWallMs`.
- Per-agent active time is the union of that agent’s session intervals.
- Rates require a positive denominator; otherwise return `null` and an availability reason.
- Current time-series bucket widths: up to 24h → 15m; up to 7d → 1h; up to 45d → 1d; longer → 7d.

```js
throughput: {
  basis: { activeWallMs, summedWorkMs, parallelism, intervalMethod },
  totals: {
    processedTokensPerMinute,
    generatedTokensPerMinute,
    outputTokensPerMinute,
    toolCallsPerMinute,
    estimatedUsdPerHour
  },
  byAgent: [{ agent, runs, activeMs, tokens, rates, sample }],
  series: [{ startMs, endMs, activeMs, tokens, calls, estimatedUsd }]
}
```

Provider decode speed is a separate future capability. It may be shown only from exact model-step start/end timing with reported coverage; session/message elapsed time must not be relabeled as provider tokens/second.

### Architecture contract

- Node types: `agent`, `model`, `tool`, and privacy-safe `run`.
- Edge types: `delegates-to`, `uses-model`, and `calls-tool`.
- Agent role inference returns scores for `orchestrator`, `implementor`, `reviewer`, and `specialist`, plus one primary role only when confidence clears the threshold.
- Orchestrator evidence: root share, child fan-out, delegation count, and coordination/tool mix.
- Implementor evidence: child-run share and modifying/execution tool mix.
- Reviewer evidence: reviewer-slot/verdict attribution.
- Specialist evidence: concentrated read/search/domain-tool mix without strong orchestration/review evidence.
- Tool routing share is `agent calls for tool / all calls for tool`; always return numerator and denominator.
- Tool classification values: `builtin`, `mcp`, `plugin`, `unknown`, with confidence and evidence. `unknown` is preferred over guessing.
- Advice is local and deterministic. Each item has `code`, `severity`, `title`, `evidence[]`, `sample`, `confidence`, and `suggestion`.
- Initial advice requires at least 10 relevant runs or 20 relevant calls unless the condition is a hard error/capability failure.

### Execution/privacy contract

```js
execution: {
  runs: [{
    alias, parentAlias, agent, model, startMs, endMs, durationMs,
    depth, tokens, estimatedUsd, toolCalls, errors, reviewerVerdict
  }],
  summary: { roots, children, maxDepth, fanOut, approximateCriticalPathMs }
}
```

- No raw session/message/part IDs leave the server.
- No titles unless the existing title opt-in is active; child titles remain prohibited.
- `approximateCriticalPathMs` must be labeled approximate because recorded intervals include model, tool, and idle time.

### Environment opt-in

- Add CLI/server flag `--inspect-environment`; default `false`.
- Add request parameter `includeEnvironment=1`; it is effective only when the server flag is enabled.
- Observed inventory never requires the flag.
- Configured inventory collector has an explicit field allowlist and recursive secret-key rejection.
- Response contains names/types/versions/capability booleans and provenance only; source locations and values are prohibited.

### Frontend route/security contract

- Continue serving `/`, `/health`, and `/api/metrics`.
- Add only same-origin static assets under `/dashboard/`; canonical-path containment and extension allowlists are mandatory.
- Move inline script/style to modules/assets and tighten CSP to same-origin scripts/styles. No remote connections or assets.
- Cross-view state owns selected range, scoped session, title opt-in, environment opt-in, current/previous payload, and saved redacted baseline.
- Previous-period comparison uses a second existing metrics request for the immediately preceding equal-length range; it does not alter the API contract.

## Dependency-ordered packages

### Wave 1 — foundations

**1A Analytics model and timing primitives — MODE: FEATURE**

- Ownership: new `analytics/contract.mjs`, `analytics/snapshot.mjs`, `analytics/time.mjs`, and matching dedicated tests only.
- Produce the frozen internal snapshot shape, public sanitizers, interval union/clamping, bucket selection, stable ordering, availability helpers, and confidence/sample helpers.
- No edits to `metrics.mjs`, server, or frontend.

**1B Frontend module shell and secure static serving — MODE: FEATURE**

- Ownership: `index.html`, `server.mjs`, `server.test.mjs`, and new `dashboard/core/*`, `dashboard/app.mjs`, `dashboard/styles.css` only.
- Extract current inline app/styles without behavior change, preserve sortable-table state/accessibility, add safe same-origin asset serving, and tighten CSP.
- Provide dormant view mount points and frozen view interfaces; do not implement new analytics views.

**Wave 1 integration**

- One MODE: INTEGRATION worker verifies module loading, API parity, sorting/filter refresh, traversal rejection, CSP, tests, and desktop/mobile browser smoke.

### Wave 2 — pure analyzers (parallel, disjoint ownership)

**2A Architecture and advice engine — MODE: FEATURE**

- Ownership: `analytics/architecture.mjs`, `analytics/advice.mjs`, and their dedicated tests.
- Build roles, topology, tool classification/routing, delegation health, summary text, and sample-gated deterministic advice.

**2B Throughput and trends — MODE: FEATURE**

- Ownership: `analytics/throughput.mjs`, `analytics/trends.mjs`, and their dedicated tests.
- Build denominators, global/per-agent rates, concurrency, buckets, time series, and availability handling.

**2C Efficiency, comparisons, and failure hotspots — MODE: FEATURE**

- Ownership: `analytics/efficiency.mjs`, `analytics/comparisons.mjs`, `analytics/failures.mjs`, and their dedicated tests.
- Build context/cache ratios and savings, reviewer-linked unit economics, agent/model comparison rows, tool errors, and repeat-after-error events.

**2D Redacted environment inventory — MODE: FEATURE**

- Ownership: `environment.mjs` and its dedicated tests.
- Build observed inventory projection and the separately callable, allowlisted configured collector. Test adversarial secret/path/URL/command redaction.

### Wave 3 — backend/API integration

**3A Metrics and server integration — MODE: INTEGRATION**

- Ownership: `metrics.mjs`, `metrics.test.mjs`, `server.mjs`, `server.test.mjs`, plus minimal analyzer fixes if integration exposes contract defects.
- Construct one internal snapshot after range/scope filtering, invoke all pure analyzers, sanitize `analytics`, wire environment opt-ins, extend zero/capability responses, and preserve cache keys/CLI behavior.
- Add fixture tests for parent trees, concurrency, null durations, model/tool attribution, role confidence, advice thresholds, environment gating, privacy, and deterministic output.

### Wave 4 — feature views (parallel, disjoint ownership)

**4A Architecture/execution view — MODE: FEATURE**

- Ownership: `dashboard/views/architecture.mjs`, `dashboard/views/architecture.css`, and pure rendering tests.
- Layered topology, metric toggles, short description, evidence/advice cards, and collapsible semantic execution tree.

**4B Throughput/trends/efficiency view — MODE: FEATURE**

- Ownership: `dashboard/views/throughput.mjs`, `dashboard/views/throughput.css`, and pure rendering tests.
- KPI cards with denominator tooltips, accessible trend SVG/table, concurrency, context/cache breakdown, and current-vs-previous deltas.

**4C Comparison/failure/delegation view — MODE: FEATURE**

- Ownership: `dashboard/views/investigate.mjs`, `dashboard/views/investigate.css`, and pure rendering tests.
- Agent/model matrix, sample-aware reviewer outcomes, hotspots, repeat-after-error rows, and delegation health.

**4D Environment/export view — MODE: FEATURE**

- Ownership: `dashboard/views/environment.mjs`, `dashboard/views/environment.css`, `dashboard/core/export.mjs`, and dedicated tests.
- Observed/configured distinction, opt-in UX, redacted local baseline/diff, versioned JSON, and CSV exports.

### Wave 5 — UI integration and acceptance

**5A Dashboard integration — MODE: INTEGRATION**

- Ownership: `dashboard/app.mjs`, `dashboard/styles.css`, `index.html`, `README.md`, and integration/browser test artifacts.
- Wire navigation and shared filters, current/previous requests, view lifecycles, loading/error/unavailable states, saved baseline, responsive behavior, and cross-view accessibility.
- Preserve legacy metric tables and sortable behavior.
- Verify full tests, `git diff --check`, loopback/CSP/privacy behavior, desktop/mobile browser flows, exports, and representative topology/throughput fixtures.

## Verification gates

- Every package: targeted unit tests and `git diff --check`.
- Every source-editing wave: `npm test`, then `graphify update .` after the final source edit.
- Backend gate: token conservation, deterministic output, exact privacy allowlist, read-only DB behavior, and cache invalidation.
- Environment gate: adversarial fixtures containing secrets, paths, URLs, commands, headers, and env values must prove none leave the collector.
- UI gate: keyboard-only operation, semantic fallbacks, no console/network/CSP errors, 375px and desktop layouts.
- Final acceptance: existing 19 tests plus all new tests pass; browser smoke validates sorting, filtering, architecture metric toggles, throughput denominators, prior-period comparison, environment gating, and export.

## Decisions and assumptions

- “Architecture” is inferred from observed telemetry, not claimed as configured truth.
- Agent names/models/tools may be shown because they are already aggregate dimensions; raw IDs and payloads remain private.
- Workflow throughput is useful now. Provider decode tokens/second is not supportable from session elapsed time and will remain unavailable unless exact step timing is proven.
- Advice is deterministic and local so the dashboard adds no model/token overhead.
- Configured environment inspection is defense-in-depth opt-in and is not needed for the observed topology.
- No new runtime dependency or frontend framework.

## Completed, blockers, and next wave

- Completed: objective, non-goals, contracts, privacy boundary, package ownership, dependency order, and acceptance gates frozen.
- Completed Wave 1A: `analytics/contract.mjs`, `analytics/snapshot.mjs`, and `analytics/time.mjs` now freeze the v1 constants, snapshot/sanitizer boundary, evidence helpers, interval math, per-agent unions, and bucket selection. Dedicated tests cover malformed inputs, determinism, immutability, timing boundaries, and adversarial privacy cases.
- Completed Wave 1B: the inline dashboard is split into `dashboard/app.mjs`, `dashboard/core/*`, and `dashboard/styles.css`; `index.html` is a semantic no-inline shell with dormant view mounts; `server.mjs` serves only canonical allowlisted same-origin assets under `/dashboard/` with a tightened CSP.
- Accepted Wave 1 interfaces: later analyzers must reuse the exported contract/snapshot/time primitives rather than duplicate normalization, timing, evidence, stable-order, aliasing, or sanitization logic. Frontend views use the frozen shared state and `mount`/`update`/`destroy` lifecycle registry.
- Completed Wave 2A: `analytics/architecture.mjs` and `analytics/advice.mjs` provide privacy-safe topology, execution/delegation evidence, role inference, routing, summaries, and sample-gated deterministic advice.
- Completed Wave 2B: `analytics/throughput.mjs` and `analytics/trends.mjs` provide interval-union workflow throughput, work/concurrency accounting, exact buckets, per-agent series, and comparable trend deltas. The accepted totals envelope is `{ tokens, calls, estimatedUsd, rates }`.
- Completed Wave 2C: `analytics/efficiency.mjs`, `analytics/comparisons.mjs`, and `analytics/failures.mjs` provide interpretable cache/context/reviewer economics, stable agent/model comparisons, evidence-bearing hotspots, and strictly recorded repeat-after-error analysis.
- Completed Wave 2D: `environment.mjs` provides separate observed and configured inventory collectors; configured inspection requires explicit enablement and caller-provided descriptors and emits only allowlisted, recursively redacted inventory fields.
- Accepted Wave 2 interfaces: every analyzer emits deterministic deeply frozen output with availability, sample, confidence, and provenance; unavailable evidence remains null/reasoned, raw IDs and payload fields are excluded, and throughput is explicitly workflow wall-clock rather than provider generation speed.
- Verification: all 39 targeted Wave 1/2 analytics and environment tests pass; repository verification reports 62 passed and one Windows-only symlink test skipped; syntax and `git diff --check` pass. The throughput-envelope integration regression was corrected before acceptance.
- Completed Wave 3A: `metrics.mjs` constructs one range/scope-filtered internal snapshot, invokes every Wave 2 analyzer, and emits a sanitized additive `analytics.schemaVersion: 1` payload for populated, zero, and capability-limited responses. `server.mjs` wires the startup/request environment opt-ins without changing existing routes, read-only database handling, cache invalidation, or CLI defaults.
- Accepted Wave 3 interfaces: root analytics availability is the frozen capability map for architecture, throughput, reviewer attribution, and configured environment; configured inventory requires both `--inspect-environment` and `includeEnvironment=1`; response cache identity includes the request opt-in; raw IDs, payloads, and configured secrets/paths/URLs/commands remain outside the public boundary.
- Verification: targeted backend integration tests pass; repository `npm test` reports 65 passed and one Windows-only symlink test skipped; syntax and `git diff --check` pass; Graphify is refreshed. The root availability-envelope mismatch found during acceptance was corrected and regression-tested.
- Completed Wave 4A: `dashboard/views/architecture.mjs` and CSS render deterministic metric-selectable topology, role/routing evidence, advice, bottlenecks, semantic fallbacks, and a collapsible execution tree.
- Completed Wave 4B: `dashboard/views/throughput.mjs` and CSS render auditable workflow-throughput KPIs, denominator evidence, concurrency, accessible trend SVG/table output, efficiency detail, per-agent rates, and previous-period deltas.
- Completed Wave 4C: `dashboard/views/investigate.mjs` and CSS render agent/model comparisons, sample-aware reviewer outcomes, error hotspots, strictly named repeat-after-error events, and delegation health.
- Completed Wave 4D: `dashboard/views/environment.mjs`, CSS, and `dashboard/core/export.mjs` render observed/configured inventory and baseline diffs; JSON preserves the complete redacted public aggregate payload under `exportSchemaVersion: 1`; generic and environment CSV paths are deterministic and spreadsheet-formula safe.
- Accepted Wave 4 interfaces: each view exports a pure renderer and a lifecycle factory with `mount`/`update`/`destroy`, accepting `{ payload, previousPayload, state, actions }`; repeated lifecycle transitions clean up listeners and partial/unavailable payloads retain semantic explanations.
- Verification: all 32 targeted Wave 4 rendering/export contract tests pass; repository `npm test` reports 97 passed and one Windows-only symlink test skipped; syntax and `git diff --check` pass. AFT diagnostics could not run because the local TypeScript language server crashes during initialization.
- Completed Wave 5A: `dashboard/app.mjs`, `dashboard/styles.css`, `index.html`, and `README.md` wire shared navigation/state, dual current/prior requests, lifecycle-safe feature mounts, loading/error/unavailable states, configured-environment opt-in, redacted baselines, exports, responsive behavior, and cross-view accessibility while preserving legacy tables and sorting.
- Verification: all 3 targeted Wave 5 integration tests pass; repository `npm test` reports 100 passed and one Windows-only symlink test skipped; `git diff --check` passes. Desktop and 375px browser smoke validates health/load, prior-period readiness, navigation, metric toggles, sorting, environment actions, responsive layout, and no console/network/CSP errors.
- Blockers: none. Exact provider generation throughput remains intentionally unavailable under the current timing evidence; AFT diagnostics remain unavailable because the local TypeScript language server crashes during initialization.
- NEXT WAVE: none — final acceptance is complete.
