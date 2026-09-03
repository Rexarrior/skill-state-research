# Core SKILL.state implementation and model benchmarks

Date: 2026-09-02/03

Branch: `skill-state`

Core implementation commit: `30e129b74`

Initial model: `openrouter-yandex-team/z-ai/glm-5.2`

## What was tested

The plugin prototype was removed. OpenCode core now exposes one required `skill_step` tool to the model. Each call
contains a model-owned `state_patch` and one nested action. Core buffers the provider turn, requires exactly one call,
validates the patch and resulting state, records the transition as pending, and only then dispatches the action through
the existing OpenCode tool machinery.

Every provider turn receives a fresh single user message containing only the immutable initial specification (`P`), the
latest validated full state (`Sigma`), and the latest action result (`O`). Previous reasoning, assistant text, actions,
and observations remain in the local session for audit but are not converted into provider messages.

A three-transition live smoke test completed `write -> read -> finish`. It created the expected file byte-for-byte and
stored state revisions 1, 2, and 3. The second and third requests reported only 181 and 177 uncached input tokens; the
large fixed system/action schema was served as 19,072 and 19,136 cache-read tokens.

## One-shot codegen results

Prompt tokens below are provider-reported `input + cache.read`. The suite is exploratory `n=1`. Nine of ten cells
completed. `dependency-planner/skill-state` did not produce its first transition after an extended provider wait and was
stopped; a 15-minute per-cell wall-clock timeout was added to the harness afterward.

| Project            | Baseline quality |    State quality | Baseline turns | State turns | Baseline prompt | State prompt | State delta |
| ------------------ | ---------------: | ---------------: | -------------: | ----------: | --------------: | -----------: | ----------: |
| taskboard-cli      |              8/8 |              8/8 |             10 |          57 |         285,977 |    1,185,560 |     +314.6% |
| csv-insights       |              8/8 |              8/8 |             12 |          80 |         328,590 |    1,666,810 |     +407.3% |
| mini-template      |              8/8 |              1/8 |             35 |          80 |       2,179,085 |    1,673,226 |      -23.2% |
| http-kv            |              9/9 |              9/9 |             14 |          29 |         395,031 |      625,748 |      +58.4% |
| dependency-planner |              1/7 | provider timeout |              2 | 0 completed |          46,040 |  unavailable |         n/a |

The apparent 23.2% saving on `mini-template` is not a valid efficiency win because quality fell from 8/8 to 1/8. On
the three completed equal-quality pairs, state used 3,478,118 prompt tokens versus 1,009,598 for baseline: 244.5% more.

## Did prompt bounding work?

Yes. State requests remained approximately constant while baseline requests grew with the transcript.

| Project       | Baseline first -> last | Baseline average | State first -> last | State average |
| ------------- | ---------------------: | ---------------: | ------------------: | ------------: |
| taskboard-cli |       23,067 -> 33,861 |           28,598 |    19,658 -> 20,613 |        20,799 |
| csv-insights  |       23,023 -> 30,183 |           27,383 |    20,059 -> 20,544 |        20,835 |
| mini-template |       22,877 -> 71,067 |           62,260 |    20,094 -> 20,086 |        20,915 |
| http-kv       |       23,097 -> 32,236 |           28,217 |    20,133 -> 20,557 |        21,578 |

This confirms the intended `(P, Sigma, O)` request shape and the expected bounded per-step cost. It does not produce a
total-token win here because the number of provider turns increased more quickly than per-turn cost fell.

## Transition diagnostics

| Project       | Turns | Valid revisions | Rejected transitions | Terminal finish | Main valid actions                         |
| ------------- | ----: | --------------: | -------------------: | --------------: | ------------------------------------------ |
| taskboard-cli |    57 |              48 |                    9 |              no | 20 bash, 22 read, 3 write, 2 glob, 1 edit  |
| csv-insights  |    80 |              80 |                    0 |              no | 38 bash, 30 read, 7 edit, 4 write, 1 glob  |
| mini-template |    80 |              61 |                   23 |              no | 33 bash, 21 read, 4 write, 2 glob, 1 edit  |
| http-kv       |    29 |              29 |                    0 |             yes | 8 bash, 15 read, 3 write, 2 edit, 1 finish |

The runtime rejected malformed transitions before execution. In `mini-template`, five turns attempted five
`skill_step` calls in one provider response; none of those nested actions ran. Other rejected cases were missing
`state_patch`/`action`, unavailable direct tools, and responses with no required transition.

