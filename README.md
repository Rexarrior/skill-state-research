# SKILL.state agent-runtime research

This repository contains experimental kernel-level modifications of
[OpenCode](https://github.com/anomalyco/opencode) and [OpenAI Codex](https://github.com/openai/codex), together with
the complete artifacts from our investigation of
[SKILL.state: Scalable Long-Horizon Agent Skills](https://arxiv.org/abs/2608.26263) by Sanket Badhe, Priyanka Tiwari,
and Jonghyun Chung.

SKILL.state replaces the growing agent transcript with explicit mutable execution state. The original-paper mode sends
the immutable task specification (`P`), current structured state (`Sigma`), and only the latest observation (`O`). The
separate v2 mode sends a bounded structured observation window. Both return an atomic `state_patch` plus one action;
the runtime validates and applies the patch before executing that action.

Both implementations live in the OpenCode and Codex cores rather than plugins. The provider receives one
reconstructed state message instead of being asked to read a state file itself.

## Repository layout

- [`journals/`](./journals/) — consolidated research journal covering the historical OpenCode plugin, both OpenCode
  core revisions, the Codex port, cross-model results, limitations, and links to every detailed report.
- [`experiments/PAPER-ORIGINAL.md`](./experiments/PAPER-ORIGINAL.md) — original paper-mode contract and launch commands
  for both core implementations.
- [`opencode/`](./opencode/) — a source snapshot of the modified OpenCode branch at commit `78ec9a6bb`.
- [`codex/`](./codex/) — an official Codex source snapshot plus the kernel-level SKILL.state v2 implementation.
- [`experiments/codex-skill-state/`](./experiments/codex-skill-state/) — Codex design, build, and verification notes.
- [`experiments/codex-skill-state/REPORT-gpt-5.6-luna-k3.md`](./experiments/codex-skill-state/REPORT-gpt-5.6-luna-k3.md)
  — Codex CLI benchmark, implementation defect found by the first run, corrected result, and interpretation.
- [`experiments/codex-skill-state/REPORT-gpt-5.6-terra-k3.md`](./experiments/codex-skill-state/REPORT-gpt-5.6-terra-k3.md)
  — matching Codex CLI Terra benchmark and comparison with Luna.
- [`experiments/codex-skill-state/REPORT-gpt-5.6-sol-k3.md`](./experiments/codex-skill-state/REPORT-gpt-5.6-sol-k3.md)
  — matching Codex CLI Sol benchmark and three-model comparison.
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

### Codex CLI, GPT-5.6 Terra, `k=3`

Terra produced the opposite efficiency result on the same post-fix kernel: state passed **39/40** checks versus
baseline's **38/40** and reduced input tokens from **1,588,485** to **1,243,798**, a **21.7% saving**. All five state
cells emitted `finish` without timeout. State used more samples (71 versus 61), but average input per sample was 32.7%
lower. Per-project results varied from an 85.9% regression to a 73.7% saving, so this exploratory `n=1` result is not a
stable expected effect.

### Codex CLI, GPT-5.6 Sol, `k=3`

Sol delivered the cleanest Codex result so far: both baseline and state passed **40/40** checks, while state reduced
input tokens from **3,446,461** to **1,691,115**, a **50.9% saving**. Both modes used exactly 94 provider samples in
aggregate. All five state sessions emitted `finish`, no cell timed out, and the two rejected transitions were recovered.
Wall time increased by 4.1%, and state was more expensive on `taskboard-cli`, so the aggregate token win still should
not be generalized beyond this exploratory `n=1` run.

## Running the experiment

The harness expects the model providers configured for the included OpenCode snapshot.

```bash
cd opencode
bun install

# Full Terra A/B suite with three recent observations
OPENCODE_SKILL_STATE_MODEL=openai-yandex-team/gpt-5.6-terra \
OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW=3 \
bun ../experiments/skill-state/scripts/run.ts all baseline v2

# Full GLM-5.2 A/B suite
OPENCODE_SKILL_STATE_MODEL=openrouter-yandex-team/z-ai/glm-5.2 \
OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW=3 \
bun ../experiments/skill-state/scripts/run.ts all baseline v2

# Three-way comparison in one suite
bun ../experiments/skill-state/scripts/run.ts all baseline paper v2
```

Each cell is independent, uses one initial user prompt, and is evaluated by black-box checks outside the model-visible
workspace. The harness runs cells sequentially and records raw events and summaries under
`experiments/skill-state/results/<suite>/`.

## Codex SKILL.state modes

The Codex fork contains all three runtime paths in one binary. With no flag, or with
`CODEX_SKILL_STATE_MODE=baseline`, `codex exec` keeps the native transcript loop. Paper and v2 rebuild every provider
turn from state; the persisted transcript remains available for audit and resume but is not replayed to the provider.
Paper mode exposes `skill_step({ state_patch, action })` and only the latest textual result. V2 exposes
`skill_step({ state_revision, state_patch, comment, action })` and a structured observation window.

```bash
cd codex/codex-rs
CARGO_INCREMENTAL=0 cargo build -p codex-cli --bin codex

# Native transcript mode (also the default)
CODEX_SKILL_STATE_MODE=baseline \
  ./target/debug/codex exec --skip-git-repo-check "Implement the requested project"

# Original paper mode
CODEX_SKILL_STATE_MODE=paper \
  ./target/debug/codex exec --skip-git-repo-check "Implement the requested project"

# V2; k defaults to 3 and may be set from 1 through 8.
CODEX_SKILL_STATE_MODE=v2 \
CODEX_SKILL_STATE_OBSERVATION_WINDOW=3 \
  ./target/debug/codex exec --skip-git-repo-check "Implement the requested project"
```

OpenCode uses the matching `OPENCODE_SKILL_STATE_MODE=baseline|paper|v2` runtime flag and likewise defaults to
`baseline`. The older experimental OpenCode variables remain compatibility aliases for recorded runs.

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
