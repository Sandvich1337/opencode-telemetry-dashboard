# OpenCode Telemetry Dashboard Redesign

## Status

- Planning and Waves 1–3 are complete and accepted.
- The current worktree already contains the completed, uncommitted telemetry-investigation suite. Those changes are the functional baseline and must not be reset, rewritten, or committed implicitly.
- NEXT WAVE: none. The redesign epic is complete; any new request starts in a fresh root.

## Objective

Polish the existing local OpenCode telemetry dashboard using the Kiranism `next-shadcn-dashboard-starter` as the visual and interaction reference while remaining native to this repository's zero-dependency Node, semantic HTML, CSS, and ESM architecture.

The finished dashboard must use its real telemetry terminology and data, present a visibly blue-black dark canvas across the entire viewport, retain a polished light theme, and apply one coherent system to Overview, Architecture, Throughput, Investigate, and Environment.

## Non-goals

- No migration to React, Next.js, Tailwind, shadcn/ui, Radix, TanStack, Zod, Zustand, `nuqs`, or another framework.
- No new runtime or frontend dependency unless a later root proves a requirement cannot be met natively. The expected dependency delta is zero.
- No fake search results, notifications, account/profile menu, organisations, billing, authentication, AI integration, mutations, or demo data.
- No change to telemetry calculations, privacy boundaries, database access, CLI defaults, backend routes, or the public metrics response.
- No URL router retrofit. The application's real navigation remains its lifecycle-managed dashboard views.
- No decorative glassmorphism, neon treatment, heavy animation, or marketing-style layout.
- No table framework, pagination, or column chooser where the bounded aggregate datasets do not benefit from them.

## Current model

- Runtime: Node >=24, ESM, zero dependencies; `npm test` runs `node --test`.
- Server: `server.mjs` serves `/`, `/health`, `/api/metrics`, and allowlisted same-origin `/dashboard/` assets under a restrictive CSP.
- Frontend shell: semantic `index.html`, shared `dashboard/styles.css`, and `dashboard/app.mjs`.
- Existing shell behavior: collapsible desktop sidebar, mobile drawer, view navigation, breadcrumb, local-data status, persistent `system`/`light`/`dark` theme, and persistent sidebar collapse.
- Existing pages/views: Overview plus lifecycle modules for Architecture, Throughput, Investigate, and Environment.
- Existing data flow: shared state requests current metrics and an immediately preceding equal-length comparison period, then updates mounted views through `{ payload, previousPayload, state, actions }`.
- Existing controls: time range, root-session scope, title opt-in, refresh/auto-refresh, environment opt-in, saved redacted baseline, exports, sortable aggregate tables, and view-specific controls.
- Existing state is uncommitted but accepted by `.opencode/workplans/telemetry-investigation-suite.md`; preserve it as the baseline.

## Acceptance criteria

### Visual system

- Dark mode is unmistakably navy/blue-black rather than black, zinc, charcoal, or grey at the root canvas, sidebar, header, gutters, content background, cards, popovers/dialogs, borders, hover states, and overlays.
- Dark layers remain distinct: outer canvas approximately `#050b16`–`#07111f`, sidebar `#07101d`–`#091423`, primary surfaces `#0b1626`–`#0e1a2b`, raised surfaces near `#101d2f`, and restrained medium-blue interaction accents.
- A very subtle blue radial wash may appear behind main content at 3–6% opacity; it must not read as glossy or neon.
- Light mode is intentional and legible, not merely an inverted dark theme.
- Cards, panels, toolbars, inputs, badges, tables, charts, code-like values, dialogs, overlays, and scrollbars use shared tokens and remain legible in both themes.
- Spacing, typography, radii, borders, shadows, and focus rings form one compact internal-tool system across all five views.

### Shell and interaction

