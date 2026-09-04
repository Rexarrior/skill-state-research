# Codex CLI one-shot multimode results

Suite: `20260904T032227Z`

Model: `gpt-5.6-terra` (reasoning effort: `medium`)

Selected modes: `baseline`, `v2`, `v3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 1 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools. V2 preserves one-patch/one-action transitions;
v3 applies one patch and executes a non-empty, unbounded action array strictly sequentially.


| Project | Baseline score | Baseline input | Samples | Exit | V2 score | V2 input | Samples | Exit | V3 score | V3 input | Samples | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 283,150 | 9 | 0 | 8/8 | 278,590 | 16 | 0 | 8/8 | 604,395 | 32 | 0 |
| csv-insights | 8/8 | 626,790 | 17 | 0 | 8/8 | 172,743 | 10 | 0 | 8/8 | 521,819 | 29 | 0 |
| mini-template | 8/8 | 193,355 | 7 | 0 | 8/8 | 164,794 | 10 | 0 | 7/8 | 295,916 | 17 | 0 |
| http-kv | 9/9 | 662,755 | 19 | 0 | 0/9 | 30,894 | 2 | timeout | 0/9 | 0 | 0 | timeout |
| dependency-planner | 1/7 | 0 | 0 | timeout | 1/7 | 0 | 0 | timeout | 1/7 | 0 | 0 | timeout |
| **Total** | **34/40** | **1,766,050** | **52** | **—** | **25/40** | **647,021** | **38** | **—** | **24/40** | **1,422,130** | **78** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 647,021 | 63.4% |
| V3 | 1,422,130 | 19.5% |

## Aggregate counters

| Metric | Baseline | V2 | V3 |
|---|---:|---:|---:|
| Input tokens | 1,766,050 | 647,021 | 1,422,130 |
| Cached input tokens | 1,606,656 | 310,784 | 1,025,536 |
| Output tokens | 36,578 | 20,424 | 43,649 |
| Reasoning tokens | 9,110 | 2,740 | 8,091 |
| Provider samples | 52 | 38 | 78 |
| Command executions | 33 | 26 | 72 |
| File-change events | 17 | 8 | 13 |
| CLI error events | 0 | 0 | 0 |
| State transitions | 0 | 38 | 78 |
| State transition errors | 0 | 1 | 3 |
| State comments | 0 | 38 | 78 |
| Finish transitions | 0 | 3 | 3 |
| Consecutive repeated actions | 0 | 0 | 0 |
| Maximum repeat streak | 0 | 1 | 1 |
| Maximum state bytes | 0 | 812 | 952 |
| Actions inside v3 batches | 0 | 0 | 92 |
| Multi-action v3 batches | 0 | 0 | 11 |
| Failed v3 batches | 0 | 0 | 3 |
| Skipped v3 actions | 0 | 0 | 1 |
| Maximum actions per batch | 0 | 0 | 5 |

## Binary provenance

- Baseline: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `fe3fa60f4362d50fdad2ac67896b1ef3261db6bd4ed44065b82335d18677acbb`.
- V2: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `fe3fa60f4362d50fdad2ac67896b1ef3261db6bd4ed44065b82335d18677acbb`.
- V3: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `fe3fa60f4362d50fdad2ac67896b1ef3261db6bd4ed44065b82335d18677acbb`.

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260904T032227Z`.
