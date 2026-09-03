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
- `codex exec` in this fork enters state mode directly; there is no feature toggle in this experimental branch.
- Observation window `k` defaults to 3 and is configurable with `CODEX_SKILL_STATE_OBSERVATION_WINDOW=1..8`.
- Five focused core tests and one two-step end-to-end `codex exec` test cover the protocol.
- A full Codex benchmark has not yet been run. Existing OpenCode results are not evidence about the Codex fork.

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

## Next experiment

Port the existing five one-shot project fixtures to a Codex runner, retain black-box evaluation, and record raw JSONL,
stderr, provider usage, transitions, elapsed time, and termination reason per cell. Run no more than two cells
concurrently. Compare transcript baseline from an unmodified binary with this state binary at `k=3`, then add controlled
25/50/100/200-step scenarios to measure the asymptotic claim independently of short code-generation quality.