- Desktop sidebar collapses and expands, persists its state with the existing storage contract, clearly highlights the active view, and exposes accessible labels/tooltips while collapsed.
- At mobile width the sidebar is an accessible drawer with backdrop, close button, Escape handling, scroll containment, and no page-width overflow.
- Header contains only real controls: current location, local-data status, command trigger, and theme control.
- A native, dependency-free command palette supports actual actions only: navigate among the five views, select a reporting range, refresh data, and choose system/light/dark theme. `Ctrl/Cmd+K` opens it; search filtering, keyboard activation, Escape, focus management, and focus return work.
- Theme selection persists under the existing key. System mode follows operating-system changes. Browser theme color tracks the resolved canvas color.
- Existing navigation, filters, refresh countdown, sorting, exports, baseline actions, and view lifecycle behavior continue to work.

### Pages and states

- Overview is the representative full migration: polished summary cards, dense sortable tables, responsive overflow, sticky table headers where useful, coherent filters, and real telemetry values only.
- Architecture, Throughput, Investigate, and Environment use the same hierarchy and components while retaining their domain-specific visualizations and actions.
- Initial loading presents a restrained skeleton or structured loading surface while retaining a live textual announcement.
- Request failures present a useful error surface with a real retry action.
- Empty, unavailable, capability-limited, and privacy-gated states remain distinct, explanatory, and action-oriented only where a real action exists.
- Wide tables/charts remain usable on mobile through horizontal scrolling, compact alternatives, or responsive restructuring without removing data.

### Quality and safety

- All current DOM IDs and `data-*` hooks used by behavior/tests remain stable unless an equivalent migration is made atomically with tests. Prefer additive markup/classes.
- No inline script/style, remote asset, external font, CDN, or new network destination is introduced.
- Keyboard navigation, semantic labels, live regions, visible focus, contrast, reduced motion, and dialog semantics are preserved or improved.
- `/`, `/health`, `/api/metrics`, static asset containment, CSP, read-only storage behavior, and privacy guarantees remain unchanged.
- `npm test`, targeted dashboard tests, `git diff --check`, and final Graphify refresh pass.
- Browser acceptance covers desktop and mobile, dark and light, expanded and collapsed/drawer shell, command palette, loading, populated, empty/unavailable, and retry/error presentation with clean console/network output.

## Architecture and frozen contracts

### Stack and security

- Continue with dependency-free semantic HTML, CSS, and browser ESM. Inline SVG icons are allowed; external assets are not.
- Do not modify `package.json`, `server.mjs`, `metrics.mjs`, `analytics/**`, or `environment.mjs` for visual work unless final integration reveals a verified defect. Any such defect becomes a new focused package, not opportunistic scope.
- Preserve same-origin modules/styles and the current CSP. New UI must work without `unsafe-inline` or remote connections.

### Metrics and privacy

- Keep the public `/api/metrics` contract unchanged.
- Preserve the second existing `/api/metrics` request for the immediately preceding equal-length `from`/`to` period, with the same root-session, title, and environment opt-ins as the current request.
- Preserve aggregate-only rendering, title opt-in, configured-environment opt-in, redacted baseline, export sanitization, and absence of raw session content.
- Do not re-aggregate normalized sessions or change token/tool attribution.

### State, DOM, and lifecycle

- `dashboardState` remains the owner of selected range, scoped session, title/environment opt-ins, current/previous payloads, and baseline state.
- View factories retain `mount`, `update`, and `destroy`; contexts remain `{ payload, previousPayload, state, actions }`.
- Existing view names remain `overview`, `architecture`, `throughput`, `investigate`, and `environment`.
- Existing theme and sidebar local-storage keys and accepted values remain stable.
- Existing IDs for shell controls, filters, status regions, Overview mounts, and feature-view mounts remain stable. New command and retry controls receive unique IDs and tests.
- Command actions must call existing view/range/theme/refresh pathways rather than duplicate state transitions.

### Theme token contract

- Keep the existing semantic variable names (`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--border`, `--input`, `--ring`, sidebar variables, status colors, radii, and shadows) so existing view CSS inherits the redesign.
- Tune dark tokens around this role map, with browser review allowed to adjust exact values within the stated visual ranges:
  - background/canvas: `#050b16`–`#07111f`
  - sidebar: `#07101d`–`#091423`
  - card/popover: `#0b1626`–`#0e1a2b`
  - raised/muted/accent: `#101d2f`–`#14243a`
  - border/input: low-contrast blue-grey, approximately `#1b2b41`–`#243750`
  - primary/focus: restrained blue around `#3b82f6`–`#60a5fa`
