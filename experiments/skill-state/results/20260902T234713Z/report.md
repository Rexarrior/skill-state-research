# One-shot A/B results

Suite: `20260902T234713Z`  
Model: `openai-yandex-team/gpt-5.6-terra`  
Design: one independent run per project and mode; one user prompt per run; sequential execution.

| Project | Baseline score | SKILL.state score | Baseline prompt tokens¹ | SKILL.state prompt tokens¹ | Savings | Turns B/S | Seconds B/S |
|---|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 8/8 | 276,892 | 547,288 | -97.7% | 13/37 | 71.36/148.03 |
| csv-insights | 8/8 | 7/8 | 233,106 | 1,255,108 | -438.4% | 11/80 | 74.24/325.81 |
| mini-template | 7/8 | 7/8 | 282,154 | 121,570 | 56.9% | 13/9 | 75.6/58.48 |
| http-kv | 9/9 | 9/9 | 219,328 | 213,606 | 2.6% | 10/15 | 103.96/100.19 |
| dependency-planner | 7/7 | 7/7 | 239,672 | 409,874 | -71.0% | 11/28 | 84.9/197.06 |
| **Total** | **39/40** | **38/40** | **1,251,152** | **2,547,446** | **-103.6%** | **58/169** | **410.05/829.57** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input | 174 | 20,618 |
| Cache read | 1,250,978 | 2,526,828 |
| Cache write | 135,407 | 222,614 |
| Output | 25,754 | 67,948 |
| Reasoning | 4,914 | 3,281 |
| Tool calls | 68 | 169 |
| SKILL.state calls | 0 | 169 |
| State-tool errors | 0 | 0 |
| Maximum state bytes | 0 | 2,483 |
| Provider-reported cost | 0.62 | 1.4 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260902T234713Z/`
and the workspace paths named in each summary.
