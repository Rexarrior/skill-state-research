# Redaction of private host context

On 2026-09-06, private host instructions, skill names and skill contents were
removed from the saved research traces and from the repository's Git history.
The same redaction was applied to local, not-yet-committed experiment artifacts.

Removed text is represented as `<nda context deleted, size :N chars>`, where N
is the number of Unicode characters in the original decoded text fragment.
It is not a token count or a UTF-8 byte count. Where a tool response contains
private instructions mixed with other output, its entire textual output field
may be redacted. Commands and their linked responses are checked together,
including responses that do not repeat the source filename.

This is a disclosure restriction on archived material. It does **not** remove
the influence of host instructions from the experiments that already ran.
There were no replacement runs as part of this operation. Recorded token usage,
step counts, timings and evaluation results continue to describe those original
runs. Initial-context fingerprints and host-profile flags likewise describe the
original context, before redaction, and are retained as historical measurements.
Recomputing those fingerprints from the redacted traces would answer a different
question. Full original prompts cannot be reconstructed from these public traces.

The local user configuration and installed skills themselves were not modified.
Only their copies in research artifacts were redacted. Existing unrelated
worktree edits were preserved; redaction does not publish pending research work.

The sanitizer is `scripts/redact_session_context.py`; focused regression tests
are in `scripts/test_redact_session_context.py`. Private reference files and
identifying patterns are supplied locally, loaded into memory and never embedded
in the script or committed configuration. The Git rewrite preserves commit
authors, messages and topology while replacing affected blobs and descendant
commit IDs. Old local reflogs and unreachable objects must be removed after
verification, and published branches must be updated with explicit leases.

Rewriting published refs cannot erase copies in someone else's clone, forks,
or provider caches. Anyone retaining an old clone should replace it with a fresh
clone rather than merging the old history back into the cleaned repository.
