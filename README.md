# SKILL.state research: context engineering for coding agents

An engineering experiment inspired by
[SKILL.state: Scalable Long-Horizon Agent Skills](https://arxiv.org/abs/2608.26263).
This repository explores what happens when coding agents keep explicit execution state
instead of replaying their entire conversation on every step.

The experiment started with an idea familiar from building LLM workflows and agent loops:
give the model a compact account of where the task stands, let it update that account, and
use it to choose the next action. We adapted this approach to
[OpenCode](https://github.com/anomalyco/opencode) and [Codex](https://github.com/openai/codex),
tried several variations, and recorded both the improvements and the failures.

## Read the story

**[Статья на русском](https://articles.rexarrior.online/skill-state-in-coding-agents/)**
· **[Article in English](https://articles.rexarrior.online/skill-state-in-coding-agents/en/)**

The article walks through the implementations, benchmark results, corrections to the experiment,
and questions for further research. This repository holds the code and supporting material:

- [Research journal](./journals/README.md) — the history of the experiment and early model comparisons.
- [Journal directory](./journals/) — individual investigations, audits, and plans.
- [Article source and figures](./articles/skill-state-in-coding-agents.md).
- [What each task's checks actually test](./experiments/skill-state/CHECKS.md).

## The idea and our variations

In SKILL.state, the next model request is built from the task specification `P),
the current execution state `Σ`, and an observation `O`. The model produces a
`state_patch` together with an action. The runtime validates and applies the patch,
executes the action, and builds the next request. The complete transcript remains
available locally for analysis.

Our implementations construct this context inside the agent cores. The model receives
its state directly in the prompt.

| Mode | Context and action policy |
|---|---|
| **Native** | The agent's existing transcript-based execution loop; our baseline. |
| **Paper** | Our first core adaptation: `P + Σ` and the latest textual action result; one action per transition. |
| **Paper2** | A revised Paper observation containing the latest action, its arguments, status, and result. Still one observation and one action. |
| **V2** | A window of structured observations, usually `k=3`, plus an optional model-authored action comment and changes to the state contract. |
| **V3** | V2 with sequential action batches. The patch is applied once, and the whole batch occupies one observation slot. |

Paper and Paper2 are our interpretations of the original proposal for coding agents.
Choices such as the state schema, observation format, instruction placement, and available
tools affect the result. Their correspondence to the paper is documented in the
[initial conformance audit](./experiments/PAPER-CONFORMANCE.md) and its
[follow-up](./experiments/PAPER-CONFORMANCE-20260910.md).

The shared [Paper contract](./experiments/PAPER-ORIGINAL.md),
[V3 contract](./experiments/V3-BATCHED-ACTIONS.md), and
[Paper2 protocol](./experiments/codex-paper2-20260910/PROTOCOL.md) describe the details.
Paper2 was tested on Codex; its experimental kernel patch is preserved with that campaign.

## What we tested

Five small projects, each built from a single initial prompt in a fresh workspace:

- [Taskboard CLI](./experiments/skill-state/projects/taskboard-cli/SPEC.md)
- [CSV Insights](./experiments/skill-state/projects/csv-insights/SPEC.md)
- [Mini Template](./experiments/skill-state/projects/mini-template/SPEC.md)
- [HTTP key-value service](./experiments/skill-state/projects/http-kv/SPEC.md)
- [Dependency Planner](./experiments/skill-state/projects/dependency-planner/SPEC.md)

The external [evaluator](./experiments/skill-state/scripts/evaluate.ts) assigns up to
40 checks across the five projects. Reports distinguish code passing checks from an
agent successfully finishing its session. They also record input tokens, model calls,
elapsed time, protocol errors, and timeouts.

The article covers **820 final run outcomes across multiple campaigns**: initial
OpenCode/Codex comparisons, repeated Codex runs, runs without global skills, larger
state/observation limits, and Paper2 with both large and small limits. Five externally
interrupted attempts are disclosed separately. Early GLM-5.2 and Luna pilots are
documented in the journal and excluded from that article total.

These are repeated measurements on **five task specifications**. Models and runtime
conditions changed between campaigns, so the results should be read within each campaign.

## What emerged

- **V2 gave promising results on Sol.** In the ten-repeat Codex comparison it used
  49.7% less main-loop input than Native, with 48/50 fully successful sessions versus
  49/50. Later campaigns also showed input savings, with some differences in success rates.
- **Observation limits changed the picture on Astra.** Native was more efficient with
  the earlier small limits. With expanded limits and a fix to transition persistence,
  V2 and V3 used 2.9% and 14.4% less input respectively; all three modes achieved
  25/25 fully successful sessions.
- **Batching did not consistently help.** V3 used more tokens and more model calls than
  V2 in the ten-repeat Sol comparison. Its later results depended on the model and limits.
- **A more informative last observation mattered.** Paper2 improved substantially over
  Paper with large limits. Returning to small limits brought back severe completion
  problems, especially on Astra.

Shorter individual requests can be outweighed by extra model calls, repeated work, or
failure to finish. Input-token savings also do not directly establish monetary savings:
cached input, output, reasoning, and auxiliary calls need separate accounting.
See the [token-accounting correction](./journals/TOKEN-ACCOUNTING-CORRECTION.md).

These observations motivate further experiments. The current campaigns do not isolate
every change: tool interfaces, context limits, and implementation fixes can interact.
The [scientific follow-up plan](./journals/RESEARCH-ARTICLE-PLAN.md) lays out broader
tasks and controlled ablations to separate those effects.

## Follow the evidence

| Stage | Journal or report |
|---|---|
| Early plugin, core adaptations, GLM/Luna/Terra/Sol pilots | [Research journal](./journals/README.md) |
| First article campaign on OpenCode and Codex | [Journal](./journals/ARTICLE-20260904.md) · [Report](./experiments/article-20260904/REPORT.md) |
| V3 implementation and early comparisons | [V3 journal](./journals/V3-BATCHED-ACTIONS.md) |
| Ten-repeat Codex/Sol comparison | [V2/V3 report](./experiments/codex-sol-repeats-20260906/REPORT.md) · [Native/Paper report](./experiments/codex-sol-controls-20260906/REPORT.md) |
| Codex runs without global skills | [Journal](./journals/CODEX-CLEAN-20260908.md) · [Sol](./experiments/codex-clean-comparison-20260908/REPORT-sol.md) · [Astra](./experiments/codex-clean-comparison-20260908/REPORT-astra.md) |
| Expanded context limits | [Sol journal](./journals/CODEX-SOL-LARGE-CONTEXT-20260909.md) · [Astra journal](./journals/CODEX-ASTRA-LARGE-CONTEXT-20260908.md) · [Reports and data](./experiments/codex-large-context-comparison-20260909/) |
| Paper2 with large limits | [Protocol, report, and data](./experiments/codex-paper2-20260910/) |
| Paper2 with small limits | [Report](./experiments/codex-paper2-small-context-20260910/REPORT.md) |

Dated journals and reports preserve the state of knowledge at the time they were written.
The article brings those stages together, including later audits and corrections.

## Explore or reproduce

- [`opencode/`](./opencode/) and [`codex/`](./codex/) contain the modified agent sources.
- [OpenCode experiment instructions](./experiments/skill-state/README.md) describe the harness and runtime modes.
- [Codex implementation and build notes](./experiments/codex-skill-state/README.md) cover the CLI experiments.
- Campaign directories contain their protocols, configuration, source manifests or patches,
  per-run results, and aggregation scripts.
- [`archives/`](./archives/README.md) contains compressed raw experiment logs and restoration instructions.

Model/provider configuration must be supplied locally. To reproduce a particular campaign,
use its recorded source version, configuration, and evaluator; the main source tree alone
does not identify every historical setup. Build outputs and installed dependencies have
been removed to keep the working copy small and need to be recreated before running.

The imported agent sources retain their upstream licenses:
[OpenCode](./opencode/LICENSE) and [Codex](./codex/LICENSE).
