# Codex CLI one-shot multimode results

Suite: `20260906T020250Z`

Model: `gpt-5.6-sol` (reasoning effort: `medium`)

Selected modes: `baseline`, `paper`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 1 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools. V2 preserves one-patch/one-action transitions;
v3 applies one patch and executes a non-empty, unbounded action array strictly sequentially.


| Project | Baseline score | Baseline input | Samples | Exit | Paper score | Paper input | Samples | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 7/8 | 177,242 | 8 | 0 | 8/8 | 1,449,532 | 88 | timeout |
| csv-insights | 8/8 | 272,487 | 11 | 0 | 8/8 | 1,608,030 | 99 | timeout |
| mini-template | 8/8 | 342,137 | 14 | 0 | 8/8 | 972,031 | 62 | timeout |
| http-kv | 9/9 | 546,965 | 14 | 0 | 9/9 | 1,372,821 | 84 | timeout |
| dependency-planner | 7/7 | 675,458 | 17 | 0 | 6/7 | 1,435,250 | 87 | timeout |
| **Total** | **39/40** | **2,014,289** | **64** | **—** | **39/40** | **6,837,664** | **420** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| Paper | 6,837,664 | -239.5% |

## Aggregate counters

| Metric | Baseline | Paper |
|---|---:|---:|
| Input tokens | 2,014,289 | 6,837,664 |
| Cached input tokens | 1,844,864 | 4,797,696 |
| Output tokens | 61,572 | 189,471 |
| Reasoning tokens | 17,240 | 20,081 |
| Provider samples | 64 | 420 |
| Command executions | 51 | 415 |
| File-change events | 18 | 5 |
| CLI error events | 0 | 0 |
| State transitions | 0 | 420 |
| State transition errors | 0 | 82 |
| State comments | 0 | 0 |
| Finish transitions | 0 | 0 |
| Consecutive repeated actions | 0 | 39 |
| Maximum repeat streak | 0 | 6 |
| Maximum state bytes | 0 | 2,182 |
| Actions inside v3 batches | 0 | 0 |
| Multi-action v3 batches | 0 | 0 |
| Failed v3 batches | 0 | 0 |
| Skipped v3 actions | 0 | 0 |
| Maximum actions per batch | 0 | 0 |

## Binary provenance

- Baseline: `codex-cli 0.0.0` at `<nda context deleted, size :99 chars>`, SHA-256 `24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc`.
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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260906T020250Z`.
