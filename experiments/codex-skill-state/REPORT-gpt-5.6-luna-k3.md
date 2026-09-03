# Codex CLI benchmark: GPT-5.6 Luna, SKILL.state v2, `k=3`

Date: 2026-09-03

This report covers the five existing one-shot code-generation fixtures run through Codex CLI with
`gpt-5.6-luna`, medium reasoning, an observation window of three, a 15-minute per-cell timeout, and no more than two
concurrent runners. Both binaries were built from upstream Codex commit
`1d74c3ba1ee98be2025ab066dcc3fd654fe8a3b6`; the baseline was pristine and the experimental binary contained the
kernel SKILL.state v2 changes.

The raw post-fix state artifacts and combined report are in
[`results/20260903T192411Z/`](./results/20260903T192411Z/). Its unchanged baseline cells come from the valid pristine
suite [`results/20260903T181508Z/`](./results/20260903T181508Z/).

## Final post-fix result

| Metric | Pristine baseline | SKILL.state v2 |
|---|---:|---:|
| Hidden checks | 40/40 | 39/40 |
| Input tokens | 1,265,791 | 4,482,763 |
| Provider samples | 60 | 268 |
| Wall time | 923 s | 3,396 s |
| Cells finishing in-band | 5/5 | 3/5 |
| State transition errors | n/a | 23 |

State used **3.54x** as many input tokens and **4.47x** as many provider samples, while taking **3.68x** as long. Its
input per sample was lower—16,727 versus 21,097, a **20.7% reduction per sampling request**—but that local saving was
overwhelmed by step amplification.

Per project:

| Project | Baseline | State | Baseline input | State input | State termination |
|---|---:|---:|---:|---:|---|
| taskboard-cli | 8/8 | 7/8 | 154,372 | 1,184,713 | timeout |
| csv-insights | 8/8 | 8/8 | 278,423 | 520,366 | finish |
| mini-template | 8/8 | 8/8 | 276,269 | 1,404,911 | finish |
| http-kv | 9/9 | 9/9 | 369,264 | 1,072,823 | timeout after implementation passed all checks |
| dependency-planner | 7/7 | 7/7 | 187,463 | 299,950 | finish |

`taskboard-cli` missed only the delete/missing-id evaluator check. `http-kv` had already reached 9/9 when the runtime
stopped it, but it never emitted `finish`; it is therefore still a timeout, not a successful cell.

## Defect discovered by the first suite

The first complete state run, preserved at [`results/20260903T181508Z/`](./results/20260903T181508Z/), scored only 2/40
and timed out in all five state cells. Rollout inspection showed that 79 of 91 rejected transitions came from the
prototype's 3 KiB limit on the *incoming* action payload. Normal code-generation patches were 4–11 KiB, so the runtime
rejected them before execution and the model repeatedly returned to inspection and retry.

The kernel was corrected to accept action requests up to 64 KiB while retaining at most a 3 KiB action preview in the
next observation. This preserves bounded `O[n..n-k]` without preventing normal edits. A focused unit test covers this
contract. The post-fix suite improved state quality from 2/40 to 39/40 and reduced state errors from 91 to 23.

The 23 remaining post-fix errors were all malformed `skill_step` payloads rather than size-limit failures. The most
common form was a map where a freeform string was required; this points to wrapper ergonomics/schema adherence as a
separate issue.

## Interpretation

This benchmark does not support using SKILL.state v2 for these short Codex code-generation tasks. The state prompt was
smaller per request, but the forced one-patch/one-action loop needed many more requests than upstream Codex. The
baseline retains Codex Code Mode, which can perform a larger unit of work per provider sample; state mode deliberately
uses direct atomic tools because nesting Code Mode would violate the tested paper contract. Consequently this A/B
measures the practical runtime replacement, not a prompt-only ablation with identical tool granularity.

The result is consistent with the Apex warning: asymptotic `O(T)` context growth does not imply a win at short horizons.
Here the crossover was not reached because step count, schema overhead, malformed wrapper calls, and delayed termination
dominated.

## Next experiments

1. Add a transcript baseline that also uses direct atomic tools, isolating memory representation from Code Mode batching.
2. Make freeform nested actions harder to mis-shape, then measure invalid-transition rate again.
3. Add an explicit runtime step/token budget and a completion check to prevent post-verification wandering.
4. Run controlled 25/50/100/200-step tasks where both modes are forced to take the same number and granularity of actions.
5. Repeat successful configurations more than once; every cell here is exploratory `n=1`.

## Excluded runs

- [`results/20260903T180550Z/`](./results/20260903T180550Z/) is marked invalid because all processes failed CLI argument
  parsing before a model request.
- [`results/20260903T191424Z/`](./results/20260903T191424Z/) is marked invalid because a shared Cargo target caused the
  supposed state binary to link against pristine core; its rollout had zero `skill_step` calls.
- [`results/20260903T191855Z/`](./results/20260903T191855Z/) is a valid post-fix state-only protocol probe (7/7,
  19 transitions, zero state errors), not part of the final five-cell sample.
