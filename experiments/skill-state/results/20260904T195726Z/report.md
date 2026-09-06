# One-shot multimode results

Suite: `20260904T195726Z`

Model: `openai-yandex-team/gpt-5.6-sol`

Selected modes: `baseline`, `v2`, `v3`, `paper`

Design: one independent run per project and mode; one user prompt per run. V3 applies one patch and executes each
non-empty, unbounded action array strictly sequentially; each array occupies one observation-window slot.

| Project | Baseline score | Baseline prompt | Turns | V2 score | V2 prompt | Turns | V3 score | V3 prompt | Turns | Paper score | Paper prompt | Turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 314,120 | 14 | 8/8 | 60,842 | 5 | 8/8 | 137,147 | 10 | 8/8 | 151,642 | 11 |
| csv-insights | 8/8 | 201,115 | 9 | 8/8 | 45,659 | 4 | 8/8 | 91,502 | 7 | 8/8 | 286,036 | 19 |
| mini-template | 8/8 | 265,184 | 12 | 8/8 | 76,027 | 6 | 8/8 | 91,460 | 7 | 8/8 | 75,867 | 6 |
| http-kv | 9/9 | 348,596 | 14 | 9/9 | 106,403 | 8 | 9/9 | 91,460 | 7 | 9/9 | 684,999 | 45 |
| dependency-planner | 7/7 | 206,897 | 10 | 7/7 | 121,546 | 9 | 7/7 | 76,262 | 6 | 7/7 | 568,684 | 38 |
| **Total** | **40/40** | **1,335,912** | **59** | **40/40** | **410,477** | **32** | **40/40** | **487,831** | **37** | **40/40** | **1,767,228** | **119** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Prompt-token change from baseline

| Mode | Prompt tokens | Reduction |
|---|---:|---:|
| V2 | 410,477 | 69.3% |
| V3 | 487,831 | 63.5% |
| Paper | 1,767,228 | -32.3% |

## Aggregate counters

| Metric | Baseline | V2 | V3 | Paper |
|---|---:|---:|---:|---:|
| Input | 177 | 3,904 | 4,514 | 14,518 |
| Cache read | 1,335,735 | 406,573 | 483,317 | 1,752,710 |
| Cache write | 144,768 | 152,804 | 186,572 | 200,726 |
| Output | 30,281 | 27,543 | 26,665 | 50,787 |
| Reasoning | 7,270 | 3,179 | 6,005 | 3,927 |
| Tool calls | 73 | 32 | 37 | 119 |
| SKILL.state calls | 0 | 32 | 37 | 119 |
| State-tool errors | 0 | 0 | 0 | 0 |
| State comments | 0 | 30 | 36 | 0 |
| Finish calls | 0 | 5 | 5 | 5 |
| Consecutive repeated actions | 0 | 0 | 0 | 15 |
| Maximum repeat streak | 0 | 1 | 1 | 7 |
| Maximum state bytes | 0 | 1,280 | 714 | 1,784 |
| Actions inside v3 batches | 0 | 0 | 52 | 0 |
| Multi-action v3 batches | 0 | 0 | 12 | 0 |
| Failed v3 batches | 0 | 0 | 3 | 0 |
| Skipped v3 actions | 0 | 0 | 1 | 0 |
| Maximum actions per batch | 0 | 0 | 4 | 0 |
| Provider-reported cost | 1.8 | 1.14 | 1.24 | 2.59 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260904T195726Z/`
and the workspace paths named in each summary.
