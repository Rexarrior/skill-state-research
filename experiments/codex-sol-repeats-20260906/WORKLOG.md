# Completion log — experiment finished

**Completed 2026-09-06 01:00 UTC. No active runner remains. Do not restart session74049 or run.ts.**
All ten suites / 100 cells finished; one V3 HTTP cell timed out with 9/9 artifact checks but no finish.
V2: 9,794,638 input, 556 calls, raw396/400 checks, 46/50 full successes; deletion sensitivity398/400 and48/50.
V3: 13,068,610 input, 691 calls, 398/400 checks, 47/50 full successes, one timeout.
V3 main input +33.4%; including observed linked auxiliary usage +28.2%. Wins in1/10 full attempts.
All archives and final audits complete; verification.json passed. Article/source/protocol hashes unchanged.
Human interpretation is RESULTS.md. No commit, push or article update requested/performed.

The remaining notes below are historical checkpoints, not instructions to launch or resume work.

User requested ten full repeats of Codex V2 and V3 on Sol, up to five simultaneous workers, separately from the article.
Interpretation announced to user: ten repeats of the five-task suite for each mode = 100 task executions.
Do not stop at a launch confirmation; finish the runs, archive/audit and report actual outcomes.

## Active process

- Main exec session: **74049**. Orchestrator PID **69405**. Wait/poll this existing session; do not restart run.ts.
- Source of truth for attempts/suites: run.json. Attempts 1–5 are complete; 6–10 are running. No undispatched model work.
  Every runner has maxConcurrency=1; the five-lane dispatcher enforces max five cells.
- All model work is already scheduled. Do not start extra benchmark processes or retry failures.
- Do not modify run.ts or PROTOCOL.md after startup: their hashes are frozen. Core and original runners also frozen.
- run.ts inherits the authorized provider environment without printing secrets. CLI remains workspace-write with
  --approve-for-me. No auth config was read or modified.
- Original article and its entire experiment package are hashed in source-manifest.json/protectedFiles.
  Do not edit article files, original article scripts/results or original runtime sources in this task.

At the last refresh: 66/100 cells, V2 261/264 checks (30/33 raw successes), V3 263/264 (32/33), no timeouts.
Numbers will change; rerun analyze.ts for current status. First five full attempts all used more input with V3:
ratios +42.1%, +21.1%, +87.2%, +21.4%, +26.3%; both modes have same score within each of these five attempts.
Two clear artifact failures so far:
V3 repeat4 CSV 7/8 (wrong sums and numbers instead of required decimal strings);
V2 repeat4 template 7/8 (this/current-item lookup missing). Both clean exit and finish. Keep them.
Two more RAW V2 failures: attempts8/9 taskboard, check "delete and missing ids". IMPORTANT: these are evaluator
overspecification, not demonstrated code bugs. SPEC requires delete + JSON reply but does not prescribe reply.id;
the frozen evaluator demands reply.id===2 while both programs correctly return {deleted: id}.
EVALUATOR-NOTE.md documents discovery; original scores/fixtures unchanged. audit-taskboard-delete.ts checks actual
deletion/missing ID/persistence on isolated copies of ALL archived taskboards, not just failed cells. 18/18 passed
at last check, confirming those two false negatives. At final run it again on all20; keep raw and sensitivity scores
separate. analyze.ts automatically adds a clearly labeled post-hoc sensitivity table when its audit JSON exists.
No model reruns and no artifact edits. Auxiliary usage grew with HTTP tasks; collect again at end.

## Analysis files

- analyze.ts regenerates data.json, statistics.json, REPORT.md, usage-audit.json. It never invokes a model.
  It includes all saved outcomes; full-attempt comparisons require both complete five-task groups.
  Calls/input/output independently summed from raw token_usage_record events.
  Quotas/timeouts/model/protocol/binary/evaluator denominator are checked against the frozen contract.
- archive-workspaces.ts copies completed post-evaluator workspaces with hashes, skipping dependencies/symlinks/secret
  configurations/large files. No generated code is executed by archiving. Run incrementally and finally.
- audit-traces.ts checks recorded nonzero-exit handling and V3 failfast/skipped status order; not full reexecution.
- auxiliary-usage.ts exports ONLY linked descendant usage records, no auxiliary prompts/reasoning. Main and auxiliary
  totals stay separate; combined tokens across models are not money.
- host-context-audit.ts preserves fingerprints, not personal instruction text; all checked cells retain host profile.
- scan-artifacts.ts scans plaintext credential shapes, skips typed opaque encrypted reasoning fields without decoding.
- environment.json has whitelisted host tool versions captured during this series.
- progress.ts reads only exact active benchmark sessions and prints counters/timestamps without prompts/commands;
  useful if no cells complete for a while. progress.json is NOT part of final token totals.
- verify.ts final QA requires 100 cells and all complete audits; checks archive hashes, source/article preservation,
  model usage, suite identity/worker intervals, and local report links. Writes verification.json.

Copied helpers use their own import.meta.dir in this new experiment folder; they DO NOT modify the original article data.
The original runner's per-suite baseline-reduction section is not relevant to this V2/V3-only series; use our REPORT.md.

## Finish sequence

1. Wait for session74049 exit0 and run.json status complete (10 attempts, 100 cells).
2. bun experiments/codex-sol-repeats-20260906/analyze.ts --final
3. Run archive-workspaces.ts, audit-traces.ts, host-context-audit.ts, auxiliary-usage.ts, scan-artifacts.ts in this folder.
   Then audit-taskboard-delete.ts (all20 projects); rerun analyze.ts --final to incorporate final sensitivity table.
4. Run verify.ts; investigate findings without replacing model outcomes. Do not print credential candidates.
5. Read full statistics + failed evaluations and write a concise human interpretation in a separate RESULTS.md,
   including sum and median input, attempts won, calls, success/checks, per-task variability, batching,
   and effect of observed auxiliary usage. Include the raw-vs-spec-deletion sensitivity caveat, not a false claim
   that V3 has superior quality from these false negatives. Link it from this folder README. No article edits.
6. Mark this worklog complete; final response in Russian with separate report links and measured conclusions.
   No commit/push/publication requested.

Keep progress updates concise. Do not wait longer than 60 seconds per blocking call. Developer prohibits proactive
subagents; CLI benchmark workers are not subagents. All prior article work is completed and out of scope for changes.
