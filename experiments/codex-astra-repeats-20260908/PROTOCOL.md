# Codex / Astra: five repeats of four modes

Planned before model execution, 2026-09-08 (Europe/Moscow). This is a new cohort,
not a replacement for any earlier outcome and not a clean between-model ablation.

- Model: `gpt-6-astra`, medium reasoning. Existing account authentication, no purchased resets.
- Five full repeats × five existing projects × Native/Paper/V2/V3 = 100 sessions.
- Up to five main CLI processes at a time (user revision approved before dispatch); the existing permission reviewer remains enabled.
  Its subsidiary calls are accounted for separately, not counted as main agent cycles.
- Same Codex binary and Code Mode companion as the Sol repeat campaign; verify SHA-256 before dispatch.
- Same one-shot text, specifications, original evaluator and 900,000 ms timeout per session.
- V2/V3: k=3; unchanged 32 KiB state and 4 KiB per-action result limits.
- Project order rotates by repeat. Mode order rotates by repeat and project position;
  the complete schedule is saved before the first session. Five repeats cannot perfectly balance four modes.
- No outcome-dependent retries, best-of selection or timeout replacement. An infrastructure error,
  rate limit, authentication/model rejection, missing usage, or detected host-context contamination
  stops further dispatch; already-started workers are drained before global files are restored. An ordinary coding failure or timeout remains an outcome.
- Every outcome records its actual start/end time; timed-out durations are censored, not completion times.

## Deliberately changed host context

At the user's request, global skill directories are moved temporarily, not deleted:
user skills, legacy Codex skills (including system skills), and `skills` directories inside the plugin cache.
The original bytes, permissions and symlink targets are fingerprinted; a private write-ahead ledger permits
restoration after interruption. Recreated paths are preserved separately rather than overwritten.
The runner retains `skills.include_instructions=false`, `skills.bundled.enabled=false`, disabled skill search,
ignored user configuration and ignored execution-policy rules, as in the earlier series.

Project instruction discovery is disabled with `project_doc_max_bytes=0`. In this exact Codex source,
global `AGENTS.md` and `AGENTS.override.md` are loaded separately and are **not** disabled by that setting.
The user approved moving them on 2026-09-08; `run.ts --with-global-instructions` records this choice.
Without that approval the campaign must not start if either file exists. No global configuration or auth file is edited.
Initial rollout messages are checked for a skill catalog and host-profile markers without printing their contents.
This check is an audit of recorded messages, not a network packet capture or a proof of complete environmental isolation.

This differs from historical Sol conditions. Comparisons among the four Astra modes use the same cleaned host setup;
differences between Astra and historical Sol may reflect model, context and day/load together. Both repeat campaigns allow up to five main CLI processes; actual overlap and auxiliary work can still differ.
The experiment does not measure an independent variable called “intelligence.”

## Measurements and publication

Keep original check counts and the already-known specification-aligned CLI deletion check separate.
Apply the latter equally to all 20 new CLI artifacts on isolated copies, even if their raw score is perfect.
Full success requires all specification-aligned checks, clean process completion and `turn.completed` (Native)
or an accepted `finish` (state). Passing artifacts after a timeout are not full successes.

Report main input (cached input is already included), output, recorded model responses, wall time, errors,
timeouts and per-project outcomes. Preserve the five repeated observations per mode; do not treat 200 assertions
as 200 independent tasks. The article gets a separate Astra figure with input, cycles and observed time panels.
The figure includes failures and timeouts. Model-capability discussion is explicitly speculative.

Raw traces and restoration paths stay in ignored `.private/`. Before publication, export a separately
redacted snapshot with provenance and unchanged numeric counters. Never rewrite historical manifests or data.
The article's author revision is preserved; editorial changes and this cohort are committed, not pushed automatically.

## Interruption and recovery

Normal completion, an orchestration error, SIGINT, SIGTERM or SIGHUP triggers restoration in `finally`, after all workers settle. Signals stop all active process groups; a 10-second grace period precedes SIGKILL. Suite identifiers include a UUID to prevent concurrent workspace collisions.
Uncatchable termination or a reboot cannot execute that handler: `.private/isolation.json` points to the durable ledger.
Recovery is `bun isolation.ts restore ABSOLUTE_LEDGER_PATH`. The command is idempotent and verifies restored fingerprints.
Resumption must not overwrite or silently retry a started session; inspect `run.json` first.
