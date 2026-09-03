# Codex CLI one-shot A/B results

Suite: `20260903T181508Z`

Model: `gpt-5.6-luna` (reasoning effort: `medium`)

State observation window: `k=3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 2 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, and user config were
disabled in both modes. Both CLIs use `--approve-for-me`: model commands remain in the `workspace-write` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. The pristine
baseline retains upstream Code Mode; the state kernel forces direct tools to preserve one-patch/one-action atomicity.

| Project | Baseline score | SKILL.state score | Baseline input tokens¹ | SKILL.state input tokens¹ | Savings | Samples B/S | Seconds B/S | Exit B / S |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 0/8 | 154,372 | 547,326 | -254.6% | 8/38 | 149.22/900.01 | 0 / timeout |
| csv-insights | 8/8 | 1/8 | 278,423 | 563,517 | -102.4% | 13/40 | 190.69/900.02 | 0 / timeout |
| mini-template | 8/8 | 1/8 | 276,269 | 469,814 | -70.1% | 14/33 | 170.53/900.02 | 0 / timeout |
| http-kv | 9/9 | 0/9 | 369,264 | 968,539 | -162.3% | 16/63 | 237.26/900.02 | 0 / timeout |
| dependency-planner | 7/7 | 0/7 | 187,463 | 439,115 | -134.2% | 9/31 | 175.79/900.02 | 0 / timeout |
| **Total** | **40/40** | **2/40** | **1,265,791** | **2,988,311** | **-136.1%** | **60/205** | **923.48/4,500.08** | |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input tokens | 1,265,791 | 2,988,311 |
| Cached input tokens | 1,140,736 | 2,586,880 |
| Output tokens | 39,034 | 203,501 |
| Reasoning tokens | 9,073 | 21,021 |
| Provider samples | 60 | 205 |
| Command executions | 36 | 111 |
| File-change events | 23 | 3 |
| CLI error events | 0 | 0 |
| State transitions | 0 | 205 |
| State transition errors | 0 | 91 |
| State comments | 0 | 123 |
| Finish transitions | 0 | 0 |
| Consecutive repeated actions | 0 | 55 |
| Maximum repeat streak | 0 | 5 |
| Maximum state bytes | 0 | 521 |

## Binary provenance

- Baseline: `codex-cli 0.0.0` at `/private/tmp/codex-baseline-1d74c3b-bin/codex`, SHA-256
  `3a385dcfc565ebd05f2421ee696f2d64c1eec896e4b633e7c07b3b39e13f9fb9`. Source: pristine upstream 1d74c3ba1ee98be2025ab066dcc3fd654fe8a3b6.
- SKILL.state: research build `codex-cli 0.0.0` at `<nda context deleted, size :108 chars>`, based on
  upstream Codex commit `1d74c3ba1ee98be2025ab066dcc3fd654fe8a3b6`, SHA-256
  `9dd340af1a3053bb5498c8f0ecf6e3768603a32f0c6a0e82bdca3b4f731dd8de`.

The prompt, model, reasoning effort, sandbox, fixtures, evaluator, and concurrency are held constant. Binary hashes and
source provenance are recorded so a suite can be rejected if the baseline is not the intended pristine revision.

## Interpretation guardrails

- This is an exploratory `n=1` run per cell; model variance can dominate small differences.
- Short code-generation tasks test quality and crossover overhead, not the paper's asymptotic long-horizon claim.
- A token reduction is useful only at comparable evaluator quality. Timeouts and non-zero exits must be treated as failed
  cells, not token savings.
- Each cell contains `events.jsonl`, `stderr.log`, `summary.json`, and, when persistence succeeds, the raw
  `rollout.jsonl` with auditable state transitions.

Generated workspaces remain at the paths recorded in each summary under `/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260903T181508Z`.
