# Codex CLI one-shot multimode results

Suite: `20260904T212003Z`

Model: `gpt-5.6-sol` (reasoning effort: `medium`)

Selected modes: `v2`, `v3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 1 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools. V2 preserves one-patch/one-action transitions;
v3 applies one patch and executes a non-empty, unbounded action array strictly sequentially.


| Project | V2 score | V2 input | Samples | Exit | V3 score | V3 input | Samples | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 251,273 | 15 | 0 | 8/8 | 202,437 | 11 | 0 |
| csv-insights | 8/8 | 133,887 | 8 | 0 | 7/8 | 177,882 | 9 | 0 |
| mini-template | 8/8 | 132,629 | 8 | 0 | 8/8 | 186,590 | 10 | 0 |
| http-kv | 9/9 | 594,022 | 32 | 0 | 9/9 | 385,635 | 20 | 0 |
| dependency-planner | 7/7 | 161,407 | 9 | 0 | 7/7 | 115,131 | 6 | 0 |
| **Total** | **40/40** | **1,273,218** | **72** | **—** | **39/40** | **1,067,675** | **56** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 1,273,218 | 0.0% |
| V3 | 1,067,675 | 0.0% |

## Aggregate counters

| Metric | V2 | V3 |
|---|---:|---:|
| Input tokens | 1,273,218 | 1,067,675 |
| Cached input tokens | 707,584 | 644,480 |
| Output tokens | 65,077 | 65,552 |
| Reasoning tokens | 10,496 | 9,221 |
| Provider samples | 72 | 56 |
| Command executions | 58 | 83 |
| File-change events | 7 | 6 |
| CLI error events | 0 | 0 |
| State transitions | 72 | 56 |
| State transition errors | 23 | 27 |
| State comments | 72 | 56 |
| Finish transitions | 5 | 5 |
| Consecutive repeated actions | 0 | 1 |
| Maximum repeat streak | 1 | 2 |
| Maximum state bytes | 956 | 1,474 |
| Actions inside v3 batches | 0 | 117 |
| Multi-action v3 batches | 0 | 28 |
| Failed v3 batches | 0 | 27 |
| Skipped v3 actions | 0 | 23 |
| Maximum actions per batch | 0 | 6 |

## Binary provenance

- V2: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc`.
- V3: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc`.

Baseline Code Mode host: `<nda context deleted, size :114 chars>`, SHA-256 `b5ce3a2a9d1c65389c5fb32fa2b734251b644929d039cf4867683d39a90b9630`.


Baseline source: baseline runtime mode in the same research binary.

The prompt, model, reasoning effort, sandbox, fixtures, evaluator, and concurrency are held constant. Binary hashes and
source provenance are recorded so a suite can be rejected if the baseline is not the intended pristine revision.

## Interpretation guardrails

- This is an exploratory `n=1` run per cell; model variance can dominate small differences.
- Short code-generation tasks test quality and crossover overhead, not the paper's asymptotic long-horizon claim.
- A token reduction is useful only at comparable evaluator quality. Timeouts and non-zero exits must be treated as failed
  cells, not token savings.
- Each cell contains `events.jsonl`, `stderr.log`, `summary.json`, and, when persistence succeeds, the raw
  `rollout.jsonl` with auditable state transitions.

Generated workspace paths are recorded in each cell summary. State workspaces for this suite are under
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260904T212003Z`.
