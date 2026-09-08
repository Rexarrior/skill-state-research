# Continuation 1: 65 never-started cells

Authorized by the user after the first segment stopped. This amendment is recorded before the continuation,
not presented as part of the original pre-run protocol. Model, binary, prompts, evaluator, timeouts,
five-worker limit and all state-mode settings remain unchanged.

## What happened

The first segment stopped after 35 completed runner outcomes because the global `skills` directory reappeared.
All 18 suspended sources were restored, with matching fingerprints. One recreated directory was preserved separately.
Inspection of that directory found **only `.system`**, containing the embedded system-skill cache and its marker.
The creating process has not been identified. It would be incorrect to claim that an active skill was observed
in a model prompt merely because this directory existed.

All 35 recorded initial-context audits were negative for the skill-catalog and host-profile markers used by the audit.
That is evidence about the recorded messages, not a packet capture or proof that no hidden environmental influence exists.
The outcomes, including nine Paper timeouts and two V2 timeouts, remain in the series. No completed run is retried.

## Why the guard can be corrected without changing the agent

The frozen runner already passes `skills.bundled.enabled=false` and `skills.include_instructions=false`.
In the exact source used for the frozen binary:

- [Host skill service](../../codex/codex-rs/ext/skills/src/host_service.rs) filters `SkillScope::System` roots when bundled skills are disabled.
- [Host loader](../../codex/codex-rs/ext/skills/src/loader/host.rs) uses `HiddenDirectoryPolicy::Skip`.
- [Discovery](../../codex/codex-rs/ext/skills/src/loader/discovery.rs) rejects candidates with a hidden ancestor below the root.
  Thus `.system` is not a second route into user-skill discovery.
- [Permission-reviewer configuration](../../codex/codex-rs/ext/guardian-v2/src/sync_reviewer/reviewer_config.rs)
  inherits the parent configuration, disables skill instructions and orchestrator skills, and uses its own policy prompt.

The official [local-skill documentation](https://learn.chatgpt.com/docs/build-skills#enable-or-disable-local-codex-skills)
describes disabling individual skills. The specific bundled-cache exception above is established from this checked-in
version's source, not inferred from current documentation or a newly chosen configuration flag.

The original guard stopped on *any reappearance*. The continuation guard allows just a plain legacy `skills`
directory that is empty or contains only a plain `.system` directory. It rejects visible skills, hidden extras,
root symlinks, symlinked `.system`, reappeared global instructions and new plugin skill roots.
This is not disabling the guard, and it does not enable system skills. The runner and binary are not changed.

## Operational checks

All global user/plugin skill sources and global instructions are suspended again with a new restoration ledger.
The guard scans immediately before dispatch and after each cell, and every two seconds while work is active.
An unexpected source stops dispatch and terminates active process groups before restoration. Ordinary outcome
failures are retained. Recorded initial messages are also checked after each completed cell.
Filesystem polling and recorded-message checks are fail-fast controls, not an OS-level filesystem namespace.
They cannot provide an absolute guarantee against an unrelated process changing a source between checks.

Only the 65 cells whose status is `pending` and whose start/source/worker fields are unset can be dispatched.
The original 35 cell records and every saved result file are fingerprinted before continuation and checked again at the end.
`run-before-resume-1.json` preserves the interrupted schedule; `resume-1-manifest.json` records the continuation
scripts, pending keys, original manifest fingerprint and preserved-artifact fingerprints. The original manifest,
first-run orchestrator and first restoration receipt remain unchanged.

The continuation writes progress to the existing `run.json`, adding a continuation record, and writes a separate
`restoration-resume-1.json`. Its private ledger pointer is `.private/isolation-resume-1.json`.
After SIGKILL/reboot, restore using that pointer, not the first segment's already-restored ledger.

## Launch and checks

```sh
bun test ./experiments/codex-astra-repeats-20260908/isolation.test.ts ./experiments/codex-astra-repeats-20260908/isolation-guard.test.ts ./experiments/codex-astra-repeats-20260908/pool.test.ts ./experiments/codex-astra-repeats-20260908/resume-plan.test.ts
bun experiments/codex-astra-repeats-20260908/resume.ts --with-global-instructions
```

This is a continuation across a pause, not a single uninterrupted run. Reports must preserve the segment boundary
and must not label timeout outcomes as successes merely because their generated code passes checks.
