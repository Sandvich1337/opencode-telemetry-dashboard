# OpenCode telemetry dashboard

This is a zero-dependency Node 24+ dashboard for aggregate telemetry from
`opencode.db`. It uses the built-in `node:sqlite` module and opens the database
read-only. The server binds only to `127.0.0.1` and makes no prompt, plugin,
model, or external network requests.

## Run

Requires Node.js 24 or newer. Clone and run it from any path:

```sh
git clone https://github.com/sandvich1337/opencode-telemetry-dashboard.git
cd opencode-telemetry-dashboard
npm ci
npm start
```

Then open <http://127.0.0.1:4173>. Use `--db PATH` to select a database and
`--port PORT` to select a loopback port. Pass `--open` to launch the default
browser; the `.cmd` launcher opens it automatically. `GET /health`
returns a database-independent health check.

The database can also be selected with `OPENCODE_DB_PATH`. Without that
variable, the dashboard checks the standard OpenCode data locations under the
user profile.

The visible page refreshes every 60 seconds only while the document is visible;
hidden tabs do not poll. The selector lists root sessions only. Selecting a root
includes that root and every descendant, so its cards summarize the complete
session run. Parent-child sessions are shown in a compact spawn topology;
clicking an individual child scopes the cards and tables to that child alone.
Tool usage is split into collapsible agent blocks in both views.

The dashboard navigation keeps the legacy summary and sortable tables visible
while exposing Architecture, Throughput, Investigate, and Environment views.
For finite ranges, the investigation views request an equal-length preceding
period with the same session and privacy options. Throughput comparisons show
the denominator and sample evidence; unavailable analytics remain explicitly
unavailable rather than becoming zero.

Navigation and time-range controls are keyboard accessible and remain usable at
narrow widths; changing a filter keeps the latest request authoritative. The
configured-inventory opt-in is withdrawn from the visible view immediately,
before the refreshed request completes.

Configured environment inventory is shown only after both the local checkbox
and the server request opt in. The Environment view can save a redacted local
baseline and compare it with later data, or download the allow-listed aggregate
inventory as deterministic JSON or principal CSV. Downloads are generated in
the browser and never send data to a remote service.

## Metrics

Only `session`, `message`, and `part` are read. The dashboard reports runs and
subagents grouped by agent/model, token splits, estimated API-equivalent cost, tool/read/error counts,
duration, metadata file additions/deletions, and aggregate reviewer-slot
totals. Reviewer summaries include ISSUE/PASS/UNKNOWN percentages per slot and
the ISSUE rate for the second reviewer after a first PASS.

The dashboard displays no reviewer rows and does not surface raw message text,
tool input/output, IDs, file paths, database paths, prompts, or plugin data by
default. The optional **Show root titles** control groups root sessions by their
OpenCode title; child titles are never sent. Root titles can contain
prompt-derived text, so this opt-in is off on every page load.
Schema capability checks are surfaced instead of guessing when a required table
or column is unavailable.

Input and output cards show their aggregate token totals separately. OpenCode
records provider usage per model step, not per tool. The dashboard therefore
splits each token bucket evenly across calls in a conserved step; if step data
is incomplete it falls back to all tool calls in that message. Steps without a
tool remain `Unattributed / no tool`. This is an allocation estimate, not causal
per-tool metering, and the rows always conserve the recorded total. Aggregate
results are cached for the current view and refreshed on the visible-only
interval; the cache is read-only and does not modify `opencode.db`.

Cache-write totals distinguish a reported zero from missing provider telemetry.
When no selected message reports a cache-write field, the dashboard shows
`Not reported` instead of presenting the missing data as a measured zero.

## Estimated USD

The dashboard reports a current API-equivalent estimate, not an invoice:

```text
USD = (input × input_rate
     + cache_read × cache_read_rate
     + cache_write × cache_write_rate
     + (output + reasoning) × output_rate) / 1,000,000
```

Rates are USD per million tokens. The catalog date is **2026-08-17** and its
source is <https://platform.openai.com/docs/pricing>. Rates are listed as
`input / cache-read / cache-write / output`:

| Model | Short context | Long context |
| --- | ---: | ---: |
| luna | 0.20 / 0.02 / 0.25 / 1.20 | 0.40 / 0.04 / 0.50 / 1.80 |
| terra | 2.00 / 0.20 / 2.50 / 12.00 | 4.00 / 0.40 / 5.00 / 18.00 |
| sol | 5.00 / 0.50 / 6.25 / 30.00 | 10.00 / 1.00 / 12.50 / 45.00 |

The `*-fast` catalog variants use twice the corresponding rate. The long
context tier applies when input + cache-read + cache-write exceeds **272,000
tokens** (or when long context is explicitly selected). Supported
`gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol` names map to these catalog
entries.

Privacy is local and aggregate-only: no prompts, raw tool payloads, IDs, paths,
plugin data, or database contents are sent anywhere. The dashboard adds zero
prompt, plugin, model, or network overhead.

## CLI and npm

```sh
npm start
npm run metrics -- --json
npm run metrics -- --db path/to/opencode.db --range 7d
```

The `metrics` script emits aggregate JSON. The `metrics:dashboard` script starts
the loopback dashboard and opens the browser. Neither command modifies the
database.

## Verify

```sh
npm ci
npm test
```
