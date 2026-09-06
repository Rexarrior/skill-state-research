# Codex CLI one-shot multimode results

Suite: `20260905T232344Z`

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
| taskboard-cli | 8/8 | 139,930 | 8 | 0 | 8/8 | 309,162 | 17 | 0 |
| csv-insights | 8/8 | 143,045 | 8 | 0 | 8/8 | 226,989 | 13 | 0 |
| mini-template | 8/8 | 247,863 | 14 | 0 | 8/8 | 144,077 | 8 | 0 |
| http-kv | 9/9 | 259,302 | 15 | 0 | 9/9 | 286,676 | 15 | 0 |
| dependency-planner | 7/7 | 117,102 | 7 | 0 | 7/7 | 131,737 | 7 | 0 |
| **Total** | **40/40** | **907,242** | **52** | **—** | **40/40** | **1,098,641** | **60** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 907,242 | 0.0% |
| V3 | 1,098,641 | 0.0% |

## Aggregate counters

| Metric | V2 | V3 |
|---|---:|---:|
| Input tokens | 907,242 | 1,098,641 |
| Cached input tokens | 531,456 | 596,736 |
| Output tokens | 41,113 | 51,567 |
| Reasoning tokens | 6,417 | 10,071 |
| Provider samples | 52 | 60 |
| Command executions | 40 | 75 |
| File-change events | 6 | 7 |
| CLI error events | 0 | 0 |
| State transitions | 52 | 60 |
| State transition errors | 19 | 21 |
| State comments | 52 | 60 |
| Finish transitions | 5 | 5 |
| Consecutive repeated actions | 0 | 0 |
| Maximum repeat streak | 1 | 1 |
| Maximum state bytes | 1,061 | 1,037 |
| Actions inside v3 batches | 0 | 90 |
| Multi-action v3 batches | 0 | 15 |
| Failed v3 batches | 0 | 21 |
| Skipped v3 actions | 0 | 3 |
| Maximum actions per batch | 0 | 5 |

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260905T232344Z`.
