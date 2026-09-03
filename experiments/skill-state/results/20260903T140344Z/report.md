# One-shot A/B results

Suite: `20260903T140344Z`  
Model: `openrouter-yandex-team/z-ai/glm-5.2`  
Observation window: `k=3`
Design: one independent run per project and mode; one user prompt per run; sequential execution.

| Project | Baseline score | SKILL.state score | Baseline prompt tokens¹ | SKILL.state prompt tokens¹ | Savings | Turns B/S | Seconds B/S |
|---|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 8/8 | 1,725,272 | 491,769 | 71.5% | 43/22 | 456.75/224.33 |
| csv-insights | 8/8 | 6/8 | 150,806 | 1,006,456 | -567.4% | 6/44 | 77.4/900.04 |
| mini-template | 8/8 | 7/8 | 410,096 | 310,648 | 24.2% | 14/14 | 164.79/900.03 |
| http-kv | 8/9 | 9/9 | 520,761 | 270,251 | 48.1% | 17/12 | 224.18/208.35 |
| dependency-planner | 7/7 | 1/7 | 555,552 | 59,726 | 89.2% | 16/3 | 224.12/900.03 |
| **Total** | **39/40** | **31/40** | **3,362,487** | **2,138,850** | **36.4%** | **96/95** | **1,147.23/3,132.77** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input | 440,322 | 356,206 |
| Cache read | 2,922,165 | 1,782,644 |
| Cache write | 0 | 0 |
| Output | 41,287 | 50,709 |
| Reasoning | 19,757 | 124,761 |
| Tool calls | 94 | 95 |
| SKILL.state calls | 0 | 95 |
| State-tool errors | 0 | 14 |
| State comments | 0 | 63 |
| Finish calls | 0 | 2 |
| Consecutive repeated actions | 0 | 0 |
| Maximum repeat streak | 0 | 1 |
| Maximum state bytes | 0 | 2,118 |
| Provider-reported cost | 1.18 | 1.22 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260903T140344Z/`
and the workspace paths named in each summary.
