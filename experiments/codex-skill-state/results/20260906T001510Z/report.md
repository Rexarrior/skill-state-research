# Codex CLI one-shot multimode results

Suite: `20260906T001510Z`

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
| taskboard-cli | 8/8 | 102,635 | 6 | 0 | 8/8 | 138,001 | 8 | 0 |
| csv-insights | 8/8 | 210,875 | 12 | 0 | 8/8 | 196,282 | 10 | 0 |
| mini-template | 8/8 | 268,227 | 16 | 0 | 7/8 | 174,606 | 9 | 0 |
| http-kv | 9/9 | 309,213 | 17 | 0 | 9/9 | 899,653 | 46 | timeout |
| dependency-planner | 7/7 | 100,110 | 6 | 0 | 7/7 | 157,905 | 9 | 0 |
| **Total** | **40/40** | **991,060** | **57** | **—** | **39/40** | **1,566,447** | **82** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 991,060 | 0.0% |
| V3 | 1,566,447 | 0.0% |

## Aggregate counters

| Metric | V2 | V3 |
|---|---:|---:|
| Input tokens | 991,060 | 1,566,447 |
| Cached input tokens | 571,648 | 959,872 |
| Output tokens | 46,421 | 75,166 |
| Reasoning tokens | 6,611 | 10,176 |
| Provider samples | 57 | 82 |
| Command executions | 44 | 101 |
| File-change events | 8 | 9 |
| CLI error events | 0 | 0 |
| State transitions | 57 | 82 |
| State transition errors | 18 | 33 |
| State comments | 57 | 80 |
| Finish transitions | 5 | 4 |
| Consecutive repeated actions | 0 | 0 |
| Maximum repeat streak | 1 | 1 |
| Maximum state bytes | 1,262 | 1,182 |
| Actions inside v3 batches | 0 | 125 |
| Multi-action v3 batches | 0 | 26 |
| Failed v3 batches | 0 | 33 |
| Skipped v3 actions | 0 | 10 |
| Maximum actions per batch | 0 | 7 |

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260906T001510Z`.
