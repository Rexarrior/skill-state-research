# Codex SKILL.state v2 experiment

This directory documents the Codex implementation of the state-based agent loop proposed in
[SKILL.state](https://arxiv.org/abs/2608.26263) and refined using the practical cautions in the
[Apex engineering report](https://github.com/runapex/apex-router/blob/main/docs/DESIGN-skill-state.md).

The implementation is a core modification, not a skill or plugin. The complete official Codex source snapshot lives in
[`../../codex/`](../../codex/); its exact upstream revision is recorded in
[`../../codex/UPSTREAM.md`](../../codex/UPSTREAM.md).

## Current status

- The same binary provides three runtime modes: `baseline` keeps the native transcript loop, `paper` implements the
  original `P + Sigma + latest O` protocol, and `v2` retains the structured `k`-observation extension. See
  [`../PAPER-ORIGINAL.md`](../PAPER-ORIGINAL.md).
- Kernel state schema, patch validation, monotonic revisions, atomic tool dispatch, bounded observations, finish action,
  persistence, and resume reconstruction are implemented.
- Action requests may be up to 64 KiB; only a bounded 3 KiB preview is retained in the observation. This distinction was
  added after the first benchmark exposed rejected normal-size code patches.
- `codex exec` defaults to `baseline`; select a mode with `CODEX_SKILL_STATE_MODE=baseline|paper|v2`.
- Observation window `k` defaults to 3 and is configurable with `CODEX_SKILL_STATE_OBSERVATION_WINDOW=1..8`.
- Focused core and end-to-end `codex exec` tests cover native baseline, v2, and paper mode.
- The GPT-5.6 Luna `k=3` CLI benchmark is complete. Baseline scored 40/40 and state scored 39/40, but state consumed
  3.54x more input tokens because provider samples increased 4.47x. See
  [`REPORT-gpt-5.6-luna-k3.md`](./REPORT-gpt-5.6-luna-k3.md).
- The matching GPT-5.6 Terra run favored state: 39/40 versus baseline's 38/40 with 21.7% fewer input tokens. All five
  state cells finished without timeout. See [`REPORT-gpt-5.6-terra-k3.md`](./REPORT-gpt-5.6-terra-k3.md).
- GPT-5.6 Sol produced the strongest clean result so far: both modes scored 40/40, while state used 50.9% fewer input
  tokens. Both modes used 94 provider samples in aggregate, and all cells finished without timeout. See
  [`REPORT-gpt-5.6-sol-k3.md`](./REPORT-gpt-5.6-sol-k3.md).

## Build

```bash
cd ../../codex/codex-rs
CARGO_INCREMENTAL=0 cargo build -p codex-cli --bin codex
```

The resulting executable is `codex/codex-rs/target/debug/codex` relative to the repository root. It retains the normal
Codex CLI name; this research branch and its recorded upstream revision identify the variant.

## Focused verification

```bash
cd ../../codex/codex-rs
CARGO_INCREMENTAL=0 just test -p codex-core --lib -E 'test(~skill_state)'
CARGO_INCREMENTAL=0 just test -p codex-exec --test all -E 'test(~skill_state_v2)'
```

The integration test uses a loopback mock Responses API, so a restricted environment must permit binding a local port.

## CLI benchmark

The runner reuses the five OpenCode one-shot specifications and their black-box evaluator. By default every mode uses
the same research binary, so the runtime flag is the only implementation switch. It saves external CLI events plus the
persisted rollout for audit and runs no more than two cells concurrently:

```bash
cd ../..
CODEX_SKILL_STATE_MODEL=gpt-5.6-luna \
CODEX_SKILL_STATE_OBSERVATION_WINDOW=3 \
bun experiments/codex-skill-state/scripts/run.ts all baseline v2

# Include the exact paper contract in the same suite.
bun experiments/codex-skill-state/scripts/run.ts all baseline paper v2
```

Run `doctor`, `pair PROJECT [paper|v2]`, or `one PROJECT MODE` in place of `all` for setup checks and smaller probes.
Calling `all` without mode arguments retains the historical baseline/v2 default. `CODEX_BASELINE_BINARY` and
`CODEX_BASELINE_SOURCE` may still point baseline at a pristine binary when reproducing older cross-binary reports.
After a kernel change, `state-all BASELINE_SUITE` runs only the five v2 cells and builds a combined report from an
already valid, unchanged baseline suite. Results are written below `experiments/codex-skill-state/results/<suite>/`. The short-project
A/B should eventually be complemented with controlled 25/50/100/200-step scenarios to measure the asymptotic claim
independently of code-generation quality.

The canonical mode arguments are `baseline`, `paper`, and `v2`; the legacy names `skill-state-paper` and `skill-state`
remain accepted so historical commands stay reproducible.

When `CODEX_BASELINE_BINARY` selects a separate baseline, that CLI must support `--approve-for-me`; `doctor` rejects
older installed releases that cannot use the same sandboxed non-interactive contract. For the recorded Luna run, the
pristine CLI was built from the exact SHA in `codex/UPSTREAM.md`, and the application-provided `codex-code-mode-host`
was placed beside it.
