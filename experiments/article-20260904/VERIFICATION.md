# Verification record

## Passed before the campaign

- OpenCode focused protocol tests: **17 passed**, including a new regression for nonzero shell exit, skipped remainder
  and retained pre-action patch. `bun typecheck` passed.
- Codex core focused state tests after the output-adapter correction: **14 passed**, including real tool-output
  types for patch confirmation and shell exit classification.
- Codex CLI protocol integration after that correction: **6 passed**. An earlier attempt reported the Paper test
  as `LEAK` (assertions passed, a child process/handle outlived the test); the final rerun did not report a leak.
- New CLI regression checks all three state modes: after a plain assistant answer, a second provider request must
  occur, the discarded answer must not be replayed, and an explicit finish must complete the run.
- `just fmt`; `cargo clippy -p codex-core -p codex-exec --lib -- -D warnings`; research `codex` build passed.
- Both benchmark doctors passed before model calls; per-suite Codex manifests include CLI and Code Mode host hashes.

## Test-environment limitation

The additional real-shell regression `exec_v3_skips_remaining_actions_after_nonzero_shell_exit` could not reach its
`exit 7` command on this managed host: the mock-provider session received `approval request failed` instead of a
shell result. The test asserted the presence of an exit code, so it correctly failed rather than count that as a
successful shell test. It is explicitly ignored with that reason; it is **not** included in the six passed tests.
The kernel uses the typed `exit_code` returned by exec tools to classify nonzero completion. The OpenCode analogue
has direct dispatch regression coverage. Runtime failures observed in the real campaign should be audited separately.

The host-level test failure is not evidence of a model failure in the benchmark and does not justify deleting or
retrying a model timeout. No full upstream workspace test suite was run; verification targets the changed protocol
and its CLI integration rather than unrelated UI/server subsystems.

## Reproduction

```sh
cd opencode/packages/opencode
bun test test/session/skill-state.test.ts
bun typecheck

cd ../../../codex/codex-rs
CARGO_INCREMENTAL=0 just test -p codex-core --lib -E 'test(~skill_state)'
CARGO_INCREMENTAL=0 just test -p codex-exec --test all -E 'test(~skill_state_v2)'
```

On a host that permits isolated local shell fixtures, explicitly run the ignored shell test as well. Do not infer
that passing mock-request tests prove all external environment operations completed successfully.
