# Codex v3 batched-actions benchmark (`k=3`)

This report compares native Codex transcript + Code Mode (`baseline`), kernel SKILL.state v2 with one direct action per
turn, and kernel v3 with an unlimited strictly sequential action array. All modes used the same research `codex` binary,
medium reasoning, five independent one-shot tasks, black-box evaluators, one active runner, and a 15-minute cell limit.

The baseline additionally requires a compatible `codex-code-mode-host`. The harness now rejects a missing/non-executable
companion and records its SHA-256, preventing silent fallback to direct tools.

## GPT-5.6 Sol

Valid suite: [`20260904T023020Z`](./results/20260904T023020Z/report.md). All 15 cells exited zero, no timeout, and baseline
stderr contained no Code Mode fallback warning.

| Mode | Hidden checks | Input tokens | Samples | Change from baseline |
|---|---:|---:|---:|---:|
| Baseline | 40/40 | 1,582,573 | 55 | — |
| V2 | 40/40 | 990,678 | 57 | -37.4% |
| V3 | 40/40 | 818,113 | 44 | -48.3% |

V3 executed 79 actions in 44 batch observations. Sixteen batches were multi-action and the largest contained six.
Compared with v2 it reduced samples by 22.8% and input by 17.4% at identical quality. Results remained task-dependent:
v3 beat v2 strongly on `csv-insights`, `mini-template`, and `dependency-planner`, but lost on `taskboard-cli` and
`http-kv`.

An earlier partial Sol suite (`20260904T015626Z`) is invalid: `codex` had been rebuilt after `cargo clean`, but its Code
Mode companion had not. Baseline silently fell back to direct tools and scored 1/8 and 2/8 on its first two tasks. The
run was stopped, the companion check was added, and none of those cells is included above.

Three pre-suite diagnostics are retained for audit but excluded from aggregates: Sol v3 `mini-template`
[`20260904T014327Z`](./results/20260904T014327Z/) scored 8/8; Terra v3 `mini-template`
[`20260904T015342Z`](./results/20260904T015342Z/) scored 7/8; and the post-fix Sol baseline Code Mode smoke
[`20260904T022644Z`](./results/20260904T022644Z/) scored 8/8.

## GPT-5.6 Terra

Composite valid report: [`20260904T114822Z`](./results/20260904T114822Z/report.md), reusing ten clean cells from
[`20260904T032227Z`](./results/20260904T032227Z/report.md) and five clean retry cells. The original five cells were
discarded after a host/network interruption (`No route to host`) and timeout; the retry used fresh workspaces and one
runner. The composite contains 15 unique zero-exit, non-timeout cells.

| Mode | Hidden checks | Input tokens | Samples | Change from baseline |
|---|---:|---:|---:|---:|
| Baseline | 40/40 | 1,907,750 | 59 | — |
| V2 | 40/40 | 1,171,999 | 68 | -38.6% |
| V3 | 39/40 | 1,867,198 | 102 | -2.1% |

V3 executed 118 actions in 102 batch observations, but only 13 batches were multi-action; maximum length was five.
Terra therefore paid nearly one provider call per action. `taskboard-cli` and `csv-insights` were especially costly
(32 and 29 samples), while `http-kv` was a strong positive case (9 samples and 160,066 input versus v2's 19 and
329,474). The aggregate nearly erased the state-context saving and lost one `mini-template` check.

## Interpretation

V3 validated the core hypothesis on Sol: exposing sequential batches can recover tool granularity lost when v2 disables
Code Mode. It did not do so reliably on Terra. The schema's lack of a count limit was not the failure mode—neither model
produced a large array. The decisive variable was whether the model chose multi-action batches often enough to reduce
provider samples. These are exploratory `n=1` results, not stable model rankings.
