# GLM-5.2 one-shot A/B results

Suite: `20260902T115832Z`  
Model: `openrouter-yandex-team/z-ai/glm-5.2`  
Design: one independent run per project and mode; one user prompt per run; sequential execution with alternating mode order.

| Project            | Baseline score | SKILL.state score | Baseline prompt tokens¹ | SKILL.state prompt tokens¹ |     Savings |  Turns B/S |           Seconds B/S |
| ------------------ | -------------: | ----------------: | ----------------------: | -------------------------: | ----------: | ---------: | --------------------: |
| taskboard-cli      |            8/8 |               1/8 |               1,400,095 |                  1,873,634 |      -33.8% |      31/81 |          586.9/473.14 |
| csv-insights       |            7/8 |               2/8 |                 534,672 |                  1,850,904 |     -246.2% |      12/80 |         463.94/565.42 |
| mini-template      |            1/8 |               1/8 |                  45,439 |                  1,861,422 |    -3996.5% |       2/80 |          385.2/199.18 |
| http-kv            |            9/9 |               0/9 |                 842,334 |                     46,234 |       94.5% |       19/2 |         574.96/506.05 |
| dependency-planner |            7/7 |               1/7 |                 495,997 |                  1,063,994 |     -114.5% |      15/46 |        285.88/2,261.4 |
| **Total**          |      **32/40** |          **5/40** |           **3,318,537** |              **6,696,188** | **-101.8%** | **79/289** | **2,296.87/4,005.18** |

¹ Prompt tokens are provider-reported `input + cache.read`. Raw counters are retained in each cell's `summary.json`.

## Outcome

This prototype is **not usable with GLM-5.2 in its current form**. Baseline completed 32/40 checks (80%); SKILL.state
completed 5/40 (12.5%). The experimental mode used 101.8% more prompt tokens, cost 50.8% more, and took 74.4% longer
overall. The apparent 94.5% saving on `http-kv` is not a success: the model stopped after two turns without creating
`server.py`, so the evaluator scored it 0/9.

The context projection itself did work. Across the raw step events, baseline prompt context grew from roughly 22.4k on
the first turn to 39.4k–62.5k on the last turn of successful multi-step runs. SKILL.state stayed around 22.7k–23.5k per
turn. Average prompt tokens per turn fell from 42,007 to 23,170 (44.8%), but total turns rose from 79 to 289 (3.66×),
more than erasing the per-turn saving.

## Failure analysis

1. **The state protocol was optional in practice.** GLM-5.2 made 315 non-state tool calls but only eight `skill_state`
   calls (2.5%). Two of five plugin runs never called it. The runtime instruction asks for one patch alongside every
   action, but a parallel tool call cannot enforce that invariant.
2. **The immutable prompt referenced the specification instead of containing it.** The one user message said to
   implement `SPEC.md`; the full requirements entered context only through a `read` result. Baseline retained that result
   in history. SKILL.state discarded it on the following turn, and the sparse patches recorded only facts such as
   `inspect specification` and `implement`, not the requirements themselves.
3. **The model entered observation loops.** The plugin workspaces all ended with only the original `SPEC.md`. The common
   pattern was repeated `read SPEC.md` / `bash ls` calls. No state patch failed, and the largest state was only 432 bytes,
   so capacity was not the problem.
4. **There were two independent early model failures.** Baseline `mini-template` and plugin `http-kv` each performed two
   reads/actions, spent about 32k reasoning tokens, then returned no implementation. This demonstrates substantial
   run-to-run variance even at configured temperature zero.

## What to change before the next A/B

- Make action and state update atomic: expose a single `skill_step` operation (or change the core agent loop) whose
  schema contains both the environment action and a mandatory `state_patch`. Do not rely on an optional parallel tool.
- Put the complete task specification in the immutable user content. For file-based tasks, attach/pin `SPEC.md` on the
  first message or have the runtime explicitly promote the first specification read into immutable context.
- Run with a clean OpenCode config that disables global MCP servers and skill catalogs. They were present in both groups
  here, so they do not explain the A/B direction, but they create an approximately 22k-token fixed floor that limits the
  achievable percentage saving.
- Add a wall-clock limit and run at least three repetitions per cell before estimating expected savings or quality.

The useful result is therefore narrower than the paper's claim: bounded context was reproduced, but this plugin's
tool-level approximation did not reproduce the paper's reliable structured transition protocol.

## Aggregate counters

| Metric                 |  Baseline | SKILL.state |
| ---------------------- | --------: | ----------: |
| Input                  |   994,756 |   1,040,096 |
| Cache read             | 2,323,781 |   5,656,092 |
| Cache write            |         0 |           0 |
| Output                 |    39,267 |      21,118 |
| Reasoning              |   104,400 |     208,388 |
| Tool calls             |        75 |         323 |
| SKILL.state calls      |         0 |           8 |
| State-tool errors      |         0 |           0 |
| Maximum state bytes    |         0 |         432 |
| Provider-reported cost |      1.85 |        2.79 |

## Interpretation guardrails

- This is an exploratory `n=1` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and seed files.
  The experimental cells add only the local SKILL.state plugin.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.
- Global user-configured MCP servers and skill catalogs were loaded by OpenCode in both modes. Their fixed prompt cost was
  not isolated in this first exploratory suite.

Raw events, stderr, summaries, and the generated workspaces are recorded under `experiments/skill-state/results/20260902T115832Z/`
and the workspace paths named in each summary.