- Root `html`, `body`, `.app-shell`, content gutters, fixed shell elements, drawer backdrop, and dialog backdrop must explicitly resolve through navy-aware tokens; no neutral fallback may show around content.
- Add at most one restrained radial wash to the main canvas. All gradients must remain nonessential decoration.
- View-specific chart/table colors consume semantic tokens or theme-scoped variables; avoid hard-coded zinc/neutral dark fills.

### Component and behavior contract

- Reuse native primitives and existing renderer structure. Build the design language with shared CSS classes/tokens rather than cloning shadcn component code.
- Header: breadcrumb/current view, real local status, command trigger, and theme control only.
- Sidebar: real grouped telemetry navigation and privacy/local-evidence footer only.
- Command palette actions are limited to navigation, reporting range, refresh, and theme. It is a dialog, not fake global telemetry search.
- Existing bounded tables keep native sorting. Add sticky headers and responsive overflow where useful; do not add TanStack, pagination, URL-synced filters, or column visibility without demonstrated value.
- Existing select/checkbox/button controls remain real inputs. No forms or mutation dialogs are invented.
- Loading visuals never replace live-region text. Error retry re-enters the existing load path and respects in-flight request protection.

### Responsive and accessibility contract

- Desktop supports expanded and compact sidebar modes without clipping content.
- Tablet/mobile use the drawer; toolbars/action groups wrap, controls retain usable target sizes, dialogs remain inside the viewport, and tables/charts do not force body overflow.
- Icon-only controls have accessible names and visible focus. Selected navigation exposes `aria-current`; toggles expose state.
- Command dialog traps/contains practical keyboard interaction, restores focus, and honors Escape.
- Motion is minimal and disabled or reduced under `prefers-reduced-motion`.

## Dependency-ordered packages

### Wave 1 — foundation, shell, and representative page

#### Package 1A — design system, shell, and Overview (`MODE: FEATURE`)

**Exclusive ownership**

- `index.html`
- `dashboard/styles.css`
- `dashboard/app.mjs`
- `dashboard/core/renderers.mjs`
- `dashboard/core/tables.mjs`
- `dashboard/app.integration.test.mjs`

**Requirements**

- Establish the navy dark tokens and polished light tokens first; ensure root/background/theme-color coverage.
- Refine desktop collapse and mobile drawer behavior without changing storage or navigation contracts.
- Add the real command palette and keyboard/focus behavior through existing action paths.
- Fully migrate Overview, global toolbar/filters, cards, tables, status surfaces, skeleton loading, error/retry, empty/unavailable presentation, focus treatment, scrollbars, and reduced motion.
- Preserve all existing IDs, data flow, sorting, refresh behavior, current/prior requests, and CSP.
- Add focused integration coverage for command actions, theme persistence/system handling, sidebar persistence/drawer semantics, retry, and unchanged metrics-query behavior.

**Verify**

- Query Graphify before editing.
- Run `node --test dashboard/app.integration.test.mjs` and any directly affected core tests.
- Run `git diff --check`.
- Perform a representative desktop/mobile browser smoke for root navy coverage, Overview, collapse/drawer, theme, and command dialog. Do not run final Graphify refresh yet because later waves remain.

### Wave 2 — feature-view migration (parallel, disjoint ownership)

All packages consume Wave 1 tokens/components and must not edit `index.html`, `dashboard/styles.css`, `dashboard/app.mjs`, shared core files, backend files, or another view's files.

#### Package 2A — Architecture (`MODE: FEATURE`)

- Ownership: `dashboard/views/architecture.mjs`, `dashboard/views/architecture.css`, `dashboard/views/architecture.test.mjs`.
- Refine topology, metric controls, routing/role evidence, advice, bottlenecks, and execution tree into the shared hierarchy.
- Ensure SVG topology, labels, controls, semantic fallback, empty/unavailable states, and narrow layouts are legible in both themes.
- Verify the dedicated test file and browser-smoke metric switching/tree behavior.

