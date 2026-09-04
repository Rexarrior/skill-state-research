# One-shot multimode results

Suite: `20260904T015621Z`

Model: `openai-yandex-team/gpt-5.6-sol`

Selected modes: `baseline`, `v2`, `v3`

Design: one independent run per project and mode; one user prompt per run. V3 applies one patch and executes each
non-empty, unbounded action array strictly sequentially; each array occupies one observation-window slot.

| Project | Baseline score | Baseline prompt | Turns | V2 score | V2 prompt | Turns | V3 score | V3 prompt | Turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 213,408 | 10 | 8/8 | 60,842 | 5 | 8/8 | 167,608 | 12 |
| csv-insights | 8/8 | 185,339 | 9 | 8/8 | 60,850 | 5 | 8/8 | 76,267 | 6 |
| mini-template | 8/8 | 324,082 | 13 | 8/8 | 167,157 | 12 | 8/8 | 167,674 | 12 |
| http-kv | 9/9 | 502,117 | 19 | 9/9 | 167,102 | 12 | 9/9 | 91,496 | 7 |
| dependency-planner | 7/7 | 290,953 | 13 | 7/7 | 76,052 | 6 | 7/7 | 106,718 | 8 |
| **Total** | **40/40** | **1,515,899** | **64** | **40/40** | **532,003** | **40** | **40/40** | **609,763** | **45** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Prompt-token change from baseline

| Mode | Prompt tokens | Reduction |
|---|---:|---:|
| V2 | 532,003 | 64.9% |
| V3 | 609,763 | 59.8% |

## Aggregate counters

| Metric | Baseline | V2 | V3 |
|---|---:|---:|---:|
| Input | 192 | 4,880 | 5,490 |
| Cache read | 1,515,707 | 527,123 | 604,273 |
| Cache write | 152,355 | 170,762 | 228,351 |
| Output | 29,951 | 27,275 | 29,463 |
| Reasoning | 9,287 | 3,900 | 5,417 |
| Tool calls | 92 | 40 | 45 |
| SKILL.state calls | 0 | 40 | 45 |
| State-tool errors | 0 | 0 | 0 |
| State comments | 0 | 35 | 39 |
| Finish calls | 0 | 5 | 5 |
| Consecutive repeated actions | 0 | 0 | 0 |
| Maximum repeat streak | 0 | 1 | 1 |
| Maximum state bytes | 0 | 1,585 | 749 |
| Actions inside v3 batches | 0 | 0 | 78 |
| Multi-action v3 batches | 0 | 0 | 19 |
| Failed v3 batches | 0 | 0 | 1 |
| Skipped v3 actions | 0 | 0 | 0 |
| Maximum actions per batch | 0 | 0 | 5 |
| Provider-reported cost | 1.94 | 1.22 | 1.38 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260904T015621Z/`
and the workspace paths named in each summary.
