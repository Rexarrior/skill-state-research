# Original SKILL.state kernel mode

This repository keeps a separate `paper` mode for the runtime architecture described in
[SKILL.state](https://arxiv.org/html/2608.26263v2), alongside the later research `v2` mode.

## Provider-visible contract

Every provider turn contains the ordinary fixed system instructions and one reconstructed user message:

```text
Instructions:
P

Skill Execution State:
Sigma_n

Latest Observation:
O_n
```

No prior assistant response, reasoning trace, action, or older observation is replayed. The model must make exactly one
`skill_step` call with exactly two top-level fields:

```json
{
  "state_patch": {},
  "action": {
    "name": "exec_command",
    "input": {}
  }
}
```

The runtime validates and recursively merges the patch with null-deletion semantics, validates the resulting complete
coding state, persists it, executes one nested action, and exposes only that action's textual result as the next
observation. The ordinary local session transcript remains available for audit and resume, but is not model-visible.

The nested action object is the only transport adaptation from Appendix A's string action: OpenCode and Codex expose
heterogeneous typed tools rather than one domain command language. It does not add memory or another model turn.

The existing `v2` mode remains distinct: it adds a monotonic model-visible revision, an optional action comment, and a
bounded structured observation window containing action, input, status, comment, and result.

## OpenCode

From `opencode/packages/opencode`:

```bash
OPENCODE_EXPERIMENTAL_SKILL_STATE=true \
OPENCODE_EXPERIMENTAL_SKILL_STATE_MODE=paper \
bun run --conditions=browser ./src/index.ts run "Implement the requested task"
```

Use `OPENCODE_EXPERIMENTAL_SKILL_STATE_MODE=v2` for the extended protocol. Omitting the mode also selects `v2` for
backward compatibility. `OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW` has no effect in paper mode.

## Codex CLI

Build the research CLI from `codex/codex-rs`, then run:

```bash
CODEX_SKILL_STATE_MODE=paper ./target/debug/codex exec "Implement the requested task"
```

Use `CODEX_SKILL_STATE_MODE=v2` for the extended protocol. Omitting the variable selects `v2` so the existing benchmark
commands remain reproducible. Any other value fails before a session starts.

## Audit identifiers

- OpenCode persists paper transitions with `protocolVersion: 1`; v2 uses `protocolVersion: 2`.
- Codex persists paper transitions as `skill.state/paper`; v2 uses `skill.state/v2`.
- A session cannot silently adopt state written by the other protocol.
