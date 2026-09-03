# Codex CLI one-shot A/B results

Suite: `20260903T180550Z`

Model: `gpt-5.6-luna` (reasoning effort: `medium`)

State observation window: `k=3`

Design: one independent one-shot run per project and mode; black-box evaluation; at most 2 concurrent
CLI processes; 15 minute timeout per cell. Skills, skill search, Code Mode host, user config,
and network access for model-issued commands were disabled in both modes.

| Project | Baseline score | SKILL.state score | Baseline input tokens¹ | SKILL.state input tokens¹ | Savings | Samples B/S | Seconds B/S | Exit B / S |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 1/8 | 1/8 | 0 | 0 | 0.0% | 0/0 | 0.04/0.01 | 2 / 2 |
| csv-insights | 2/8 | 2/8 | 0 | 0 | 0.0% | 0/0 | 0.04/0.01 | 2 / 2 |
| mini-template | 1/8 | 1/8 | 0 | 0 | 0.0% | 0/0 | 0.04/0.01 | 2 / 2 |
| http-kv | 0/9 | 0/9 | 0 | 0 | 0.0% | 0/0 | 0.04/0.01 | 2 / 2 |
| dependency-planner | 1/7 | 1/7 | 0 | 0 | 0.0% | 0/0 | 0.04/0.01 | 2 / 2 |
| **Total** | **5/40** | **5/40** | **0** | **0** | **0.0%** | **0/0** | **0.19/0.06** | |

¹ Codex's provider-reported `input_tokens`; `cached_input_tokens` is a subset and is not added again.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input tokens | 0 | 0 |
| Cached input tokens | 0 | 0 |
| Output tokens | 0 | 0 |
| Reasoning tokens | 0 | 0 |
| Provider samples | 0 | 0 |
| Command executions | 0 | 0 |
| File-change events | 0 | 0 |
| CLI error events | 0 | 0 |
| State transitions | 0 | 0 |
| State transition errors | 0 | 0 |
| State comments | 0 | 0 |
| Finish transitions | 0 | 0 |
| Consecutive repeated actions | 0 | 0 |
| Maximum repeat streak | 0 | 0 |
| Maximum state bytes | 0 | 0 |

## Binary provenance

- Baseline: installed official CLI `codex-cli 0.145.0` at `<nda context deleted, size :33 chars>`.
- SKILL.state: research build `codex-cli 0.0.0` at `<nda context deleted, size :108 chars>`, based on
  upstream Codex commit `1d74c3ba1ee98be2025ab066dcc3fd654fe8a3b6`.

The release-labelled baseline and source-snapshot research build are not byte-identical, so this is an engineering A/B,
not a perfectly controlled patch-only comparison. The prompt, model, reasoning effort, sandbox, fixtures, evaluator, and
concurrency are held constant.

## Interpretation guardrails

- This is an exploratory `n=1` run per cell; model variance can dominate small differences.
- Short code-generation tasks test quality and crossover overhead, not the paper's asymptotic long-horizon claim.
- A token reduction is useful only at comparable evaluator quality. Timeouts and non-zero exits must be treated as failed
  cells, not token savings.
- Each cell contains `events.jsonl`, `stderr.log`, `summary.json`, and, when persistence succeeds, the raw
  `rollout.jsonl` with auditable state transitions.

Generated workspaces remain at the paths recorded in each summary under `/var/folders/0q/2rdtymtx2yvgjq38pr1pm2lc0000gn/T/codex-skill-state-one-shot/20260903T180550Z`.
