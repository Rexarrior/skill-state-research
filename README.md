# SKILL.state agent-runtime research

This repository contains experimental kernel-level modifications of
[OpenCode](https://github.com/anomalyco/opencode) and [OpenAI Codex](https://github.com/openai/codex), together with
the complete artifacts from our investigation of
[SKILL.state: Scalable Long-Horizon Agent Skills](https://arxiv.org/abs/2608.26263) by Sanket Badhe, Priyanka Tiwari,
and Jonghyun Chung.

SKILL.state replaces the growing agent transcript with explicit mutable execution state. On each turn the model sees
the immutable task specification (`P`), the current structured state (`Sigma`), and a bounded window of recent action
observations (`O`). It returns an atomic `state_patch` plus one action. The runtime validates and applies the patch
before executing that action.

This implementation lives in OpenCode core rather than a plugin. The provider receives one reconstructed state
message instead of being asked to read a state file itself.

## Repository layout

- [`opencode/`](./opencode/) — a source snapshot of the modified OpenCode branch at commit `78ec9a6bb`.
- [`codex/`](./codex/) — an official Codex source snapshot plus the kernel-level SKILL.state v2 implementation.
- [`experiments/codex-skill-state/`](./experiments/codex-skill-state/) — Codex design, build, and verification notes.
- [`experiments/codex-skill-state/REPORT-gpt-5.6-luna-k3.md`](./experiments/codex-skill-state/REPORT-gpt-5.6-luna-k3.md)
  — Codex CLI benchmark, implementation defect found by the first run, corrected result, and interpretation.
- [`experiments/skill-state/`](./experiments/skill-state/) — benchmark harness, project specifications, evaluators,
  plans, reports, generated workspaces metadata, raw JSONL event logs, stderr logs, and per-run summaries.
- [`experiments/skill-state/REPORT-core.md`](./experiments/skill-state/REPORT-core.md) — implementation history and the
  main experimental narrative.
- [`experiments/skill-state/REPORT-glm-5.2-k3.md`](./experiments/skill-state/REPORT-glm-5.2-k3.md) — separate GLM-5.2
  analysis and the single-runner confirmation attempt.

## Current results

These are exploratory one-shot samples, not statistically powered measurements.

### GPT-5.6 Terra, structured observations, `k=3`

Across five code-generation projects, core SKILL.state reached **39/40** hidden checks versus **37/40** for baseline.
Provider-reported prompt tokens (`input + cache.read`) fell from **1,063,814** to **426,310**, a **59.9% reduction**.
Turns fell from 52 to 33. All five state sessions finished in-band with zero rejected transitions and no repeated
identical actions.

### GLM-5.2, structured observations, `k=3`

GLM-5.2 is **not reliable under the tested conditions**: sequential execution, at most one active OpenCode run, and a
15-minute per-cell limit. In the complete suite, baseline finished 5/5 cells while state finished 2/5, with 14 rejected
transitions and partial quality of 31/40. A second single-runner attempt again produced long provider/model calls, a
timeout, and many invalid transitions before it was stopped.

The richer observation record eliminated the earlier 74-command identical-action loop, but GLM replaced it with
non-identical repeated reads, protocol violations, or very long reasoning turns. The aggregate token reduction from
the incomplete GLM runs is not a valid efficiency win.

### Codex CLI, GPT-5.6 Luna, `k=3`

The pristine Codex baseline and state fork were built from the same upstream SHA. Baseline passed **40/40** checks;
post-fix state passed **39/40**, but used **4,482,763** input tokens versus **1,265,791**—**3.54x more**. State reduced
input per provider sample by 20.7%, yet required 268 samples versus 60 and timed out in two of five cells. The first run
also exposed an implementation bug: a 3 KiB incoming-action limit rejected ordinary code patches. The corrected kernel
accepts up to 64 KiB while keeping only a bounded 3 KiB preview in observations.

## Running the experiment

The harness expects the model providers configured for the included OpenCode snapshot.

```bash
cd opencode
bun install

# Full Terra A/B suite with three recent observations
OPENCODE_SKILL_STATE_MODEL=openai-yandex-team/gpt-5.6-terra \
OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW=3 \
bun ../experiments/skill-state/scripts/run.ts all

# Full GLM-5.2 A/B suite
OPENCODE_SKILL_STATE_MODEL=openrouter-yandex-team/z-ai/glm-5.2 \
OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW=3 \
bun ../experiments/skill-state/scripts/run.ts all
```

Each cell is independent, uses one initial user prompt, and is evaluated by black-box checks outside the model-visible
workspace. The harness runs cells sequentially and records raw events and summaries under
`experiments/skill-state/results/<suite>/`.

## Codex SKILL.state v2

The Codex fork implements the same protocol in Rust core. Every default coding turn started through `codex exec` in this
experimental fork is rebuilt as `SYSTEM + P + Sigma + O[n..n-k]`; the persisted transcript remains available for audit
and resume but is not replayed to the provider. The model can call only
`skill_step({ state_revision, state_patch, comment, action })`. Core validates and applies the patch before dispatching
one ordinary Codex tool, then stores a structured observation containing the action, input, comment, status, and bounded
result.

```bash
cd codex/codex-rs
CARGO_INCREMENTAL=0 cargo build -p codex-cli --bin codex

# k defaults to 3 and may be set from 1 through 8.
CODEX_SKILL_STATE_OBSERVATION_WINDOW=3 \
  ./target/debug/codex exec --skip-git-repo-check "Implement the requested project"
```

Code Mode is deliberately bypassed inside a state session: nesting its multi-call JavaScript loop would violate the
one-patch/one-action contract and duplicate tool schemas. The wrapper exposes the underlying atomic Codex tools instead.
See [`experiments/codex-skill-state/DESIGN.md`](./experiments/codex-skill-state/DESIGN.md) for the exact contract and
current verification status.

## Status

Research prototype. The implementations are suitable for controlled experiments, not a recommendation to replace a
production agent runtime. The results so far suggest that bounded state can reduce cost dramatically when the model
follows the protocol and terminates efficiently, while poor action policy or provider latency can erase the benefit.

The imported sources retain their upstream licenses in [`opencode/LICENSE`](./opencode/LICENSE) and
[`codex/LICENSE`](./codex/LICENSE).
