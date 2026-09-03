# Codex CLI benchmark: GPT-5.6 Terra, SKILL.state v2, `k=3`

Date: 2026-09-03

This report covers the five one-shot code-generation fixtures run through Codex CLI with `gpt-5.6-terra`, medium
reasoning, an observation window of three, a 15-minute per-cell timeout, and no more than two concurrent runners. Both
binaries were built from upstream Codex commit `1d74c3ba1ee98be2025ab066dcc3fd654fe8a3b6`; the baseline was pristine and
the experimental binary contained the post-action-limit-fix SKILL.state v2 kernel.

The combined report, CLI events, persisted rollouts, stderr, summaries, and workspace locations are in
[`results/20260903T203123Z/`](./results/20260903T203123Z/).

## Result

| Metric | Pristine baseline | SKILL.state v2 |
|---|---:|---:|
| Hidden checks | 38/40 | 39/40 |
| Input tokens | 1,588,485 | 1,243,798 |
| Provider samples | 61 | 71 |
| Output tokens | 40,438 | 40,261 |
| Reasoning tokens | 11,016 | 5,237 |
| Wall time | 958 s | 1,032 s |
| Cells finishing in-band | 5/5 | 5/5 |

State reduced input tokens by **21.7%** while scoring one additional hidden check. It used 16.4% more provider samples,
but average input per sample fell from 26,041 to 17,518, a **32.7% per-request reduction**. Total wall time increased by
7.7%, so the token saving did not translate into a latency saving in this sample.

Per project:

| Project | Baseline | State | Baseline input | State input | State saving |
|---|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 8/8 | 165,036 | 306,880 | -85.9% |
| csv-insights | 7/8 | 8/8 | 304,061 | 207,433 | 31.8% |
| mini-template | 8/8 | 7/8 | 515,362 | 135,471 | 73.7% |
| http-kv | 8/9 | 9/9 | 331,653 | 283,506 | 14.5% |
| dependency-planner | 7/7 | 7/7 | 272,373 | 310,508 | -14.0% |

The aggregate hides substantial task variance. State was simultaneously cheaper and more accurate on `csv-insights`
and `http-kv`, much cheaper but one check worse on `mini-template`, and more expensive at equal quality on `taskboard`
and `dependency-planner`.

Baseline failures were decimal values emitted as JSON numbers instead of strings in `csv-insights`, and returning 404
instead of 405 for an unsupported method in `http-kv`. State's only quality failure was missing `this.name` resolution
inside `each` in `mini-template`.

## Protocol behavior

All 71 state samples produced persisted `skill_step` transitions, all five sessions emitted `finish`, no cell timed out,
and there were no consecutive identical actions. Five observations had error status:

- three rejected stale revisions, from which the model recovered;
- two ordinary `apply_patch` context mismatches, also recovered.

There were no action-size failures and no malformed payloads. Maximum durable state remained small at 683 bytes, so the
observed saving did not depend on state approaching its 32 KiB cap.

## Comparison with Luna

On the same post-fix kernel and fixtures, Luna state scored 39/40 but used 3.54x the baseline input, required 268 samples,
and timed out in two cells. Terra reached the same 39/40 with 71 samples, no timeout, and a 21.7% aggregate input saving.
This is strong evidence that protocol-following and action policy are model-dependent. It is not evidence of a stable
model ranking: both experiments are exploratory `n=1` samples.

## Interpretation limits

The pristine baseline retains upstream Codex Code Mode, while state mode forces direct atomic tools to preserve the
paper's one-patch/one-action contract. This is a practical runtime A/B, not a prompt-only ablation with identical tool
granularity. The five projects are short tasks; they do not test the paper's asymptotic long-horizon claim. Repeated runs
and a controlled direct-tool transcript baseline are needed before treating 21.7% as an expected saving.
