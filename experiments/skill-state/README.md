# GLM-5.2 one-shot A/B experiment

> [!IMPORTANT]
> This directory's first plugin run is a historical, non-faithful approximation of SKILL.state. The replacement core
> runtime is specified in [DESIGN-core-skill-state.md](./DESIGN-core-skill-state.md).

The first core implementation run, transition-level GLM analysis, and full GPT-5.6 Terra benchmark are in
[REPORT-core.md](./REPORT-core.md).

This experiment compares stock OpenCode context replay with the core `SKILL.state` runtime on five independent
greenfield coding tasks. Each run receives exactly one user message. OpenCode materializes the task specification from
an external attachment before the first model turn; `SPEC.md` is not present in the agent workspace.

## Design

- Core protocol: `OPENCODE_EXPERIMENTAL_SKILL_STATE_MODE=v2` selects the existing extension;
  `OPENCODE_EXPERIMENTAL_SKILL_STATE_MODE=paper` selects the original `P + Sigma + latest O` architecture. See
  [`../PAPER-ORIGINAL.md`](../PAPER-ORIGINAL.md).
- Model: `openrouter-yandex-team/z-ai/glm-5.2`
- Prompt: `Implement the project described in the attached specification. Work autonomously until the implementation is complete and all available tests pass. Do not ask questions. Stay inside the project directory.`
- Modes: `baseline` (transcript replay) and `skill-state` (core `P + Sigma + O[n-k+1..n]` runtime)
- State observation window: `k=3` by default, configurable with
  `OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW` (1-8)
- Maximum agent iterations: 80
- Network, subagents, questions, and access outside the run directory are denied
- Runs are sequential and mode order alternates by project
- Evaluation is black-box and kept outside the model's run directory

This is an exploratory `n=1` comparison per project, not a statistically powered benchmark.

## Commands

Validate the harness without calling a model:

```sh
bun experiments/skill-state/scripts/run.ts doctor
```

Run the full suite:

```sh
bun experiments/skill-state/scripts/run.ts all
```

Run one cell:

```sh
bun experiments/skill-state/scripts/run.ts one taskboard-cli baseline
bun experiments/skill-state/scripts/run.ts one taskboard-cli skill-state-paper
```

Results are written to `experiments/skill-state/results/<suite-id>/`. Workspaces are created under the system
temporary directory so the hidden evaluators and the other implementations are not visible to the model.