#### Package 2B — Throughput (`MODE: FEATURE`)

- Ownership: `dashboard/views/throughput.mjs`, `dashboard/views/throughput.css`, `dashboard/views/throughput.test.mjs`.
- Refine KPI cards, denominator evidence, concurrency/trend visualizations, efficiency detail, rate tables, and prior-period deltas.
- Ensure SVG/table colors, tooltips/labels, empty/unavailable states, horizontal overflow, and mobile chart/table alternatives remain accessible in both themes.
- Verify the dedicated test file and browser-smoke chart/table behavior.

#### Package 2C — Investigate (`MODE: FEATURE`)

- Ownership: `dashboard/views/investigate.mjs`, `dashboard/views/investigate.css`, `dashboard/views/investigate.test.mjs`.
- Refine comparisons, reviewer outcomes, error hotspots, repeat-after-error events, and delegation health using dense table/list/status patterns.
- Preserve sample/confidence/evidence semantics, sorting/controls, responsive overflow, and all empty/unavailable distinctions.
- Verify the dedicated test file and browser-smoke comparison/filter behavior.

#### Package 2D — Environment (`MODE: FEATURE`)

- Ownership: `dashboard/views/environment.mjs`, `dashboard/views/environment.css`, `dashboard/views/environment.test.mjs`, `dashboard/core/export.mjs`, `dashboard/core/export.test.mjs`.
- Refine observed/configured inventory, opt-in information banner, baseline diff, and real export actions using shared form/button/table patterns.
- Preserve the privacy gate, redacted baseline, export schemas, formula safety, and configured/observed distinction.
- Ensure controls wrap cleanly and inventory/diff states remain usable on mobile.
- Verify dedicated environment/export tests and browser-smoke opt-in/baseline/export behavior.

Each Wave 2 worker queries Graphify first, runs its dedicated tests plus `git diff --check`, and does not refresh Graphify because the integration writer remains.

### Wave 3 — integration and final acceptance

#### Package 3A — dashboard integration (`MODE: INTEGRATION`)

**Ownership**

- Integration corrections across `index.html` and `dashboard/**`
- `README.md`
- Dashboard integration/browser test artifacts if added

**Requirements**

- Reconcile all five views against the frozen tokens and shell contracts; remove obsolete/conflicting styles and unused redesign markup only after proving it is unreferenced.
- Verify command, navigation, theme, range/scope/title/environment filters, refresh, current/prior comparison, sorting, lifecycle cleanup, baseline, and exports end to end.
- Update README screenshots/text only if the repository already documents the UI; do not add binary assets unless they add durable value.
- Run focused dashboard tests, full `npm test`, and `git diff --check`.
- Browser-check desktop and mobile in dark and light, including expanded/collapsed/drawer shell, command palette, populated and empty/unavailable states, and a controlled request failure with retry. Confirm clean console, network, and CSP behavior.
- Confirm `package.json` has no dependency changes and backend/API diffs are absent.
- As the final source writer, run `graphify update .` once after all corrections.

## Acceptance and review protocol

- The final authority accepts each package from its compact summary, interface-level diff, and verification result; do not replay worker traversal.
- Inspect implementation-critical contracts only: request construction/current-prior parity, stable DOM/action hooks, theme/root coverage, lifecycle cleanup, and privacy/CSP boundaries.
- Package 1A is high risk because it owns shell state and request error handling; challenge it before Wave 2. Use a dedicated reviewer only if a non-Luna reviewer is available. `luna-worker` must not be used for review.
- After Wave 2, defer broad visual reconciliation to Package 3A rather than allowing parallel workers to edit shared styles.
- Challenge the final integration result once; material issues return as one precise correction package.
- AFT diagnostics should be attempted after edit batches, but the baseline TypeScript language-server initialization crash is an environment limitation. Node tests and browser behavior remain authoritative.

## Decisions and assumptions

