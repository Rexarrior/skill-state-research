# Codex CLI one-shot multimode results

Suite: `20260904T023020Z`

Model: `gpt-5.6-sol` (reasoning effort: `medium`)

Selected modes: `baseline`, `v2`, `v3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 1 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools. V2 preserves one-patch/one-action transitions;
v3 applies one patch and executes a non-empty, unbounded action array strictly sequentially.


| Project | Baseline score | Baseline input | Samples | Exit | V2 score | V2 input | Samples | Exit | V3 score | V3 input | Samples | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 542,483 | 16 | 0 | 8/8 | 117,544 | 7 | 0 | 8/8 | 134,518 | 7 | 0 |
| csv-insights | 8/8 | 288,899 | 10 | 0 | 8/8 | 205,259 | 12 | 0 | 8/8 | 120,998 | 7 | 0 |
| mini-template | 8/8 | 171,106 | 8 | 0 | 8/8 | 252,690 | 15 | 0 | 8/8 | 159,117 | 8 | 0 |
| http-kv | 9/9 | 248,868 | 10 | 0 | 9/9 | 178,568 | 10 | 0 | 9/9 | 238,936 | 13 | 0 |
| dependency-planner | 7/7 | 331,217 | 11 | 0 | 7/7 | 236,617 | 13 | 0 | 7/7 | 164,544 | 9 | 0 |
| **Total** | **40/40** | **1,582,573** | **55** | **—** | **40/40** | **990,678** | **57** | **—** | **40/40** | **818,113** | **44** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 990,678 | 37.4% |
| V3 | 818,113 | 48.3% |

## Aggregate counters

| Metric | Baseline | V2 | V3 |
|---|---:|---:|---:|
| Input tokens | 1,582,573 | 990,678 | 818,113 |
| Cached input tokens | 1,408,896 | 523,008 | 425,216 |
| Output tokens | 51,008 | 49,537 | 42,355 |
| Reasoning tokens | 16,121 | 7,141 | 6,245 |
| Provider samples | 55 | 57 | 44 |
| Command executions | 37 | 45 | 68 |
| File-change events | 13 | 7 | 6 |
| CLI error events | 0 | 0 | 0 |
| State transitions | 0 | 56 | 44 |
| State transition errors | 0 | 0 | 0 |
| State comments | 0 | 56 | 42 |
| Finish transitions | 0 | 4 | 5 |
| Consecutive repeated actions | 0 | 0 | 0 |
| Maximum repeat streak | 0 | 1 | 1 |
| Maximum state bytes | 0 | 1,062 | 1,614 |
| Actions inside v3 batches | 0 | 0 | 79 |
| Multi-action v3 batches | 0 | 0 | 16 |
| Failed v3 batches | 0 | 0 | 0 |
| Skipped v3 actions | 0 | 0 | 0 |
| Maximum actions per batch | 0 | 0 | 6 |

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260904T023020Z`.
