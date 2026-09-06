# Technical article campaign — 2026-09-04

The matrix and failure-retention policy were chosen before the new main results. Source base:
`08c908c2aa5f274fe0165c4b8c635ef16d52346c` plus the documented conformance fixes. Audit findings, accounting and
scheduling clarifications are recorded below as discovered. This is an exploratory engineering replication,
not a preregistered confirmatory scientific study.

## Matrix

- OpenCode and Codex; GPT-5.6 Sol and Terra; five existing greenfield specifications.
- Native (`baseline`), Paper, V2, V3; one attempt per cell: 80 cells.
- Codex V2/V3: two additional complete repetitions on both models: 40 more cells.
- Maximum two simultaneous benchmark cells globally, at most one per sequential runner lane.
- Existing 15-minute cell budget. OpenCode retains its existing 80-step budget and temperature 0;
  Codex retains medium reasoning. No claim that the settings or absolute usage match across runtimes.
- Empty independent workspaces. One initial user instruction per task, hidden evaluator outside workspace.
- Rotate mode order across projects; repeat order recorded. No seed search or best-of selection.

These are separate work directories on one host, not isolated containers. OpenCode explicitly disables its task
subagent tool; the Codex runner retains product-default collaboration settings. The global limit counts benchmark
CLI cells, not an asserted upper bound on all internal provider requests. Linked Codex descendants are audited by
kind and model in auxiliary-usage.json, including any coding delegates as well as permission guardians; do not assume
delegation was disabled merely because skills were disabled.

Repeat scheduling clarification, recorded before starting the additional repetitions but after partial main results:
repetition 1 starts with `v3 v2`, repetition 2 with `v2 v3`; the existing runner rotates that order across projects.
Each freed lane runs one repetition's Sol and Terra suites sequentially. Two Codex lanes may overlap after the
OpenCode lane completes, without exceeding the global two-cell limit. This is not a randomized order assignment.

## Frozen changes and audit

1. Codex: plain assistant text cannot terminate a state-mode run; an accepted finish transition is required.
2. Both kernels: shell nonzero exits count as action errors when deciding whether to skip the remaining batch.
3. Paper: advertised patch schema no longer offers null deletion of required coding-state containers.
   Null deletion remains supported for dictionary entries in files; arrays may be replaced by empty arrays.
4. Keep typed tool-call transport. This reproduces the paper's execution/memory architecture, not Appendix A's
   literal fenced-text output encoding. The difference is disclosed, not treated as empirically irrelevant.
5. No task/evaluator changes. The failing template evaluator explicitly tests `this.name` and root fallback;
   the specification requires path interpolation and current-item access. The result is retained as a task failure.

Source snapshots and executable hashes are recorded separately. If runtime behavior changes again, mark the affected
suite as a separate version and repeat affected comparisons rather than merge them invisibly.

## Outcomes

Primary descriptive measures: hidden checks, fully passing projects, cumulative input, provider calls.
Additional: output/cache counters, wall time, finish count, protocol/tool errors, batch counts and sizes.
Scope clarification from the rollout audit: these counters describe the main agent thread. Codex's automatic
permission reviewer runs in a separate guardian thread. Its recorded usage is collected separately via
parent_thread_id in auxiliary-usage.json, rather than silently folded into the primary series. Interrupted requests
may have no returned usage record; reported totals are observed usage, not provider invoices.
40 checks are not 40 independent tasks. A completed process is not necessarily successful protocol completion.
Timeouts and protocol failures remain outcomes, with partial artifact scores reported separately. No dollar-cost
claim without resolving provider accounting; cached input must not be counted twice.

Accounting correction discovered during source audit, before aggregate outcomes: OpenCode `getUsage` subtracts both
cache read and write from `tokens.input`, and subtracts reasoning from `tokens.output`. The article reconstructs
full input as `input + cacheRead + cacheWrite`, full output as `output + reasoning`. Codex totals already include
these respective subsets. This changes analysis, not model execution; raw counters suffice, no run is discarded.
Legacy per-suite reports still use their explicitly named `input + cache.read` metric; the campaign report supersedes
that metric for the article. See the separate accounting audit.

## Exclusions and retry rules

- `experiments/skill-state/results/20260904T195607Z` and `20260904T195630Z`: sandbox prevented opening the OpenCode
  log file before model invocation. Zero provider turns; infrastructure only, excluded from model comparisons.
- Never replace ordinary slow model runs, bad code or invalid payloads with successful retries.
- Codex diagnostic suite `20260904T200756Z` stopped during its first Paper cell: `apply_patch` observations contained
  the Code Mode placeholder `{}` rather than the actual tool confirmation. This is an adapter defect, not a valid
  Paper outcome. The live trace is retained under `diagnostics/paper-empty-patch-result.jsonl`. The entire Codex
  comparison restarts with the corrected adapter, including Native; no favorable cells are selectively reused.
- Retry a cell only on explicit infrastructure evidence (e.g. network unreachable or startup permission failure),
  retaining the original record and linking the new independent workspace. No automatic retry-failed sweep.
- Abort a suite for a shared broken environment rather than treating empty workspaces as model performance.

## Publication

Late trace-audit clarification: Codex startup messages retain a host user-profile/instruction bundle and plugin
recommendations even with `--ignore-user-config` and disabled skills. The state kernel incorporates initial
non-assistant messages into P using textual role labels, whereas Native retains API message roles. This is not a
clean-room or role-matched benchmark. In the planned Sol/template V3 case the model attempted to read local reference
files named by these instructions. Startup hashes/markers are retained in host-context-audit.json without copying
personal instructions into the article. Runtime/settings remain frozen; isolated host instructions and role-preserving
controls belong to the next scientific campaign. The current observations characterize this configured host.

Article narrative follows measured outcomes even if the previous V3 advantage disappears. Publish complete tables,
not only favorable projects. Batch-window and action-granularity confounding remain explicit. Long-horizon scaling
and independent component ablations are future work described in the research plan.
