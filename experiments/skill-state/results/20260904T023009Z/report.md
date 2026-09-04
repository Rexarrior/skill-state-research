# One-shot multimode results

Suite: `20260904T023009Z`

Model: `openai-yandex-team/gpt-5.6-terra`

Selected modes: `baseline`, `v2`, `v3`

Design: one independent run per project and mode; one user prompt per run. V3 applies one patch and executes each
non-empty, unbounded action array strictly sequentially; each array occupies one observation-window slot.

| Project | Baseline score | Baseline prompt | Turns | V2 score | V2 prompt | Turns | V3 score | V3 prompt | Turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 298,852 | 14 | 8/8 | 91,208 | 7 | 8/8 | 137,210 | 10 |
| csv-insights | 8/8 | 209,414 | 10 | 8/8 | 45,668 | 4 | 8/8 | 167,641 | 12 |
| mini-template | 7/8 | 295,009 | 13 | 8/8 | 121,578 | 9 | 7/8 | 61,034 | 5 |
| http-kv | 8/9 | 279,100 | 12 | 9/9 | 45,668 | 4 | 9/9 | 61,026 | 5 |
| dependency-planner | 7/7 | 318,831 | 14 | 7/7 | 76,017 | 6 | 7/7 | 228,632 | 16 |
| **Total** | **38/40** | **1,401,206** | **63** | **40/40** | **380,139** | **30** | **39/40** | **655,543** | **48** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Prompt-token change from baseline

| Mode | Prompt tokens | Reduction |
|---|---:|---:|
| V2 | 380,139 | 72.9% |
| V3 | 655,543 | 53.2% |

## Aggregate counters

| Metric | Baseline | V2 | V3 |
|---|---:|---:|---:|
| Input | 189 | 3,660 | 5,856 |
| Cache read | 1,401,017 | 376,479 | 649,687 |
| Cache write | 141,409 | 145,528 | 231,201 |
| Output | 28,822 | 19,955 | 29,918 |
| Reasoning | 5,598 | 1,523 | 3,292 |
| Tool calls | 76 | 30 | 48 |
| SKILL.state calls | 0 | 30 | 48 |
| State-tool errors | 0 | 0 | 0 |
| State comments | 0 | 27 | 48 |
| Finish calls | 0 | 5 | 5 |
| Consecutive repeated actions | 0 | 0 | 0 |
| Maximum repeat streak | 0 | 1 | 1 |
| Maximum state bytes | 0 | 1,472 | 951 |
| Actions inside v3 batches | 0 | 0 | 81 |
| Multi-action v3 batches | 0 | 0 | 22 |
| Failed v3 batches | 0 | 0 | 0 |
| Skipped v3 actions | 0 | 0 | 0 |
| Maximum actions per batch | 0 | 0 | 7 |
| Provider-reported cost | 0.69 | 0.34 | 0.54 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260904T023009Z/`
and the workspace paths named in each summary.
