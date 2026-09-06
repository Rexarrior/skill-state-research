# Paper conformance audit, 2026-09-04

Reference: [SKILL.state, revision 2](https://arxiv.org/html/2608.26263v2), §3, Algorithm 1, Appendix A.4.
Scope: execution/memory protocol transported through the native coding tools. This is not a reproduction of the
authors' benchmark environments, models or exact text-output parser.

| Requirement | Implementation / evidence | Verdict |
|---|---|---|
| Immutable task P on each step | OpenCode `context` extracts the original textual specification; Codex `immutable_task` reconstructs the initial task | Implemented |
| Current full Sigma, no replayed transcript | OpenCode `modelMessages`; Codex `provider_input` replaces model input with one user message | Implemented; unit and CLI mock-request tests |
| Only latest result O in Paper | Window forced to one; only result string interpolated, not action/input/comment/revision | Implemented; tests include stale observations and k=8 |
| Model proposes patch and one action | Exactly two top-level fields in Paper wrapper; V2/V3 fields rejected | Implemented |
| Validate → apply patch → execute | OpenCode `prepare/execute`; Codex `RuntimeState::accept` and tool dispatcher | Implemented |
| Merge with null deletion | Recursive dictionary merge; nested `files` deletions; resulting coding schema validated | Implemented; required root containers cannot be deleted |
| Reasoning is not replayed | Provider input omits earlier reasoning and assistant messages | Implemented; current model reasoning remains available within a step |
| Terminal behavior | Explicit finish action, artifact assessment external | Codex plain-text bypass fixed in this campaign |

## Deliberate domain/transport adaptations

The article's command string becomes `{name,input}` for heterogeneous coding tools; JSON is transported as a
`skill_step` call rather than parsed from a fenced block. Both carry exactly `state_patch` and one `action`, without
another model turn. This preserves the central runtime contract but may influence model behavior; no transport
equivalence experiment has been performed. Claims must say “implementation of the paper's architecture”, not
“identical prompts and outputs to the authors' implementation”.

The coding schema is fixed across the five tasks: status, plan, completed, files, facts, decisions, next_action.
It is authored for this domain, as the paper permits; it is not the authors' CTF schema. State is capped at 32 KiB;
result observations at 4 KiB. Truncation may discard useful evidence. The paper's constant-size argument requires
bounded sufficient state; these limits alone do not guarantee sufficiency.

System/tool instructions from each coding runtime remain part of the request. Native Codex retains Code Mode,
whereas state modes use direct nested tools. Thus Native is a practical product control, not the authors' matched
ReAct implementation. Compare numbers within runtime/model, not absolute inputs between runtimes.

Codex `immutable_task` concatenates non-assistant messages before the first state action, including developer and
user context, with textual role labels inside P. Those labels are not preserved API message roles. Recorded startup
messages include this host's user profile/instruction bundle and plugin recommendations despite `--ignore-user-config`;
that flag must not be described as removing all host-supplied context. This instruction bundle is part of the tested
P, not just the task SPEC. Native retains the corresponding message roles. The comparison therefore also contains
instruction-packaging differences; it is not a controlled role-preserving memory ablation.
See [startup-context fingerprints](./article-20260904/host-context-audit.json). Production requests were not captured.

V2/V3 are packages of changes, not pure observation ablations. In particular Codex Paper recursively merges
dictionary patches, whereas Codex V2/V3 replace patched top-level values. OpenCode retains recursive merge.
OpenCode V3 also requires an explicit revision in the response whereas its V2 does not. These differences must
remain visible when interpreting comparisons, until a future controlled ablation aligns them.

## Corrections before the new campaign

- Paper previously advertised null on required root fields, but resulting-state validation rejected those deletions.
  The offered schema and instructions now explicitly retain required containers. Dictionary null deletion is tested.
- Codex could finish via ordinary assistant text. `taskboard-cli` in old Sol V2 suite `20260904T023020Z` did so:
  8/8 artifact checks, zero finish calls. State modes now continue until an accepted finish or interruption.
- Both V3 dispatchers previously conflated successful tool invocation with a command's zero exit status.
  Shell nonzero exit now stops the batch. Previously completed effects and the accepted patch are not rolled back.
- A live Codex Paper diagnostic exposed another transport bug: `apply_patch`'s Code Mode return is `{}`, while its
  actual textual tool result contains the file-change confirmation. State modes now retain textual outputs for
  non-shell tools and structured exit/session information for shell tools. A regression uses the real
  `ApplyPatchToolOutput` and `ExecCommandToolOutput` types. The affected campaign was stopped and excluded in full.

## Limits of sequential execution

V3 sequences tool invocations, not arbitrary operating-system processes. Codex `exec_command` may return a live
session handle; that is an observation requiring `write_stdin` before a model can establish process completion.
The protocol does not automatically await every background process. A batch is not a database transaction, and its
pre-action patch cannot truthfully claim that future commands have succeeded.

## Validation boundary of the tested V3 implementation

“Complete pre-validation” in earlier V3 descriptions was too broad. The kernels check the whole envelope, action
names/basic input kinds, size constraints and resulting state before environment operations. They do not run every
nested tool's full parameter validator during that preflight. Codex `resolve_action` resolves function-tool names
and retains their JSON inputs; tool-specific argument parsing happens during dispatch. OpenCode `prepareAction`
requires a name and object input, then the selected tool executes its own validation. A malformed later tool input
can therefore fail after earlier actions have already run. Published claims must describe envelope/state preflight,
not a guarantee that every tool argument has been validated before the first action. This clarification changes
documentation, not the frozen runtime or the interpretation of recorded tool errors. A stronger guarantee would
require a separately versioned implementation and tests, not retroactive relabeling of these results.

The installed OpenCode AI SDK was also probed: with `ai@6.0.168`, calling `jsonSchema({...})` without a custom
validator produces `validate: undefined`. The wrapper's advertised JSON Schema therefore must not be confused with
an independent runtime check of every nested parameter. This was a read-only construction probe, not a new model run.

## Audit artifacts

- [Campaign protocol](./article-20260904/PROTOCOL.md).
- [Source manifest](./article-20260904/source-manifest.json) and [patch](./article-20260904/source.patch).
- OpenCode: `packages/opencode/test/session/skill-state.test.ts`.
- Codex: `core/src/skill_state_tests.rs` and `exec/tests/suite/skill_state_v2.rs`.

CLI integration tests inspect actual requests to a loopback provider. Production rollout logs are audit records,
not by themselves proof of every provider-visible request; do not describe them as complete network captures.

The Codex transport was also inspected: `client.rs::get_incremental_items` reuses a previous response only when
the new input extends the previous input plus its response items. Replacing that history with a reconstructed state
message does not meet that condition; `prepare_websocket_request` then omits previous_response_id. This is a source
audit of the transport condition, not a separate production packet capture.