The largest state was only 1,492 bytes, so state growth was not the source of overhead. The dominant issues were:

1. Stock OpenCode can execute several tool calls from one provider turn; the paper-faithful contract permits one action
   per transition.
2. GLM-5.2 often used separate turns for repeated reads and test commands.
3. Three state runs reached or approached the 80-turn ceiling without `finish`, even when hidden quality was already
   complete.
4. Long and highly variable reasoning time dominated some cells, especially `dependency-planner`.

## Conclusion and next experiment

The core implementation now tests the paper's protocol rather than the old file-reading approximation. Prompt
construction is bounded and model-owned patches are enforced atomically. On these short codegen projects, however, the
strict one-action loop is materially worse in total tokens and latency, and one complex task lost quality.

The next useful measurement is the planned deterministic 25/50/100/200-step suite, where both arms are forced to take
the same number of actions. That isolates the asymptotic context effect from OpenCode's multi-tool batching and GLM's
termination behavior. Repeating the codegen suite is only useful after adding per-request timeout and a metric for the
turn at which hidden quality first became complete.

## GPT-5.6 Terra follow-up

A follow-up `n=1` A/B run used `openai-yandex-team/gpt-5.6-terra` on `http-kv`, the project where both GLM arms had
previously reached 9/9. Terra also reached 9/9 in both modes, but unlike GLM it followed the state protocol efficiently.

| Metric                               | Baseline | Core SKILL.state | Change |
| ------------------------------------ | -------: | ---------------: | -----: |
| Hidden checks                        |      9/9 |              9/9 |  equal |
| Provider turns                       |       10 |                8 | -20.0% |
| Prompt tokens (`input + cache.read`) |  224,849 |          106,354 | -52.7% |
| Prompt tokens including cache writes |  254,265 |          132,025 | -48.1% |
| Output tokens                        |    6,313 |            4,908 | -22.3% |
| Reasoning tokens                     |    2,012 |               98 | -95.1% |
| Wall time                            |  94.65 s |          62.49 s | -34.0% |
| Provider-reported cost               |   0.1449 |           0.0831 | -42.7% |

The state run produced eight valid revisions, zero protocol errors, and an in-band `finish`. Its actions were three
`bash`, one `glob`, two `apply_patch`, one `read`, and `finish`. State reached 1,486 bytes.

After the initial cache population, every state request used exactly 15,176 reported prompt tokens. Baseline requests
grew from 19,657 to 29,210. Terra therefore demonstrated both parts needed for an end-to-end win in this sample: bounded
per-turn context and no increase in the number of turns. This is still one project and one run, so it is evidence that
the implementation can be beneficial with a protocol-disciplined model, not a general performance claim.

## Full GPT-5.6 Terra codegen benchmark

The same Terra model was then run through all five projects in a new independent suite. All ten cells completed within
the 15-minute limit. There were no rejected state transitions or runtime protocol errors.

Raw suite: [`20260902T234713Z`](./results/20260902T234713Z/report.md)

| Project            | Baseline quality | State quality | Baseline turns | State turns | Baseline prompt |  State prompt | State delta |
| ------------------ | ---------------: | ------------: | -------------: | ----------: | --------------: | ------------: | ----------: |
| taskboard-cli      |              8/8 |           8/8 |             13 |          37 |         276,892 |       547,288 |      +97.7% |
| csv-insights       |              8/8 |           7/8 |             11 |          80 |         233,106 |     1,255,108 |     +438.4% |
| mini-template      |              7/8 |           7/8 |             13 |           9 |         282,154 |       121,570 |      -56.9% |
| http-kv            |              9/9 |           9/9 |             10 |          15 |         219,328 |       213,606 |       -2.6% |
| dependency-planner |              7/7 |           7/7 |             11 |          28 |         239,672 |       409,874 |      +71.0% |
| **Total**          |        **39/40** |     **38/40** |         **58** |     **169** |   **1,251,152** | **2,547,446** | **+103.6%** |

Prompt tokens are provider-reported `input + cache.read`, matching the generated suite report. Including cache writes,
the totals are 1,386,559 for baseline and 2,770,060 for state, a 99.8% increase. Provider-reported cost rose from
0.6186 to 1.4013 (+126.6%), and wall time from 410.05 to 829.57 seconds (+102.3%). On the four pairs with equal
evaluator quality, state still used 26.9% more `input + cache.read` tokens.

