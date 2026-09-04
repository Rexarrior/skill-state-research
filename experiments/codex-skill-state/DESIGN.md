# Codex kernel design: SKILL.state v2 and v3

This document describes the extended v2 protocol. The same core now also contains the isolated original-paper mode
documented in [`../PAPER-ORIGINAL.md`](../PAPER-ORIGINAL.md); the two provider contracts are selected explicitly and do
not share model-visible transition fields.

The compiled CLI also retains the upstream transcript loop. `CODEX_SKILL_STATE_MODE=baseline|paper|v2|v3` selects the
runtime path, and an unset variable is equivalent to `baseline`. V3's action-batch contract is shared with OpenCode and
documented in [`../V3-BATCHED-ACTIONS.md`](../V3-BATCHED-ACTIONS.md).

## Goal

Test the paper's actual runtime contract in Codex without asking the model to read or maintain an external state file.
Codex core owns prompt construction, state validation, persistence, and action dispatch.

## Provider-visible turn

Each sampling request contains the ordinary immutable Codex system instructions, one reconstructed user message, and one
model-visible tool:

```text
SYSTEM
  Codex environment, repository instructions, MCP and skill instructions

USER
  protocol instructions
  P: immutable original task and fixed non-assistant input
  Sigma_n: complete structured execution state and revision
  O[n..n-k]: oldest-to-newest structured recent observations

TOOLS
  skill_step({ state_revision, state_patch, comment?, action })
```

Previous assistant reasoning, tool calls, tool outputs, and messages are not included in the provider-visible conversation.
Codex still persists them locally for audit and resume.

Responses Lite may encode the tool declaration as an `AdditionalTools` developer transport item. This is a wire-format
detail: the conversational input remains the one reconstructed user message, and `skill_step` remains the only callable
tool.

## State and patch

`Sigma` is bounded to 32 KiB and has this schema:

```json
{
  "status": "working | blocked | done",
  "plan": [],
  "completed": [],
  "files": {},
  "facts": [],
  "decisions": [],
  "next_action": ""
}
```

The model may supply only a partial patch. Unknown fields are rejected. The runtime applies the patch to the current
snapshot, validates the resulting complete state, advances a monotonic revision, and only then dispatches the action.
A stale revision is rejected without executing anything. `done` is accepted only together with `finish`.

## Observation v2

An observation is not just tool output:

```json
{
  "revision": 7,
  "action": "exec_command",
  "input": {"cmd": "cargo test"},
  "comment": "Verify the parser after the edit.",
  "status": "success | error",
  "result": "...bounded tool result..."
}
```

The next request receives the last `k` observations, with `k=3` by default and a hard range of 1 through 8. Result text
is capped at 4 KiB, the action-input representation retained in an observation at 3 KiB, and comment at 1 KiB. The
runtime accepts an action request up to 64 KiB so code-generation patches are executable; when it is larger than the
observation budget, `O` contains its size and a bounded preview. The original full call remains in the local rollout for
audit. Durable conclusions belong in `Sigma`; observations are short-term action memory. The same fragment is not
separately copied into state by the runtime.

## Atomic action contract

The wrapper schema is generated from the current ordinary Codex tool plan. Function, freeform, and namespace tools are
represented as mutually exclusive action variants; `finish` is added by the state runtime. Hosted web-search and deferred
tool-search specs are currently excluded because they do not map to the same client-dispatched atomic path.

State sessions force Codex's direct tool mode. Code Mode's `exec` is itself a multi-tool agent loop, so nesting it would
break one-patch/one-action atomicity and expand every wrapper schema with a second tool catalogue.

V3 changes that contract at the outer kernel boundary: the model returns `actions[]` with no count limit, the runtime
pre-validates every member, applies one patch, and dispatches members strictly sequentially. An error stops the batch,
remaining members are recorded as skipped, and the whole batch occupies one observation-window slot. Later members may
not depend on results the model has not seen yet.

## Persistence and recovery

Every accepted or rejected transition is serialized into the normal Codex rollout as the `skill_step` function output.
It includes the full resulting state and structured observation. On every provider request and after resume, core scans
the persisted rollout and reconstructs the latest valid snapshot. The model never has to read a sidecar file.

## Apex findings incorporated

- The model emits only a patch; it cannot overwrite the state envelope.
- Unknown fields, stale revisions, forbidden `done`, size limits, and the resulting full state are validated before an
  action is executed.
- Action and result are represented once in `O`; the runtime does not duplicate them into `Sigma`.
- Evaluation separates short real code-generation projects from controlled long horizons.

Unlike Apex's runtime-owned frontier map, this implementation keeps the article's model-owned `state_patch + action`
contract.

## Known limitations

- The current fork changes `codex exec`; the interactive TUI still uses the upstream transcript loop.
- Images and audio in the immutable task are represented by omission markers rather than replayed binary payloads.
- V2 replaces individual collection fields; paper mode recursively merges dictionaries and supports `null` deletion,
  but neither mode implements RFC 6902 JSON Patch operations.
- Tool schema size is still a fixed per-turn cost and may dominate short tasks.
- No Codex A/B benchmark results exist yet for paper mode.
