# One-shot A/B results

Suite: `20260902T234155Z`  
Model: `openai-yandex-team/gpt-5.6-terra`  
Design: one independent run per project and mode; one user prompt per run; sequential execution.

| Project | Baseline score | SKILL.state score | Baseline prompt tokens¹ | SKILL.state prompt tokens¹ | Savings | Turns B/S | Seconds B/S |
|---|---:|---:|---:|---:|---:|---:|---:|
| http-kv | 9/9 | 9/9 | 224,849 | 106,354 | 52.7% | 10/8 | 94.65/62.49 |
| **Total** | **9/9** | **9/9** | **224,849** | **106,354** | **52.7%** | **10/8** | **94.65/62.49** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input | 30 | 976 |
| Cache read | 224,819 | 105,378 |
| Cache write | 29,416 | 25,671 |
| Output | 6,313 | 4,908 |
| Reasoning | 2,012 | 98 |
| Tool calls | 12 | 8 |
| SKILL.state calls | 0 | 8 |
| State-tool errors | 0 | 0 |
| Maximum state bytes | 0 | 1,486 |
| Provider-reported cost | 0.14 | 0.08 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260902T234155Z/`
and the workspace paths named in each summary.