Only `mini-template` produced a decisive end-to-end efficiency win in this run: equal 7/8 quality, 56.9% fewer prompt
tokens, 22.6% less wall time, and 29.0% lower provider cost. The state and baseline implementations made the same
mistake in `each` element context. `http-kv` was effectively a token tie in this repeat; including cache writes, state
used 248,688 tokens against baseline's 247,854.

### Terra transition diagnostics

| Project            | Revisions | Protocol errors | Finish | Maximum state | Valid action mix                                  |
| ------------------ | --------: | --------------: | -----: | ------------: | ------------------------------------------------- |
| taskboard-cli      |        37 |               0 |    yes |       1,594 B | 19 bash, 10 read, 4 glob, 3 apply_patch, 1 finish |
| csv-insights       |        80 |               0 |     no |       1,448 B | 77 bash, 2 apply_patch, 1 read                    |
| mini-template      |         9 |               0 |    yes |       1,201 B | 6 bash, 1 glob, 1 apply_patch, 1 finish           |
| http-kv            |        15 |               0 |    yes |       1,078 B | 8 bash, 3 read, 2 apply_patch, 1 glob, 1 finish   |
| dependency-planner |        28 |               0 |    yes |       2,483 B | 17 bash, 6 read, 2 glob, 2 apply_patch, 1 finish  |

Prompt bounding worked in every state cell. Counting `input + cache.read + cache.write`, individual state requests
stayed between 15.9k and 18.5k tokens across the suite. Baseline requests started around 19.6k after cache population
and ended between 26.0k and 28.5k. State size remained below 2.5 KB, so neither state growth nor transcript leakage
caused the high aggregate usage.

The failure mode was repeated action selection. `csv-insights` issued `python3 -m py_compile main.py` 74 consecutive
times after it had already succeeded, reached the 80-step ceiling without `finish`, and scored 7/8. `taskboard-cli`
ran `bun test` 11 times. Those transitions were structurally valid and atomically applied; the model simply kept the
same `next_action` after a successful empty observation. `dependency-planner` did not loop on one identical command,
but decomposed verification into many distinct shell actions.

The earlier isolated `http-kv` result did not reproduce at the same magnitude. Baseline stayed at 10 turns in both
runs, while state varied from 8 to 15 turns. Across the two `http-kv` repeats, state averaged 159,980 prompt tokens
versus 222,089 for baseline (28.0% lower), but two samples are still too few to characterize variance.

### Updated conclusion

Terra validates that the core protocol is usable and that bounded `(P, Sigma, O)` prompts can reduce end-to-end cost
when the model finishes in no more turns than baseline. The full suite also shows that schema compliance is not enough:
a valid but repeated action can erase the asymptotic benefit long before context length becomes large. For short
codegen tasks, total performance is dominated by action count and termination behavior.

The structured-observation experiment below adds explicit action identity and a successful-empty-result marker without
adding a runtime-owned repeated-action detector. Such a detector remains a possible separate arm. The deterministic
25/50/100/200-step suite is still necessary to test the paper's central scaling claim while holding action count fixed.

## Structured observation-window v2 smoke

The result-only observation was replaced with a bounded structured record containing the exact action and input,
optional model-authored comment, final status, and result. The latest `k` records are sent oldest-to-newest; `k` defaults
to 3 and is configurable from 1 to 8. The durable `verification` state field was removed. Protocol-v2 metadata records
the comment, and action input/result fields are deterministically bounded before provider serialization.

Terra was rerun on `csv-insights`, the task where v1 had repeated `python3 -m py_compile main.py` 74 times. These are
independent smoke samples, not a statistically powered comparison.

| Runtime        | Quality | Turns | Prompt tokens | With cache writes |   Cost | Seconds | Repeated actions | Finish |
| -------------- | ------: | ----: | ------------: | ----------------: | -----: | ------: | ---------------: | -----: |
| Fresh baseline |     7/8 |     7 |       132,311 |           157,353 | 0.0814 |  103.24 |              n/a |    n/a |
| State v1       |     7/8 |    80 |     1,255,108 |         1,296,041 | 0.5758 |  325.81 |               74 |     no |
| State v2, k=1  |     8/8 |     6 |        76,122 |            99,389 | 0.0604 |   50.91 |                0 |    yes |
| State v2, k=3  |     8/8 |     4 |        45,752 |            67,198 | 0.0425 |   33.11 |                0 |    yes |
| State v2, k=5  |     8/8 |    13 |       182,654 |           238,594 | 0.1135 |   88.71 |                0 |    yes |

