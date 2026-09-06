# Codex CLI one-shot multimode results

Suite: `20260904T223606Z`

Model: `gpt-5.6-terra` (reasoning effort: `medium`)

Selected modes: `baseline`, `v2`, `v3`, `paper`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 1 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools. V2 preserves one-patch/one-action transitions;
v3 applies one patch and executes a non-empty, unbounded action array strictly sequentially.


| Project | Baseline score | Baseline input | Samples | Exit | V2 score | V2 input | Samples | Exit | V3 score | V3 input | Samples | Exit | Paper score | Paper input | Samples | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 303,167 | 11 | 0 | 8/8 | 191,536 | 11 | 0 | 8/8 | 273,616 | 15 | 0 | 3/8 | 1,537,719 | 98 | timeout |
| csv-insights | 7/8 | 352,044 | 12 | 0 | 8/8 | 176,018 | 10 | 0 | 8/8 | 154,446 | 9 | 0 | 8/8 | 1,522,817 | 98 | timeout |
| mini-template | 8/8 | 142,200 | 7 | 0 | 7/8 | 116,018 | 7 | 0 | 7/8 | 227,642 | 13 | 0 | 7/8 | 860,535 | 56 | 0 |
| http-kv | 9/9 | 484,973 | 14 | 0 | 9/9 | 182,936 | 11 | 0 | 9/9 | 250,950 | 14 | 0 | 0/9 | 1,633,487 | 106 | timeout |
| dependency-planner | 7/7 | 244,413 | 12 | 0 | 7/7 | 333,542 | 19 | 0 | 7/7 | 185,830 | 11 | 0 | 7/7 | 1,189,780 | 77 | 0 |
| **Total** | **39/40** | **1,526,797** | **56** | **—** | **39/40** | **1,000,050** | **58** | **—** | **39/40** | **1,092,484** | **62** | **—** | **25/40** | **6,744,338** | **435** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 1,000,050 | 34.5% |
| V3 | 1,092,484 | 28.4% |
| Paper | 6,744,338 | -341.7% |

## Aggregate counters

| Metric | Baseline | V2 | V3 | Paper |
|---|---:|---:|---:|---:|
| Input tokens | 1,526,797 | 1,000,050 | 1,092,484 | 6,744,338 |
| Cached input tokens | 1,388,544 | 557,056 | 762,112 | 6,082,816 |
| Output tokens | 38,673 | 34,160 | 41,145 | 136,528 |
| Reasoning tokens | 9,635 | 4,900 | 5,578 | 22,199 |
| Provider samples | 56 | 58 | 62 | 435 |
| Command executions | 39 | 41 | 56 | 429 |
| File-change events | 12 | 11 | 6 | 4 |
| CLI error events | 0 | 0 | 0 | 0 |
| State transitions | 0 | 58 | 62 | 435 |
| State transition errors | 0 | 21 | 21 | 269 |
| State comments | 0 | 57 | 62 | 0 |
| Finish transitions | 0 | 5 | 5 | 2 |
| Consecutive repeated actions | 0 | 0 | 1 | 15 |
| Maximum repeat streak | 0 | 1 | 2 | 3 |
| Maximum state bytes | 0 | 722 | 873 | 1,304 |
| Actions inside v3 batches | 0 | 0 | 71 | 0 |
| Multi-action v3 batches | 0 | 0 | 6 | 0 |
| Failed v3 batches | 0 | 0 | 21 | 0 |
| Skipped v3 actions | 0 | 0 | 2 | 0 |
| Maximum actions per batch | 0 | 0 | 3 | 0 |

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260904T223606Z`.
