# Codex SKILL.state v2 experiment

This directory documents the Codex implementation of the state-based agent loop proposed in
[SKILL.state](https://arxiv.org/abs/2608.26263) and refined using the practical cautions in the
[Apex engineering report](https://github.com/runapex/apex-router/blob/main/docs/DESIGN-skill-state.md).

The implementation is a core modification, not a skill or plugin. The complete official Codex source snapshot lives in
[`../../codex/`](../../codex/); its exact upstream revision is recorded in
[`../../codex/UPSTREAM.md`](../../codex/UPSTREAM.md).

## Current status

- Kernel state schema, patch validation, monotonic revisions, atomic tool dispatch, bounded observations, finish action,
  persistence, and resume reconstruction are implemented.
- Action requests may be up to 64 KiB; only a bounded 3 KiB preview is retained in the observation. This distinction was
  added after the first benchmark exposed rejected normal-size code patches.
- `codex exec` in this fork enters state mode directly; there is no feature toggle in this experimental branch.
- Observation window `k` defaults to 3 and is configurable with `CODEX_SKILL_STATE_OBSERVATION_WINDOW=1..8`.
- Five focused core tests and one two-step end-to-end `codex exec` test cover the protocol.
- The GPT-5.6 Luna `k=3` CLI benchmark is complete. Baseline scored 40/40 and state scored 39/40, but state consumed
  3.54x more input tokens because provider samples increased 4.47x. See
  [`REPORT-gpt-5.6-luna-k3.md`](./REPORT-gpt-5.6-luna-k3.md).
- The matching GPT-5.6 Terra run favored state: 39/40 versus baseline's 38/40 with 21.7% fewer input tokens. All five
  state cells finished without timeout. See [`REPORT-gpt-5.6-terra-k3.md`](./REPORT-gpt-5.6-terra-k3.md).

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

The runner reuses the five OpenCode one-shot specifications and their black-box evaluator. It compares an installed
official Codex CLI baseline with this state build, saves external CLI events plus the persisted rollout for audit, and
runs no more than two cells concurrently:

```bash
cd ../..
CODEX_SKILL_STATE_MODEL=gpt-5.6-luna \
CODEX_SKILL_STATE_OBSERVATION_WINDOW=3 \
CODEX_BASELINE_BINARY=/path/to/pristine/codex \
CODEX_BASELINE_SOURCE='pristine upstream revision from ../../codex/UPSTREAM.md' \
bun experiments/codex-skill-state/scripts/run.ts all
```

Run `doctor`, `pair PROJECT`, or `one PROJECT MODE` in place of `all` for setup checks and smaller probes. After a kernel
change, `state-all BASELINE_SUITE` runs only the five state cells and builds a combined report from an already valid,
unchanged baseline suite. Results are written below `experiments/codex-skill-state/results/<suite>/`. The short-project
A/B should eventually be complemented with controlled 25/50/100/200-step scenarios to measure the asymptotic claim
independently of code-generation quality.

The baseline CLI must support `--approve-for-me`; `doctor` rejects older installed releases that cannot use the same
sandboxed non-interactive contract. For the recorded Luna run, the pristine CLI was built from the exact SHA in
`codex/UPSTREAM.md`, and the application-provided `codex-code-mode-host` was placed beside it.