The `k=3` trace used exactly four transitions: `glob -> apply_patch -> bash -> finish`. Every transition contained a
comment, every hidden check passed, and per-request prompt size including cache writes stayed between 16.0k and 17.8k.
Compared with the fresh baseline sample, it used 65.4% fewer `input + cache.read` tokens, cost 47.8% less, and completed
67.9% faster while passing one additional hidden check.

Both `k=1` and `k=5` also avoided repeated actions and reached 8/8. The `k=5` run made one malformed transition; the
runtime retained the last valid state, emitted a structured protocol-error observation, and the next turn recovered.
Its higher turn count made it more expensive than baseline, reinforcing that window size and model variance must be
measured separately. The smoke establishes functional correctness and removes the observed empty-output ambiguity; it
does not yet establish an optimal `k`.

## Full GPT-5.6 Terra benchmark with `k=3`

The complete five-project suite was repeated after the structured-observation change with
`OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW=3`. All ten cells completed within the 15-minute per-cell limit.

Raw suite: [`20260903T124451Z`](./results/20260903T124451Z/report.md)

| Project            | Baseline quality | State quality | Baseline turns | State turns | Baseline prompt | State prompt | Savings |
| ------------------ | ---------------: | ------------: | -------------: | ----------: | --------------: | -----------: | ------: |
| taskboard-cli      |              7/8 |           8/8 |             10 |           7 |         202,855 |       91,346 |   55.0% |
| csv-insights       |              7/8 |           8/8 |              9 |           4 |         182,809 |       45,728 |   75.0% |
| mini-template      |              7/8 |           7/8 |             11 |           7 |         208,103 |       91,334 |   56.1% |
| http-kv            |              9/9 |           9/9 |             10 |           4 |         219,246 |       45,740 |   79.1% |
| dependency-planner |              7/7 |           7/7 |             12 |          11 |         250,801 |      152,162 |   39.3% |
| **Total**          |        **37/40** |     **39/40** |         **52** |      **33** |   **1,063,814** |  **426,310** | **59.9%** |

Prompt tokens are provider-reported `input + cache.read`. Including cache writes, state used 576,091 tokens versus
1,220,613 for baseline, a 52.8% reduction. Provider-reported cost fell from 0.5989 to 0.3502 (41.5%), output tokens
from 26,335 to 20,331 (22.8%), and reasoning tokens from 5,819 to 1,141 (80.4%). Wall time fell from 1,003.35 to
323.87 seconds, although most of that difference is explained by an anomalous 609.5-second provider wait in the
`mini-template` baseline cell; the token comparison is not affected by that wait.

The state arm had 33 valid revisions, zero rejected transitions, zero repeated identical actions, 33 comments, and
five terminal `finish` calls. Revision counts exactly matched provider-turn counts in every state cell. The largest
state was 1,559 bytes. The action sequences were short for four projects; `dependency-planner` required 11 actions to
recover from a runtime-compatibility issue and rerun its self-tests, but still used 39.3% fewer prompt tokens than its
baseline.

Only `mini-template` failed a hidden state check, the same `each`-context check that failed in baseline. State passed
two checks missed by baseline: decimal serialization in `csv-insights` and delete/missing-ID behavior in
`taskboard-cli`. This is not evidence that state generally improves quality, but it rules out a quality tradeoff in
this particular sample.

Per-request prompt size including cache writes stayed between 16,034 and 20,023 tokens in state runs. Baseline requests
started between 19,584 and 19,653 and ended between 26,376 and 28,431 as transcripts accumulated. Raw transition
metadata confirms protocol version 2, contiguous revisions, and the presence of action name, bounded input, comment,
status, and result for reconstruction of each observation. Core prompt construction then selects only the latest three
records in oldest-to-newest order, alongside immutable `P` and current `Sigma`; older transcript messages remain local
and are not converted into provider messages.

This `n=1` result is the first full-suite sample where structured state won on every project's prompt-token count while
preserving or improving aggregate hidden-check quality. The contrast with the earlier Terra run also shows substantial
model variance: the v1 action-identity ambiguity caused long repeated-action loops, while v2 with `k=3` had none. More
repetitions are needed before attributing all of the improvement to `k=3` rather than the richer observation record and
sampling variance.
