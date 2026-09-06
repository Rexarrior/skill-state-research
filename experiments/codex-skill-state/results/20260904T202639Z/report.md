# Codex CLI one-shot multimode results

Suite: `20260904T202639Z`

Model: `gpt-5.6-sol` (reasoning effort: `medium`)

Selected modes: `baseline`, `v2`, `v3`, `paper`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 1 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools. V2 preserves one-patch/one-action transitions;
v3 applies one patch and executes a non-empty, unbounded action array strictly sequentially.


| Project | Baseline score | Baseline input | Samples | Exit | V2 score | V2 input | Samples | Exit | V3 score | V3 input | Samples | Exit | Paper score | Paper input | Samples | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 322,807 | 14 | 0 | 8/8 | 144,312 | 8 | 0 | 8/8 | 174,460 | 9 | 0 | 8/8 | 1,080,252 | 66 | timeout |
| csv-insights | 8/8 | 291,928 | 10 | 0 | 8/8 | 221,643 | 12 | 0 | 8/8 | 318,751 | 16 | 0 | 7/8 | 1,396,898 | 86 | timeout |
| mini-template | 8/8 | 247,307 | 11 | 0 | 8/8 | 165,591 | 10 | 0 | 8/8 | 232,427 | 13 | 0 | 8/8 | 1,082,380 | 68 | timeout |
| http-kv | 9/9 | 363,895 | 13 | 0 | 9/9 | 644,546 | 35 | 0 | 9/9 | 466,232 | 24 | 0 | 9/9 | 189,034 | 12 | 0 |
| dependency-planner | 7/7 | 414,427 | 14 | 0 | 7/7 | 221,172 | 12 | 0 | 7/7 | 88,216 | 5 | 0 | 7/7 | 436,722 | 27 | 0 |
| **Total** | **40/40** | **1,640,364** | **62** | **—** | **40/40** | **1,397,264** | **77** | **—** | **40/40** | **1,280,086** | **67** | **—** | **39/40** | **4,185,286** | **259** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 1,397,264 | 14.8% |
| V3 | 1,280,086 | 22.0% |
| Paper | 4,185,286 | -155.1% |

## Aggregate counters

| Metric | Baseline | V2 | V3 | Paper |
|---|---:|---:|---:|---:|
| Input tokens | 1,640,364 | 1,397,264 | 1,280,086 | 4,185,286 |
| Cached input tokens | 1,496,960 | 740,096 | 618,752 | 2,969,984 |
| Output tokens | 59,784 | 72,196 | 59,653 | 125,446 |
| Reasoning tokens | 20,449 | 9,129 | 8,778 | 13,518 |
| Provider samples | 62 | 77 | 67 | 259 |
| Command executions | 40 | 60 | 90 | 247 |
| File-change events | 16 | 10 | 8 | 8 |
| CLI error events | 0 | 0 | 0 | 0 |
| State transitions | 0 | 77 | 67 | 258 |
| State transition errors | 0 | 25 | 20 | 84 |
| State comments | 0 | 76 | 65 | 0 |
| Finish transitions | 0 | 5 | 5 | 2 |
| Consecutive repeated actions | 0 | 0 | 0 | 28 |
| Maximum repeat streak | 0 | 1 | 1 | 4 |
| Maximum state bytes | 0 | 1,075 | 965 | 1,923 |
| Actions inside v3 batches | 0 | 0 | 112 | 0 |
| Multi-action v3 batches | 0 | 0 | 26 | 0 |
| Failed v3 batches | 0 | 0 | 20 | 0 |
| Skipped v3 actions | 0 | 0 | 9 | 0 |
| Maximum actions per batch | 0 | 0 | 7 | 0 |

## Binary provenance

- Baseline: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc`.
- V2: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc`.
- V3: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc`.
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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260904T202639Z`.
