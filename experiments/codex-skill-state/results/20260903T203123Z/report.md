# Codex CLI one-shot A/B results

Suite: `20260903T203123Z`

Model: `gpt-5.6-terra` (reasoning effort: `medium`)

State observation window: `k=3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 2 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in both modes. Both CLIs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. The pristine
baseline retains upstream Code Mode; the state kernel forces direct tools to preserve one-patch/one-action atomicity.


| Project | Baseline score | SKILL.state score | Baseline input tokens¹ | SKILL.state input tokens¹ | Savings | Samples B/S | Seconds B/S | Exit B / S |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 8/8 | 165,036 | 306,880 | -85.9% | 8/17 | 137.94/300.55 | 0 / 0 |
| csv-insights | 7/8 | 8/8 | 304,061 | 207,433 | 31.8% | 11/12 | 187.81/163.5 | 0 / 0 |
| mini-template | 8/8 | 7/8 | 515,362 | 135,471 | 73.7% | 17/8 | 225.85/133.08 | 0 / 0 |
| http-kv | 8/9 | 9/9 | 331,653 | 283,506 | 14.5% | 13/16 | 225.59/206.96 | 0 / 0 |
| dependency-planner | 7/7 | 7/7 | 272,373 | 310,508 | -14.0% | 12/18 | 180.42/227.43 | 0 / 0 |
| **Total** | **38/40** | **39/40** | **1,588,485** | **1,243,798** | **21.7%** | **61/71** | **957.62/1,031.52** | |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input tokens | 1,588,485 | 1,243,798 |
| Cached input tokens | 1,424,128 | 672,256 |
| Output tokens | 40,438 | 40,261 |
| Reasoning tokens | 11,016 | 5,237 |
| Provider samples | 61 | 71 |
| Command executions | 39 | 51 |
| File-change events | 17 | 10 |
| CLI error events | 0 | 0 |
| State transitions | 0 | 71 |
| State transition errors | 0 | 5 |
| State comments | 0 | 69 |
| Finish transitions | 0 | 5 |
| Consecutive repeated actions | 0 | 0 |
| Maximum repeat streak | 0 | 1 |
| Maximum state bytes | 0 | 683 |

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260903T203123Z`.
