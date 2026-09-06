# Codex CLI one-shot multimode results

Suite: `20260905T232335Z`

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
| taskboard-cli | 8/8 | 130,602 | 8 | 0 | 8/8 | 371,211 | 18 | 0 |
| csv-insights | 8/8 | 236,871 | 13 | 0 | 8/8 | 170,395 | 9 | 0 |
| mini-template | 8/8 | 166,771 | 10 | 0 | 8/8 | 278,128 | 15 | 0 |
| http-kv | 9/9 | 177,074 | 10 | 0 | 9/9 | 192,190 | 10 | 0 |
| dependency-planner | 7/7 | 162,664 | 9 | 0 | 7/7 | 230,105 | 13 | 0 |
| **Total** | **40/40** | **873,982** | **50** | **—** | **40/40** | **1,242,029** | **65** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| V2 | 873,982 | 0.0% |
| V3 | 1,242,029 | 0.0% |

## Aggregate counters

| Metric | V2 | V3 |
|---|---:|---:|
| Input tokens | 873,982 | 1,242,029 |
| Cached input tokens | 486,144 | 672,896 |
| Output tokens | 46,622 | 57,277 |
| Reasoning tokens | 5,639 | 10,243 |
| Provider samples | 50 | 65 |
| Command executions | 39 | 94 |
| File-change events | 6 | 9 |
| CLI error events | 0 | 0 |
| State transitions | 50 | 65 |
| State transition errors | 14 | 25 |
| State comments | 49 | 63 |
| Finish transitions | 5 | 5 |
| Consecutive repeated actions | 0 | 2 |
| Maximum repeat streak | 1 | 2 |
| Maximum state bytes | 1,090 | 1,183 |
| Actions inside v3 batches | 0 | 120 |
| Multi-action v3 batches | 0 | 29 |
| Failed v3 batches | 0 | 25 |
| Skipped v3 actions | 0 | 11 |
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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260905T232335Z`.
