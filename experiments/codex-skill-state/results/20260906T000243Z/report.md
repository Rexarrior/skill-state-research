# Codex CLI one-shot multimode results

Suite: `20260906T000243Z`

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
| taskboard-cli | 7/8 | 158,580 | 9 | 0 | 8/8 | 170,861 | 9 | 0 |
| csv-insights | 8/8 | 349,632 | 19 | 0 | 8/8 | 171,854 | 9 | 0 |
| mini-template | 8/8 | 148,015 | 9 | 0 | 8/8 | 171,548 | 9 | 0 |
| http-kv | 9/9 | 385,343 | 21 | 0 | 9/9 | 275,220 | 15 | 0 |
| dependency-planner | 7/7 | 273,533 | 15 | 0 | 7/7 | 120,161 | 6 | 0 |
| **Total** | **39/40** | **1,315,103** | **73** | **—** | **40/40** | **909,644** | **48** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 1,315,103 | 0.0% |
| V3 | 909,644 | 0.0% |

## Aggregate counters

| Metric | V2 | V3 |
|---|---:|---:|
| Input tokens | 1,315,103 | 909,644 |
| Cached input tokens | 709,120 | 533,760 |
| Output tokens | 69,552 | 49,408 |
| Reasoning tokens | 8,431 | 7,688 |
| Provider samples | 73 | 48 |
| Command executions | 58 | 71 |
| File-change events | 10 | 7 |
| CLI error events | 0 | 0 |
| State transitions | 73 | 47 |
| State transition errors | 29 | 19 |
| State comments | 73 | 43 |
| Finish transitions | 5 | 5 |
| Consecutive repeated actions | 0 | 1 |
| Maximum repeat streak | 1 | 2 |
| Maximum state bytes | 1,366 | 1,127 |
| Actions inside v3 batches | 0 | 99 |
| Multi-action v3 batches | 0 | 22 |
| Failed v3 batches | 0 | 19 |
| Skipped v3 actions | 0 | 16 |
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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260906T000243Z`.
