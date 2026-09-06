# Codex CLI one-shot multimode results

Suite: `20260905T232353Z`

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
| taskboard-cli | 8/8 | 117,815 | 7 | 0 | 8/8 | 191,868 | 10 | 0 |
| csv-insights | 8/8 | 122,591 | 7 | 0 | 8/8 | 435,872 | 22 | 0 |
| mini-template | 8/8 | 239,215 | 14 | 0 | 8/8 | 255,428 | 14 | 0 |
| http-kv | 9/9 | 196,110 | 11 | 0 | 9/9 | 391,669 | 21 | 0 |
| dependency-planner | 7/7 | 123,756 | 7 | 0 | 7/7 | 221,762 | 12 | 0 |
| **Total** | **40/40** | **799,487** | **46** | **—** | **40/40** | **1,496,599** | **79** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 799,487 | 0.0% |
| V3 | 1,496,599 | 0.0% |

## Aggregate counters

| Metric | V2 | V3 |
|---|---:|---:|
| Input tokens | 799,487 | 1,496,599 |
| Cached input tokens | 391,424 | 874,880 |
| Output tokens | 38,810 | 63,280 |
| Reasoning tokens | 4,586 | 11,067 |
| Provider samples | 46 | 79 |
| Command executions | 33 | 119 |
| File-change events | 8 | 7 |
| CLI error events | 0 | 0 |
| State transitions | 46 | 79 |
| State transition errors | 18 | 29 |
| State comments | 46 | 78 |
| Finish transitions | 5 | 5 |
| Consecutive repeated actions | 0 | 0 |
| Maximum repeat streak | 1 | 1 |
| Maximum state bytes | 982 | 1,364 |
| Actions inside v3 batches | 0 | 151 |
| Multi-action v3 batches | 0 | 37 |
| Failed v3 batches | 0 | 29 |
| Skipped v3 actions | 0 | 20 |
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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260905T232353Z`.
