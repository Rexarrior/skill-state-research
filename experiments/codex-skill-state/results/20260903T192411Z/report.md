# Codex CLI one-shot A/B results

Suite: `20260903T192411Z`

Model: `gpt-5.6-luna` (reasoning effort: `medium`)

State observation window: `k=3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 2 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in both modes. Both CLIs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. The pristine
baseline retains upstream Code Mode; the state kernel forces direct tools to preserve one-patch/one-action atomicity.

Baseline cells were reused without rerunning from suite `20260903T181508Z`; state cells belong to this suite.


| Project | Baseline score | SKILL.state score | Baseline input tokens¹ | SKILL.state input tokens¹ | Savings | Samples B/S | Seconds B/S | Exit B / S |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 7/8 | 154,372 | 1,184,713 | -667.4% | 8/69 | 149.22/900.02 | 0 / timeout |
| csv-insights | 8/8 | 8/8 | 278,423 | 520,366 | -86.9% | 13/32 | 190.69/415.42 | 0 / 0 |
| mini-template | 8/8 | 8/8 | 276,269 | 1,404,911 | -408.5% | 14/86 | 170.53/869.23 | 0 / 0 |
| http-kv | 9/9 | 9/9 | 369,264 | 1,072,823 | -190.5% | 16/63 | 237.26/900.02 | 0 / timeout |
| dependency-planner | 7/7 | 7/7 | 187,463 | 299,950 | -60.0% | 9/18 | 175.79/311.7 | 0 / 0 |
| **Total** | **40/40** | **39/40** | **1,265,791** | **4,482,763** | **-254.1%** | **60/268** | **923.48/3,396.38** | |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input tokens | 1,265,791 | 4,482,763 |
| Cached input tokens | 1,140,736 | 2,920,704 |
| Output tokens | 39,034 | 126,509 |
| Reasoning tokens | 9,073 | 15,993 |
| Provider samples | 60 | 268 |
| Command executions | 36 | 230 |
| File-change events | 23 | 10 |
| CLI error events | 0 | 0 |
| State transitions | 0 | 268 |
| State transition errors | 0 | 23 |
| State comments | 0 | 110 |
| Finish transitions | 0 | 3 |
| Consecutive repeated actions | 0 | 5 |
| Maximum repeat streak | 0 | 2 |
| Maximum state bytes | 0 | 790 |

## Binary provenance

- Baseline: `codex-cli 0.0.0` at `/private/tmp/codex-baseline-1d74c3b-bin/codex`, SHA-256
  `3a385dcfc565ebd05f2421ee696f2d64c1eec896e4b633e7c07b3b39e13f9fb9`. Source: pristine upstream 1d74c3ba1ee98be2025ab066dcc3fd654fe8a3b6.
- SKILL.state: research build `codex-cli 0.0.0` at `<nda context deleted, size :108 chars>`, based on
  upstream Codex commit `1d74c3ba1ee98be2025ab066dcc3fd654fe8a3b6`, SHA-256
  `b8580c16a8a88d1690d57abd9e5c0858a3a3145a213514f024e50fcb7ab180b0`.

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260903T192411Z`.
