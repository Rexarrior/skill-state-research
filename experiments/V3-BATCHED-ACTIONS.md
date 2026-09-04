# SKILL.state v3: sequential action batches

V3 is an experimental extension of the repository's v2 protocol. It keeps the same kernel-level bounded-context
runtime, but allows the model to submit more than one action in a provider turn:

```json
{
  "state_revision": 7,
  "state_patch": { "next_action": "Inspect the batch results" },
  "comment": "Create the known files, then run independent checks.",
  "actions": [
    { "name": "apply_patch", "input": { "patch": "..." } },
    { "name": "exec_command", "input": { "cmd": "bun test" } }
  ]
}
```

The action array is non-empty and has no protocol count limit (`minItems: 1`, no `maxItems`). The runtime validates
the complete envelope and every action before changing state, applies `state_patch` once, and executes actions strictly
sequentially in list order. Action `i + 1` starts only after action `i` completes. On an action error the batch stops
and all remaining actions are recorded as `skipped`. `finish` must be the sole action in its batch.

The model sees results only after the batch stops, so a later action may not depend on an unseen result from an earlier
action. Individual action inputs/results and the execution state remain byte-bounded to prevent one item from consuming
the context; this does not impose a count limit on the array.

Each array and its results form one observation object:

```text
O_i = { state revision, batch comment, aggregate status, actions[] with input/status/result }
```

With `k=3`, the next request contains the three latest batch objects, not the three latest inner actions. Previous
assistant reasoning and the ordinary transcript remain local audit data and are not replayed to the provider.

## Runtime selection

- OpenCode: `OPENCODE_SKILL_STATE_MODE=v3`
- Codex: `CODEX_SKILL_STATE_MODE=v3`
- Observation window: `OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW=3` or
  `CODEX_SKILL_STATE_OBSERVATION_WINDOW=3`

Both agents retain `baseline`, `paper`, and `v2` in the same binaries. V3 is selected at runtime; no separate build is
required.

## Verification contract

The focused tests cover schema shape, arbitrary array length, pre-validation, patch atomicity, strict order,
fail-fast/skipped results, singleton `finish`, state reconstruction, and bounded observation windows. Codex additionally
has a loopback `codex exec` integration test that submits three actions in one model call and verifies that the next
provider request contains a single structured batch observation and no replayed function-call transcript.

Benchmark interpretation and results are in:

- [OpenCode Sol/Terra v3 report](./skill-state/REPORT-v3-sol-terra-k3.md)
- [Codex Sol/Terra v3 report](./codex-skill-state/REPORT-v3-sol-terra-k3.md)
- [consolidated research journal](../journals/V3-BATCHED-ACTIONS.md)
