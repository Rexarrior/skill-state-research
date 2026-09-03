# Core SKILL.state execution mode

Status: core experimental slice and structured observation-window revision implemented and live-smoke tested.

This document specifies a core OpenCode execution mode based on SKILL.state. It replaces the experimental plugin
prototype with a durable runtime contract. The target is the paper's model-owned transition protocol, not merely a
bounded-context approximation.

References:

- [SKILL.state paper](https://arxiv.org/html/2608.26263v2)
- [Apex engineering report](https://github.com/runapex/apex-router/blob/main/docs/DESIGN-skill-state.md)
- [First OpenCode plugin experiment](./REPORT.md)

## Decision

Implement SKILL.state as an experimental execution path in OpenCode core. The experiment runner selects either this
path or the existing transcript/ReAct path for A/B runs. The scope ends at implementation, verification, and measured
results; rollout and compatibility machinery are not part of this experiment.

The model must own each state transition. Every step produces a patch and exactly one action. The runtime validates the
complete transition, applies the patch, and only then executes the action. Runtime-owned state is useful for other
workflows, but it does not test the protocol in the paper and is outside this implementation.

## Motivation and evidence

The plugin experiment bounded the per-turn prompt but failed to enforce the transition protocol. GLM-5.2 made 315
ordinary tool calls and only eight state calls, and the task specification disappeared after its transient `read`
observation. This caused repeated reads, 5/40 hidden checks, and more total tokens despite a lower average prompt size.

The Apex report adds several constraints to the design:

- At roughly four steps, resending structured state was 102-142% of transcript cost for frontier models. Short-task
  overhead is expected and must not be hidden by aggregate reporting.
- A large fixed system prompt and tool schemas can dominate marginal context savings. Fixed and growing token costs must
  be reported separately.
- Patch-only updates structurally prevent premature full-state overwrite, one of the main open-weight model failure
  modes reported by the paper.
- The runtime must validate unknown fields, types, protected deletions, and the resulting full state before acting.
- The same fragment must not be copied automatically into both state and the latest observation.
- Benchmarks must be fail-closed: opaque answers, neutral working directories, no unrelated tools, independent
  environments per arm, and verdict logic pinned by tests.
- The asymptotic claim requires long controlled horizons. Five one-shot codegen tasks alone cannot establish the
  expected O(T) versus O(T^2) behavior.

## Protocol

At provider turn `t`, the model receives only:

```text
Instructions:
{P}

Skill Execution State:
{Sigma_t}

Recent Observations (oldest to newest, maximum k):
[{O_(t-k+1)}, ..., {O_t}]
```

Where:

- `P` is an immutable, materialized specification containing the task, applicable ambient instructions, environment
  rules, and action space.
- `Sigma_t` is the complete validated execution state.
- `k` is the configured number of observations, clamped to 1-8; the experiment defaults to 3.
- `O_t` contains the action name and input, the optional model-authored action comment, final action status, and result.
  `O_0` is an explicit initialization marker.

Historical reasoning, assistant text, actions, and observations are stored for audit/UI but never sent back to the
model. The builder extracts the first user specification, latest completed state revision, and latest tool observation,
then constructs a fresh single user message instead of converting the transcript to provider messages.

The model emits reasoning plus one mandatory transition:

```json
{
  "state_patch": {},
  "comment": "Explain why this action is useful and what evidence it should produce.",
  "action": {
    "name": "write",
    "input": {}
  }
}
```

Completion is an action rather than an out-of-band natural-language response:

```json
{
  "state_patch": {},
  "action": {
    "name": "finish",
    "input": {
      "message": "Implementation complete and tests pass."
    }
  }
}
```

OpenCode will transport this envelope as one required core `skill_step` tool call. This is a provider-facing adaptation
of the paper's JSON block, not an independently executable state tool. The model never receives ordinary action tools
alongside it.

## Immutable specification

The core runtime materializes `P` before the first provider call:

1. Resolve the initial user text and textual attachments.
2. Resolve applicable repository and agent instructions as system content.
3. Add the protocol, current state, latest observation, and the nested action schema.

The experiment runner uses the existing attachment path:

```text
OPENCODE_SKILL_STATE_MODE=v2 opencode run --file /path/to/SPEC.md "Implement the project"
```

OpenCode resolves `--file` into textual prompt parts before the agent loop. The model receives the attached contents in
`P`; it is never instructed to open a state or specification file itself. The same binary also exposes the native loop
with `OPENCODE_SKILL_STATE_MODE=baseline` and the article-exact variant with `OPENCODE_SKILL_STATE_MODE=paper`.

## State and persistence

Each completed `skill_step` stores protocol version, revision, patch, full resulting state, action, optional comment,
action status, and state size in the existing tool-part metadata. This keeps the experiment inspectable and recoverable
from OpenCode's normal session transcript without adding tables or migrations. The latest completed transition is
authoritative; pending or invalid transitions do not advance state. Protocol-v1 sessions remain auditable but fail
closed when resumed by the incompatible v2 state schema.

The v2 coding state contains `status`, `plan`, `completed`, `files`, `facts`, `decisions`, and `next_action`.
`verification` is deliberately not a separate durable field. Recent checks remain visible in the observation window;
when evidence must outlive that window, the model preserves a compact conclusion in `facts` or `completed` on the next
transition after observing the result.

Patch semantics are recursive JSON merge with null deletion. The model can emit only a patch, never a replacement full
state. Validation applies to both the patch policy and `state_after`:

- reject unknown fields when the schema closes the object;
- reject wrong types and invalid enum values;
- reject deletion of schema-required or explicitly protected fields;
- reject prototype-pollution keys;
- reject states above `max_state_bytes`;
- never log raw state in telemetry that may leave the machine.

Core ships one conservative coding-state schema for this experiment. Custom domain schemas are deliberately deferred
until the protocol and measurements justify the additional surface.

## Atomic transition and action dispatch

The AI SDK must not automatically execute `skill_step` while the response is still streaming. Core buffers the complete
provider turn and enforces this order:

1. Require exactly one `skill_step` call.
2. Validate the envelope and require both `state_patch` and `action`.
3. Compute and validate `state_after`.
4. Resolve and validate the named action and its arguments.
5. Persist the new state revision in tool metadata with `pending` action status.
6. Execute exactly one action through the existing OpenCode permission/tool machinery.
7. Complete the same tool part with success/error metadata and use its output as the next observation.

No action runs when steps 1-4 fail. Once step 5 succeeds, an action failure does not roll the state back; the failure is
the new observation and the model must respond to it on the next turn. The existing serial session loop prevents two
transitions from claiming the same revision.

Existing resolved tools provide both the descriptions/input schemas used to build the nested action union and the
executors used by the deferred core dispatcher. Permissions are filtered before schema construction; existing hooks,
truncation, attachments, abort signals, snapshots, and UI events remain on the ordinary tool path.

`finish` is handled by core: apply its patch, publish its message as visible assistant output, and stop the loop.

## Prompt bounds and non-duplication

The prompt is bounded by immutable `P`, the action schema, `Sigma_t`, and at most `k` recent observations. Compaction is
disabled in this mode because no transcript is replayed. Action input and result fields are deterministically truncated
before serialization; truncated action inputs retain their original byte count, SHA-256 digest, and a preview.

Core never promotes action output into state automatically. A result first appears as `O_t`; on the next transition the
model may preserve only the durable facts it needs in its patch. The observation leaves the prompt when it falls out of
the configured window. This prevents the Apex bug where a runtime-owned fragment map was sent in both `Sigma` and `O`.

The harness records provider usage and state bytes on every completed transition. More detailed overlap diagnostics can
be added after the first benchmark if duplication appears in real traces.

## Errors and lifecycle

| Condition                                  | State change               | Action            | Next behavior                           |
| ------------------------------------------ | -------------------------- | ----------------- | --------------------------------------- |
| Invalid envelope or duplicate `skill_step` | None                       | Not run           | Protocol-error observation/retry budget |
| Invalid patch or resulting state           | None                       | Not run           | Validation observation/retry budget     |
| Unknown action or invalid arguments        | None                       | Not run           | Validation observation/retry budget     |
| Permission denied                          | Applied                    | Denied            | Denial becomes latest observation       |
| Action failure                             | Applied                    | Failed            | Error becomes latest observation        |
| Process interruption after persistence     | Pending transition ignored | Interrupted       | Resume from last completed revision     |
| `finish`                                   | Applied                    | Core finalization | Publish answer and stop                 |

The first implementation covers one initial task specification and a serial agent loop. Interactive steering,
branch/revert semantics for state epochs, and custom schemas are outside this benchmark slice.

## Core integration plan

1. **Core runtime — implemented**
   - Add the internal experiment selector and the fixed coding-state schema.
   - Build one provider message from `P`, `Sigma`, and `O`; skip transcript replay, reminders, summaries, and compaction.
2. **Structured transition — implemented**
   - Expose only required `skill_step`, buffer the provider turn, validate the patch/resulting state, then dispatch one
     nested action.
   - Reject zero, duplicate, malformed, or mixed calls before action execution.
3. **Lifecycle — implemented for the benchmark**
   - Store transition metadata on tool parts, surface action errors as observations, support `finish`, propagate abort,
     and record action file patches.
4. **Prototype removal — implemented**
   - Remove `packages/plugin-skill-state`; retain its report as historical evidence.
5. **Verification — in progress**
   - Maintain unit and provider-request integration tests and run live GLM-5.2 smoke sessions.
6. **Benchmarks — next**
   - Run the five-project codegen comparison and add controlled 25/50/100/200-step scenarios.
7. **Structured observation window — implemented after the first Terra suite**
   - Replace result-only `O_t` with bounded action/comment/status/result records, retain the latest `k` records, and
     remove `verification` from durable state.

## Test plan

Unit tests:

- merge and null-deletion semantics;
- protected deletions, unknown fields, types, and size bounds;
- prototype-pollution rejection;
- action union and argument validation;
- state size bound and transition metadata.

Core integration tests:

- outbound prompt contains exactly `P`, `Sigma_t`, and the latest `k` structured observations plus fixed system/schema
  content;
- prior reasoning, assistant text, actions, and observations are absent;
- specification content is identical on every turn;
- empty successful actions remain identifiable by their exact action and input;
- observation eviction, action/result truncation, comments, and protocol-error records are correct;
- exactly one transition produces exactly one action;
- pending transition metadata is written before action execution;
- malformed or duplicate transitions execute nothing;
- permissions, action errors, abort, finish, snapshots, and resume from the last completed transition are correct;
- AI SDK and native provider runtimes expose the same behavior.

Recorded traces must assert the provider-bound request, not only an earlier internal representation.

## Benchmark program

### A. Short real codegen suite

Re-run the five existing projects with GLM-5.2 against stock OpenCode and core SKILL.state. Use at least three repetitions
per cell when cost permits; report every run and confidence intervals instead of selecting successful samples.

For state runs, pass `SPEC.md` from outside the agent workspace through the existing `--file` attachment. The run
directory must not contain the specification or hidden evaluators. OpenCode materializes the attachment before the
agent loop, so the model does not need a bootstrap file read.

Measure:

- hidden checks and completion rate;
- provider turns and action count;
- protocol/validation failures;
- prompt input, cache read/write, output, and reasoning tokens;
- wall time and billed cost;
- state and observation sizes by turn.

Short-task token overhead is not by itself a failed result. Quality must be comparable before any token comparison is
interpreted.

### B. Controlled long-horizon suite

Add deterministic environments at 25, 50, 100, and 200 required steps. Each arm receives the same task information and
observations, and the evaluator requires every step so the model cannot save tokens by stopping early.

Report:

- cumulative provider-reported tokens by step;
- raw serialized request bytes by step;
- fixed prompt floor versus growing transcript/state components;
- per-step prompt size and total billed tokens, with cache reads shown separately;
- fitted growth curves and observed transcript/state crossover point;
- correctness and protocol failures at each horizon.

The central asymptotic claim is supported only if transcript cumulative input grows superlinearly while state cumulative
input remains approximately linear at comparable correctness.

### C. Robustness suite

Add no-alert drift, multiple drift, and distractor-noise variants. Use opaque unguessable values, a fresh environment per
arm, and four explicit outcomes: recovered, anchored, mixed, and neither. Verdict extraction is scoped to the answer
record and carries a low-confidence marker when it must fall back to whole-answer matching.

### Harness safeguards

- Run from a neutral directory with a fail-closed action allowlist.
- Keep answers and evaluator logic outside model-visible paths.
- Use independent mutable environments for baseline and state arms.
- Pin opaque fixtures and verdict behavior with tests.
- Count actual provider requests and usage, not estimated message counts.
- Record model, provider, tool schema hash, system/specification hash, cache policy, and horizon.
- Never infer savings from runs with different correctness or early termination.

## Acceptance criteria

Implementation acceptance:

- 100% of executed actions have one validated preceding patch in the same transition;
- zero direct action-tool calls bypass `skill_step`;
- provider-request tests prove stable `P` and absence of replayed history;
- a live GLM-5.2 session completes successive write, read, and finish revisions through `skill_step`;
- the five-project aggregate reaches at least the existing 32/40 baseline before token savings are claimed;
- all package tests, typechecks, formatting, and generated-client checks pass.

A correct implementation may still be uneconomical for short sessions; that outcome is expected and must be reported
plainly.
