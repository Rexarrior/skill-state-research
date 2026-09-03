# One-shot A/B results

Suite: `20260903T124451Z`  
Model: `openai-yandex-team/gpt-5.6-terra`  
Observation window: `k=3`
Design: one independent run per project and mode; one user prompt per run; sequential execution.

| Project | Baseline score | SKILL.state score | Baseline prompt tokens¹ | SKILL.state prompt tokens¹ | Savings | Turns B/S | Seconds B/S |
|---|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 7/8 | 8/8 | 202,855 | 91,346 | 55.0% | 10/7 | 85.46/68.42 |
| csv-insights | 7/8 | 8/8 | 182,809 | 45,728 | 75.0% | 9/4 | 98.86/38.17 |
| mini-template | 7/8 | 7/8 | 208,103 | 91,334 | 56.1% | 11/7 | 609.5/69.55 |
| http-kv | 9/9 | 9/9 | 219,246 | 45,740 | 79.1% | 10/4 | 99.08/53.17 |
| dependency-planner | 7/7 | 7/7 | 250,801 | 152,162 | 39.3% | 12/11 | 110.45/94.56 |
| **Total** | **37/40** | **39/40** | **1,063,814** | **426,310** | **59.9%** | **52/33** | **1,003.35/323.87** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input | 156 | 4,026 |
| Cache read | 1,063,658 | 422,284 |
| Cache write | 156,799 | 149,781 |
| Output | 26,335 | 20,331 |
| Reasoning | 5,819 | 1,141 |
| Tool calls | 64 | 33 |
| SKILL.state calls | 0 | 33 |
| State-tool errors | 0 | 0 |
| State comments | 0 | 33 |
| Finish calls | 0 | 5 |
| Consecutive repeated actions | 0 | 0 |
| Maximum repeat streak | 0 | 1 |
| Maximum state bytes | 0 | 1,559 |
| Provider-reported cost | 0.6 | 0.35 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260903T124451Z/`
and the workspace paths named in each summary.
