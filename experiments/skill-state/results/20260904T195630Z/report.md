# One-shot multimode results

Suite: `20260904T195630Z`

Model: `openai-yandex-team/gpt-5.6-terra`

Selected modes: `baseline`, `v2`, `v3`, `paper`

Design: one independent run per project and mode; one user prompt per run. V3 applies one patch and executes each
non-empty, unbounded action array strictly sequentially; each array occupies one observation-window slot.

| Project | Baseline score | Baseline prompt | Turns | V2 score | V2 prompt | Turns | V3 score | V3 prompt | Turns | Paper score | Paper prompt | Turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 1/8 | 0 | 0 | 1/8 | 0 | 0 | 1/8 | 0 | 0 | 1/8 | 0 | 0 |
| csv-insights | 2/8 | 0 | 0 | 2/8 | 0 | 0 | 2/8 | 0 | 0 | 2/8 | 0 | 0 |
| mini-template | 1/8 | 0 | 0 | 1/8 | 0 | 0 | 1/8 | 0 | 0 | 1/8 | 0 | 0 |
| http-kv | 0/9 | 0 | 0 | 0/9 | 0 | 0 | 0/9 | 0 | 0 | 0/9 | 0 | 0 |
| dependency-planner | 1/7 | 0 | 0 | 1/7 | 0 | 0 | 1/7 | 0 | 0 | 1/7 | 0 | 0 |
| **Total** | **5/40** | **0** | **0** | **5/40** | **0** | **0** | **5/40** | **0** | **0** | **5/40** | **0** | **0** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Prompt-token change from baseline

| Mode | Prompt tokens | Reduction |
|---|---:|---:|
| V2 | 0 | 0.0% |
| V3 | 0 | 0.0% |
| Paper | 0 | 0.0% |

## Aggregate counters

| Metric | Baseline | V2 | V3 | Paper |
|---|---:|---:|---:|---:|
| Input | 0 | 0 | 0 | 0 |
| Cache read | 0 | 0 | 0 | 0 |
| Cache write | 0 | 0 | 0 | 0 |
| Output | 0 | 0 | 0 | 0 |
| Reasoning | 0 | 0 | 0 | 0 |
| Tool calls | 0 | 0 | 0 | 0 |
| SKILL.state calls | 0 | 0 | 0 | 0 |
| State-tool errors | 0 | 0 | 0 | 0 |
| State comments | 0 | 0 | 0 | 0 |
| Finish calls | 0 | 0 | 0 | 0 |
| Consecutive repeated actions | 0 | 0 | 0 | 0 |
| Maximum repeat streak | 0 | 0 | 0 | 0 |
| Maximum state bytes | 0 | 0 | 0 | 0 |
| Actions inside v3 batches | 0 | 0 | 0 | 0 |
| Multi-action v3 batches | 0 | 0 | 0 | 0 |
| Failed v3 batches | 0 | 0 | 0 | 0 |
| Skipped v3 actions | 0 | 0 | 0 | 0 |
| Maximum actions per batch | 0 | 0 | 0 | 0 |
| Provider-reported cost | 0 | 0 | 0 | 0 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260904T195630Z/`
and the workspace paths named in each summary.
