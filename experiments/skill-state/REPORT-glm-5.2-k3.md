# GLM-5.2 benchmark with structured observations (`k=3`)

Date: 2026-09-03

Suite: `20260903T140344Z`

Model: `openrouter-yandex-team/z-ai/glm-5.2`

Runtime commit: `75df38f6f`

Raw suite: [`20260903T140344Z`](./results/20260903T140344Z/report.md)

**Operational status: GLM-5.2 does not complete this benchmark reliably with `k=3`, sequential execution, and a
15-minute per-cell limit.**

## Method

The same five one-shot codegen projects were run once in baseline mode and once with the core SKILL.state v2 runtime.
Both arms used the same checkout, model, task prompt, externally attached specification, agent configuration, tools, and
permissions. State runs used a three-observation window. Cells ran sequentially with a 15-minute wall-clock limit.
Hidden evaluators ran after OpenCode exited and were not visible to the model.

Prompt tokens below are provider-reported `input + cache.read`. GLM reported no cache-write tokens for these calls.

## Results

| Project            | Baseline quality | State quality | Baseline turns | State turns | Baseline prompt |  State prompt | State delta | State result   |
| ------------------ | ---------------: | ------------: | -------------: | ----------: | --------------: | ------------: | ----------: | -------------- |
| taskboard-cli      |              8/8 |           8/8 |             43 |          22 |       1,725,272 |       491,769 |      -71.5% | finished       |
| csv-insights       |              8/8 |           6/8 |              6 |          44 |         150,806 |     1,006,456 |     +567.4% | timeout        |
| mini-template      |              8/8 |           7/8 |             14 |          14 |         410,096 |       310,648 |      -24.2% | timeout        |
| http-kv            |              8/9 |           9/9 |             17 |          12 |         520,761 |       270,251 |      -48.1% | finished       |
| dependency-planner |              7/7 |           1/7 |             16 |           3 |         555,552 |        59,726 |      -89.2% | timeout        |
| **Raw total**      |        **39/40** |     **31/40** |         **96** |      **95** |   **3,362,487** | **2,138,850** |  **-36.4%** | **3 timeouts** |

The raw total is not an equal-quality efficiency comparison: three state cells were terminated at 15 minutes and
their scores and token totals are partial. In particular, `dependency-planner` had only three provider turns and did
not create the implementation. It is therefore incorrect to interpret the raw 36.4% reduction as a successful
full-suite saving.

The two pairs where both arms finished were `taskboard-cli` and `http-kv`. On those pairs, state passed 17/17 hidden
checks versus baseline's 16/17, used 762,020 prompt tokens versus 2,246,033 (66.1% fewer), and took 34 turns versus 60.
This subset is favorable but post-selected and small. The 43-turn `taskboard-cli` baseline is also an unusually long
sample, so it should not be generalized.

## Aggregate diagnostics

| Metric                        |   Baseline |           State |
| ----------------------------- | ---------: | --------------: |
| Completed cells               |        5/5 |             2/5 |
| Hidden checks                 |      39/40 | 31/40 (partial) |
| Provider turns                |         96 |              95 |
| Prompt tokens                 |  3,362,487 |       2,138,850 |
| Output tokens                 |     41,287 |          50,709 |
| Reasoning tokens              |     19,757 |         124,761 |
| Provider-reported cost        |      1.175 |           1.221 |
| Wall time                     | 1,147.23 s |      3,132.77 s |
| Valid state revisions         |          - |              81 |
| Rejected state transitions    |          - |              14 |
| Identical consecutive actions |          - |               0 |
| Terminal `finish` calls       |          - |               2 |
| Maximum state size            |          - |         2,118 B |

Despite consuming fewer prompt tokens in the partial aggregate, state cost 3.9% more, used 6.3 times as many reasoning
tokens, and took 2.7 times as long. The three timeout cells account for 2,700 seconds of state wall time.

## Prompt-bounding check

Prompt bounding itself worked. State requests, including any reported cache writes, stayed between 19,735 and 25,062
tokens across all five projects. Baseline requests started between 22,883 and 23,106 tokens and ended between 27,244
and 49,208 as their transcripts accumulated. State sizes remained below 2.2 KB. There is no sign that old transcript
messages leaked into provider-visible state prompts.

All state summaries record `observationWindow: 3`. Valid transition metadata contains protocol version 2, contiguous
revisions, model-authored patches, action name and input, optional comments, and final action status. The runtime kept
the latest three structured observations in oldest-to-newest order; older transcript entries remained local for audit.

## Failure analysis

The v2 observation record fixed the exact failure it targeted: none of the five state cells repeated an identical
action and input consecutively. The v1 GLM run had repeated `python3 -m py_compile main.py` 74 times. GLM instead failed
in three different ways here:

1. **Excessive but non-identical inspection.** `csv-insights` made 38 valid transitions: one `bash`, one `write`, and
   36 `read` actions with varying ranges. It repeatedly stated that it was gathering exact source text before fixing
   the same issues, but never edited, tested, documented, or finished. Six additional calls omitted the required outer
   `state_patch`/`action` shape. The partial implementation passed 6/8 checks.
2. **Slow reasoning/provider turns.** `dependency-planner` used 32,157 reasoning tokens in only three provider turns
   and reached the 15-minute limit after two valid directory-inspection actions plus one turn without `skill_step`.
   No implementation files were created. `mini-template` similarly consumed 58,783 reasoning tokens, reached 7/8,
   and timed out before writing its README or calling `finish`.
3. **Protocol non-compliance.** Across the suite, 14 transitions were rejected before action execution: six malformed
   `csv-insights` calls, two responses without `skill_step`, two attempts to invoke the unavailable `invalid` tool, and
   four patches that deleted required state fields such as `next_action` or `plan`. The two successful projects
   recovered from their rejected transitions and eventually issued valid `finish` actions.

`http-kv` is the strongest positive cell: state reached 9/9 in 12 turns with 48.1% fewer prompt tokens, while baseline
reached 8/9 in 17 turns. `taskboard-cli` also reached 8/8 in both modes and state used 71.5% fewer prompt tokens, although
both trajectories were much longer than the Terra samples.

## Comparison with Terra and conclusion

Under the same v2 runtime and `k=3`, the Terra full-suite sample completed all five state cells, produced zero rejected
transitions, issued five `finish` actions, reached 39/40 checks, and used 426,310 prompt tokens. This GLM sample completed
two state cells, produced 14 rejected transitions, issued two `finish` actions, reached a partial 31/40, and used
2,138,850 prompt tokens.

The core architecture is doing what it should: prompts stay bounded, patches are validated before actions, failures
remain visible, and the action identity prevents the old identical-command loop. The result does not show that `k=3`
makes GLM-5.2 reliable for this codegen workload. Explicit action memory removes one pathological loop, but GLM can
replace it with repeated non-identical reads, invalid transitions, or very long reasoning calls. Further GLM work
should focus on protocol adherence and progress/termination policy rather than increasing the observation window.

This remains an exploratory `n=1` suite. It supports a strong negative result about this sampled GLM run, not a stable
estimate of the model's average performance.

## Single-runner confirmation attempt

A second suite (`20260903T153017Z`) was started to test whether the failures above were caused by concurrent runners.
The harness executes cells strictly sequentially, so there was one benchmark process and at most one child OpenCode
run at any moment—stricter than the requested maximum of two. The model, `k=3`, prompt, projects, permissions, and
15-minute cell limit were unchanged.

The repeat was manually stopped after six cells had produced summaries and the seventh (`http-kv / skill-state`) had
remained active beyond its expected cutoff. No benchmark or child OpenCode process remained afterward. Because the
suite was intentionally interrupted, it has no aggregate generated report and must not be combined numerically with
the complete suite above. Partial summaries and event traces are retained under
[`20260903T153017Z`](./results/20260903T153017Z/).

| Completed pair | Baseline quality | State quality | Baseline turns | State turns | Baseline prompt | State prompt | State result |
| -------------- | ---------------: | ------------: | -------------: | ----------: | --------------: | -----------: | ------------ |
| taskboard-cli  |              8/8 |           8/8 |             36 |          34 |       1,090,595 |      740,804 | finished     |
| csv-insights   |              7/8 |           7/8 |             11 |          33 |         290,774 |      709,778 | finished     |
| mini-template  |              7/8 |           1/8 |             34 |           3 |       1,254,241 |       59,634 | timeout      |

The confirmation attempt reproduces the reliability problem with only one active runner:

- `csv-insights / skill-state` did finish, but needed 33 turns and 747 seconds versus 11 turns and 120 seconds for
  baseline. At equal 7/8 quality it used 144.1% more prompt tokens and produced five rejected transitions.
- `mini-template / skill-state` timed out after only three provider turns, consumed 64,077 reasoning tokens, and left
  a 1/8 partial implementation. This is consistent with very long model/provider calls rather than a fast action loop.
- `taskboard-cli / skill-state` reached 8/8, but made 34 turns and 18 rejected transitions. It saved 32.1% prompt tokens
  only because the matching baseline was also unusually long at 36 turns.
- The subsequent `http-kv / skill-state` did not return a completed cell summary before the suite was stopped.

This repeat shows that excessive runner concurrency was not required to trigger the failures. It does not distinguish
model-side latency from transport/provider instability, and it would be unsafe to attribute every timeout to the
SKILL.state policy alone. The operational conclusion is nevertheless clear: under the stated conditions, GLM-5.2 does
not complete the benchmark consistently enough for a valid efficiency comparison and should be marked unsupported for
this experiment until provider latency and protocol adherence are addressed.
