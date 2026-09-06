# Codex CLI one-shot multimode results

Suite: `20260906T020613Z`

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
| taskboard-cli | 8/8 | 303,282 | 11 | 0 | 8/8 | 252,914 | 16 | 0 |
| csv-insights | 8/8 | 490,168 | 15 | 0 | 8/8 | 1,193,821 | 73 | timeout |
| mini-template | 8/8 | 242,911 | 11 | 0 | 8/8 | 138,819 | 9 | 0 |
| http-kv | 9/9 | 224,570 | 9 | 0 | 9/9 | 1,059,279 | 65 | timeout |
| dependency-planner | 7/7 | 255,530 | 11 | 0 | 7/7 | 348,088 | 22 | 0 |
| **Total** | **40/40** | **1,516,461** | **57** | **—** | **40/40** | **2,992,921** | **185** | **—** |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
| Paper | 2,992,921 | -97.4% |

## Aggregate counters

| Metric | Baseline | Paper |
|---|---:|---:|
| Input tokens | 1,516,461 | 2,992,921 |
| Cached input tokens | 1,368,064 | 1,896,960 |
| Output tokens | 54,993 | 117,912 |
| Reasoning tokens | 16,282 | 13,960 |
| Provider samples | 57 | 185 |
| Command executions | 44 | 175 |
| File-change events | 14 | 7 |
| CLI error events | 0 | 0 |
| State transitions | 0 | 185 |
| State transition errors | 0 | 20 |
| State comments | 0 | 0 |
| Finish transitions | 0 | 3 |
| Consecutive repeated actions | 0 | 2 |
| Maximum repeat streak | 0 | 2 |
| Maximum state bytes | 0 | 2,163 |
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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260906T020613Z`.
