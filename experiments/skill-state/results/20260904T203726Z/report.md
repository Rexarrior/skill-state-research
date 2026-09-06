# One-shot multimode results

Suite: `20260904T203726Z`

Model: `openai-yandex-team/gpt-5.6-terra`

Selected modes: `baseline`, `v2`, `v3`, `paper`

Design: one independent run per project and mode; one user prompt per run. V3 applies one patch and executes each
non-empty, unbounded action array strictly sequentially; each array occupies one observation-window slot.

| Project | Baseline score | Baseline prompt | Turns | V2 score | V2 prompt | Turns | V3 score | V3 prompt | Turns | Paper score | Paper prompt | Turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 226,522 | 12 | 8/8 | 455,582 | 31 | 8/8 | 198,099 | 14 | 8/8 | 245,001 | 17 |
| csv-insights | 8/8 | 136,545 | 8 | 8/8 | 121,594 | 9 | 8/8 | 106,767 | 8 | 8/8 | 990,827 | 66 |
| mini-template | 8/8 | 161,191 | 8 | 7/8 | 91,196 | 7 | 7/8 | 76,252 | 6 | 7/8 | 139,673 | 10 |
| http-kv | 9/9 | 214,296 | 10 | 8/9 | 60,866 | 5 | 9/9 | 76,272 | 6 | 9/9 | 212,194 | 15 |
| dependency-planner | 7/7 | 183,965 | 9 | 7/7 | 182,342 | 13 | 7/7 | 350,435 | 24 | 7/7 | 303,162 | 21 |
| **Total** | **40/40** | **922,519** | **47** | **38/40** | **911,580** | **65** | **39/40** | **807,825** | **58** | **39/40** | **1,890,857** | **129** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Prompt-token change from baseline

| Mode | Prompt tokens | Reduction |
|---|---:|---:|
| V2 | 911,580 | 1.2% |
| V3 | 807,825 | 12.4% |
| Paper | 1,890,857 | -105.0% |

## Aggregate counters

| Metric | Baseline | V2 | V3 | Paper |
|---|---:|---:|---:|---:|
| Input | 144 | 7,930 | 7,076 | 15,738 |
| Cache read | 922,375 | 903,650 | 800,749 | 1,875,119 |
| Cache write | 151,133 | 251,116 | 276,060 | 230,462 |
| Output | 24,340 | 35,606 | 30,551 | 51,238 |
| Reasoning | 4,027 | 3,086 | 3,923 | 3,054 |
| Tool calls | 59 | 65 | 58 | 129 |
| SKILL.state calls | 0 | 65 | 58 | 129 |
| State-tool errors | 0 | 0 | 0 | 0 |
| State comments | 0 | 62 | 57 | 0 |
| Finish calls | 0 | 5 | 5 | 5 |
| Consecutive repeated actions | 0 | 0 | 0 | 1 |
| Maximum repeat streak | 0 | 1 | 1 | 2 |
| Maximum state bytes | 0 | 2,761 | 978 | 1,793 |
| Actions inside v3 batches | 0 | 0 | 98 | 0 |
| Multi-action v3 batches | 0 | 0 | 28 | 0 |
| Failed v3 batches | 0 | 0 | 12 | 0 |
| Skipped v3 actions | 0 | 0 | 3 | 0 |
| Maximum actions per batch | 0 | 0 | 5 | 0 |
| Provider-reported cost | 0.53 | 0.66 | 0.59 | 1.06 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260904T203726Z/`
and the workspace paths named in each summary.
