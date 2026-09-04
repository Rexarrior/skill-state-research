# OpenCode v3 batched-actions benchmark (`k=3`)

This report compares the native OpenCode transcript loop (`baseline`), the single-action bounded-state protocol (`v2`),
and the sequential batched-actions protocol (`v3`). Each model ran five independent greenfield tasks from one initial
prompt. Hidden evaluators were outside the model-visible workspace. Runs were sequential, with a 15-minute cell limit.

## GPT-5.6 Sol

Valid suite: [`20260904T015621Z`](./results/20260904T015621Z/report.md). All 15 cells exited zero without timeout.

| Mode | Hidden checks | Prompt tokens | Turns | Change from baseline |
|---|---:|---:|---:|---:|
| Baseline | 40/40 | 1,515,899 | 64 | — |
| V2 | 40/40 | 532,003 | 40 | -64.9% |
| V3 | 40/40 | 609,763 | 45 | -59.8% |

V3 executed 78 inner actions in 45 batch observations. Nineteen batches contained multiple actions and the largest
contained five. It preserved perfect quality and was much cheaper than baseline, but consumed 14.6% more prompt tokens
than v2 because it used five more provider turns. Per-project behavior varied: v3 needed only 7 turns versus v2's 12
on `http-kv`, but 12 versus 5 on `taskboard-cli`.

## GPT-5.6 Terra

Valid suite: [`20260904T023009Z`](./results/20260904T023009Z/report.md). All 15 cells exited zero without timeout.

| Mode | Hidden checks | Prompt tokens | Turns | Change from baseline |
|---|---:|---:|---:|---:|
| Baseline | 38/40 | 1,401,206 | 63 | — |
| V2 | 40/40 | 380,139 | 30 | -72.9% |
| V3 | 39/40 | 655,543 | 48 | -53.2% |

V3 executed 81 actions in 48 batch observations: 22 multi-action batches, maximum length seven. It improved baseline
quality by one check and cut prompt tokens by 53.2%, but v2 was both more accurate and 42.0% cheaper than v3. The one
v3 failure was the `mini-template` current-item lookup check; the same defect appeared in the independent v3 pilot.

## Interpretation

The unlimited array did not produce abusive batch sizes: observed maxima were five (Sol) and seven (Terra). The harder
problem was policy. V3 only saves provider turns when the model actually groups independent known-input actions. On
these short OpenCode tasks both models often continued to emit singleton or small batches, and v2 remained the stronger
aggregate. This is exploratory `n=1`; the result does not establish stable ranking.
