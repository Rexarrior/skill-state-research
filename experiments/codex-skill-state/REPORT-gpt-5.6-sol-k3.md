# Codex CLI benchmark: GPT-5.6 Sol, SKILL.state v2, `k=3`

Date: 2026-09-04

This report covers the five one-shot code-generation fixtures run through Codex CLI with `gpt-5.6-sol`, medium
reasoning, an observation window of three, a 15-minute per-cell timeout, and no more than two concurrent runners. Both
binaries were built from upstream Codex commit `1d74c3ba1ee98be2025ab066dcc3fd654fe8a3b6`; the baseline was pristine and
the experimental binary contained the post-action-limit-fix SKILL.state v2 kernel.

The combined report, CLI events, persisted rollouts, stderr, summaries, and workspace locations are in
[`results/20260903T205533Z/`](./results/20260903T205533Z/).

## Result

| Metric | Pristine baseline | SKILL.state v2 |
|---|---:|---:|
| Hidden checks | 40/40 | 40/40 |
| Input tokens | 3,446,461 | 1,691,115 |
| Provider samples | 94 | 94 |
| Output tokens | 71,019 | 73,180 |
| Reasoning tokens | 24,160 | 8,786 |
| Wall time | 1,679 s | 1,747 s |
| Cells finishing in-band | 5/5 | 5/5 |

State reduced input tokens by **50.9%** at identical evaluator quality and with exactly the same aggregate number of
provider samples. Average input per sample fell from 36,664 to 17,991, also a **50.9% per-request reduction**. Total
wall time increased by 4.1%, so the input reduction did not produce a latency reduction in this sample.

Per project:

| Project | Baseline | State | Baseline input | State input | State saving |
|---|---:|---:|---:|---:|---:|
| taskboard-cli | 8/8 | 8/8 | 327,713 | 440,776 | -34.5% |
| csv-insights | 8/8 | 8/8 | 1,137,581 | 145,766 | 87.2% |
| mini-template | 8/8 | 8/8 | 297,110 | 135,367 | 54.4% |
| http-kv | 9/9 | 9/9 | 1,024,613 | 558,734 | 45.5% |
| dependency-planner | 7/7 | 7/7 | 659,444 | 410,472 | 37.8% |

State was cheaper at equal quality on four of five projects. `taskboard-cli` was the exception: state used 34.5% more
input because it took 25 samples versus baseline's 11. The aggregate gain was not caused by fewer calls overall; it
came from bounded provider-visible context, while different task-level action policies happened to balance to 94
samples in each mode.

## Protocol behavior

All 94 state samples produced persisted `skill_step` transitions, all five sessions emitted `finish`, every transition
included a non-empty comment, and there were no consecutive identical actions. Two observations had error status in
`taskboard-cli`:

- one `apply_patch` targeted a nonexistent declaration file;
- one request used a stale state revision.

The model recovered from both and completed the project at 8/8. There were no action-size failures, malformed payloads,
timeouts, or non-zero CLI exits. Maximum durable state was 1,112 bytes, well below the 32 KiB cap.

## Comparison with Terra and Luna

| Model | Baseline score | State score | Baseline input | State input | State change | Samples B/S | State timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|
| GPT-5.6 Luna | 40/40 | 39/40 | 1,265,791 | 4,482,763 | +254.2% | 60/268 | 2 |
| GPT-5.6 Terra | 38/40 | 39/40 | 1,588,485 | 1,243,798 | -21.7% | 61/71 | 0 |
| GPT-5.6 Sol | 40/40 | 40/40 | 3,446,461 | 1,691,115 | -50.9% | 94/94 | 0 |

Sol is the cleanest result so far: state preserved perfect quality, completed every cell, and halved input tokens. The
comparison also reinforces that protocol efficiency is model-dependent. It does not establish a stable ranking because
each model has only one run per cell, the baseline trajectories themselves vary substantially, and the five tasks are
short.

## Interpretation limits

The pristine baseline retains upstream Codex Code Mode, while state mode forces direct atomic tools to preserve the
paper's one-patch/one-action contract. This is a practical runtime A/B, not a prompt-only ablation with identical tool
granularity. The five projects test short-task quality and crossover overhead; they do not test the paper's asymptotic
long-horizon claim. Repeated runs and controlled 25/50/100/200-step scenarios remain necessary before treating 50.9% as
an expected saving.
