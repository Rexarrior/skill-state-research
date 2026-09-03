# Codex CLI one-shot A/B results

Suite: `20260903T205533Z`

Model: `gpt-5.6-sol` (reasoning effort: `medium`)

State observation window: `k=3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 2 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in both modes. Both CLIs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. The pristine
baseline retains upstream Code Mode; the state kernel forces direct tools to preserve one-patch/one-action atomicity.


| Project | Baseline score | SKILL.state score | Baseline input tokens¹ | SKILL.state input tokens¹ | Savings | Samples B/S | Seconds B/S | Exit B / S |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 8/8 | 327,713 | 440,776 | -34.5% | 11/25 | 232.39/351.2 | 0 / 0 |
| csv-insights | 8/8 | 8/8 | 1,137,581 | 145,766 | 87.2% | 22/8 | 374.08/214.1 | 0 / 0 |
| mini-template | 8/8 | 8/8 | 297,110 | 135,367 | 54.4% | 13/8 | 228.04/158.93 | 0 / 0 |
| http-kv | 9/9 | 9/9 | 1,024,613 | 558,734 | 45.5% | 30/31 | 498.81/553.29 | 0 / 0 |
| dependency-planner | 7/7 | 7/7 | 659,444 | 410,472 | 37.8% | 18/22 | 345.39/469.71 | 0 / 0 |
| **Total** | **40/40** | **40/40** | **3,446,461** | **1,691,115** | **50.9%** | **94/94** | **1,678.7/1,747.22** | |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input tokens | 3,446,461 | 1,691,115 |
| Cached input tokens | 3,228,800 | 939,776 |
| Output tokens | 71,019 | 73,180 |
| Reasoning tokens | 24,160 | 8,786 |
| Provider samples | 94 | 94 |
| Command executions | 72 | 70 |
| File-change events | 20 | 17 |
| CLI error events | 0 | 0 |
| State transitions | 0 | 94 |
| State transition errors | 0 | 2 |
| State comments | 0 | 94 |
| Finish transitions | 0 | 5 |
| Consecutive repeated actions | 0 | 0 |
| Maximum repeat streak | 0 | 1 |
| Maximum state bytes | 0 | 1,112 |

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
`/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260903T205533Z`.
