# Codex CLI one-shot multimode results

Suite: `20260906T010737Z`

Model: `gpt-5.6-sol` (reasoning effort: `medium`)

Selected modes: `baseline`, `paper`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 1 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools. V2 preserves one-patch/one-action transitions;
v3 applies one patch and executes a non-empty, unbounded action array strictly sequentially.


| Project | Baseline score | Baseline input | Samples | Exit | Paper score | Paper input | Samples | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 147,812 | 7 | 0 | 8/8 | 107,855 | 7 | 0 |
| csv-insights | 8/8 | 436,942 | 13 | 0 | 8/8 | 567,045 | 35 | 0 |
| mini-template | 8/8 | 377,547 | 15 | 0 | 8/8 | 174,200 | 11 | 0 |
| http-kv | 9/9 | 699,907 | 19 | 0 | 9/9 | 1,015,524 | 62 | timeout |
| dependency-planner | 7/7 | 270,342 | 9 | 0 | 7/7 | 284,191 | 18 | 0 |
| **Total** | **40/40** | **1,932,550** | **63** | **—** | **40/40** | **2,148,815** | **133** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| Paper | 2,148,815 | -11.2% |

## Aggregate counters

| Metric | Baseline | Paper |
|---|---:|---:|
| Input tokens | 1,932,550 | 2,148,815 |
| Cached input tokens | 1,731,968 | 1,462,144 |
| Output tokens | 59,148 | 103,376 |
| Reasoning tokens | 20,874 | 11,099 |
| Provider samples | 63 | 133 |
| Command executions | 40 | 122 |
| File-change events | 18 | 7 |
| CLI error events | 0 | 0 |
| State transitions | 0 | 133 |
| State transition errors | 0 | 23 |
| State comments | 0 | 0 |
| Finish transitions | 0 | 4 |
| Consecutive repeated actions | 0 | 8 |
| Maximum repeat streak | 0 | 5 |
| Maximum state bytes | 0 | 2,987 |
| Actions inside v3 batches | 0 | 0 |
| Multi-action v3 batches | 0 | 0 |
| Failed v3 batches | 0 | 0 |
| Skipped v3 actions | 0 | 0 |
| Maximum actions per batch | 0 | 0 |

## Binary provenance

- Baseline: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc`.
- Paper: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc`.

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260906T010737Z`.