- The Kiranism reference supplies visual quality and interaction patterns, not its framework or demo domain.
- Native browser/HTML primitives are sufficient for the command dialog, responsive drawer, theme, tables, and status states; dependency delta remains zero.
- A command palette is useful because it accelerates real view/range/theme/refresh actions. Fake global data search is not useful and will not be added.
- Notifications, account/profile, organisation, billing, and mutation forms do not exist in this local aggregate-only application and will not be fabricated.
- Existing aggregate tables are bounded; native sorting, sticky headers, and responsive overflow are preferable to TanStack/pagination/column management.
- Dark mode is the primary visual acceptance target, but system and light modes remain first-class and persistent.
- The existing telemetry-investigation suite and its tests are accepted functional constraints, not redesign code to discard.
- Wave 1 selected the shared dark roles used by later views: canvas `#06101d`, sidebar `#081321`, card `#0c1828`, popover `#0e1a2b`, secondary/muted `#101d2f`, accent/raised `#14243a`, border `#1d2e45`, input `#243750`, and primary/focus `#60a5fa`. Feature views consume these shared tokens and do not retune them locally.

## Completed, blockers, and NEXT WAVE

- Completed: repository stack, shell, view ownership, data flow, routes, security/privacy constraints, and existing state were mapped with Graphify and targeted source inspection.
- Completed: objective, non-goals, acceptance criteria, visual token roles, public contracts, dependency order, and exclusive ownership are frozen.
- Completed: Wave 1 / Package 1A established the shared light/navy token system, persistent desktop/mobile shell, real command palette, representative Overview migration, responsive sortable tables, and structured loading/error/retry/empty states while preserving existing IDs and request/action paths.
- Accepted verification: app integration 6/6, directly affected core tests 8/8, dashboard suite 41/41, JavaScript syntax, and `git diff --check` passed. Desktop/mobile browser smoke passed for dark/light/system themes, Overview, collapse/drawer, command filtering/actions/focus return, persistence, and controlled error/retry behavior.
- Completed: Wave 2 / Packages 2A–2D migrated Architecture, Throughput, Investigate, and Environment/export within exclusive ownership. Shared lifecycle, IDs, evidence/availability semantics, current/previous analytics, privacy gating, redacted baseline, export schemas, and spreadsheet formula safety remain intact.
- Accepted verification: Architecture 8/8 plus integration 6/6; Throughput 7/7 plus full suite 111 passed and 1 skipped; Investigate 6/6; Environment/export 14/14. Owned JavaScript syntax and diff checks passed. Throughput mobile/dark browser smoke passed; remaining feature-view and cross-view browser acceptance is intentionally deferred to Package 3A.
- Environment limitation: AFT diagnostics remain unavailable because `typescript-language-server` crashes during initialization. Node tests and browser behavior are authoritative; this is not a source blocker.
- Completed: Wave 3 / Package 3A reconciled all five views and required one precise shared-style correction: `html` and `.app-shell` now explicitly resolve their backgrounds through `--background`, closing the frozen root-theme coverage contract. No other integration correction was required.
- Accepted verification: focused dashboard tests 47/47; full `npm test` 115 passed and 1 skipped; JavaScript syntax 18/18; and `git diff --check` passed. `package.json` is unchanged, and Package 3A added no backend/API changes.
- Accepted browser matrix: all five views, current/prior comparison, baseline and exports, populated and unavailable states, controlled failure/retry, command palette, desktop expanded/collapsed shell, mobile drawer, and light/dark themes passed with clean console, network, and CSP behavior. Explicit root backgrounds passed 12/12 computed-style checks across light/dark desktop/mobile.
- Completed: temporary servers and smoke artifacts were cleaned, and Graphify was refreshed after the final source correction.
- Environment limitation: AFT diagnostics remain unavailable because `typescript-language-server` crashes during initialization. Node tests and browser behavior remain authoritative; this is not a source blocker.
- Blockers: none. The worktree remains intentionally uncommitted and preserves the telemetry-investigation baseline.
- NEXT WAVE: none. The redesign epic is complete and accepted.
