# Codex CLI one-shot multimode results

Suite: `20260904T114822Z`

Model: `gpt-5.6-terra` (reasoning effort: `medium`)

Selected modes: `baseline`, `v2`, `v3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 1 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools. V2 preserves one-patch/one-action transitions;
v3 applies one patch and executes a non-empty, unbounded action array strictly sequentially.

Valid cells were reused without rerunning from suite `20260904T032227Z`; only failed/timeout cells belong to this retry suite. Each summary retains its original suite and workspace provenance.


| Project | Baseline score | Baseline input | Samples | Exit | V2 score | V2 input | Samples | Exit | V3 score | V3 input | Samples | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 283,150 | 9 | 0 | 8/8 | 278,590 | 16 | 0 | 8/8 | 604,395 | 32 | 0 |
| csv-insights | 8/8 | 626,790 | 17 | 0 | 8/8 | 172,743 | 10 | 0 | 8/8 | 521,819 | 29 | 0 |
| mini-template | 8/8 | 193,355 | 7 | 0 | 8/8 | 164,794 | 10 | 0 | 7/8 | 295,916 | 17 | 0 |
| http-kv | 9/9 | 662,755 | 19 | 0 | 9/9 | 329,474 | 19 | 0 | 9/9 | 160,066 | 9 | 0 |
| dependency-planner | 7/7 | 141,700 | 7 | 0 | 7/7 | 226,398 | 13 | 0 | 7/7 | 285,002 | 15 | 0 |
| **Total** | **40/40** | **1,907,750** | **59** | **—** | **40/40** | **1,171,999** | **68** | **—** | **39/40** | **1,867,198** | **102** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 1,171,999 | 38.6% |
| V3 | 1,867,198 | 2.1% |

## Aggregate counters

| Metric | Baseline | V2 | V3 |
|---|---:|---:|---:|
| Input tokens | 1,907,750 | 1,171,999 | 1,867,198 |
| Cached input tokens | 1,722,624 | 666,112 | 1,318,144 |
| Output tokens | 42,546 | 34,578 | 64,862 |
| Reasoning tokens | 10,550 | 4,604 | 10,730 |
| Provider samples | 59 | 68 | 102 |
| Command executions | 37 | 48 | 92 |
| File-change events | 19 | 13 | 17 |
| CLI error events | 0 | 0 | 0 |
| State transitions | 0 | 68 | 102 |
| State transition errors | 0 | 2 | 3 |
| State comments | 0 | 68 | 102 |
| Finish transitions | 0 | 5 | 5 |
| Consecutive repeated actions | 0 | 0 | 0 |
| Maximum repeat streak | 0 | 1 | 1 |
| Maximum state bytes | 0 | 812 | 952 |
| Actions inside v3 batches | 0 | 0 | 118 |
| Multi-action v3 batches | 0 | 0 | 13 |
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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260904T114822Z`.
