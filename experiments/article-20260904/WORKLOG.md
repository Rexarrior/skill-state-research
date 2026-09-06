# Campaign worklog — complete

Completed 2026-09-05 UTC. All 120 planned benchmark cells finished; no benchmark runner remains active.
The technical article, LinkedIn text, figure and supporting report are ready locally.
Nothing was committed, pushed or published during this task.

## Execution

- OpenCode main Sol / Terra: suites 20260904T195726Z and 20260904T203726Z.
- Codex main Sol / Terra: suites 20260904T202639Z and 20260904T223606Z.
- Codex repetition 1 Sol / Terra: suites 20260904T212003Z and 20260904T220955Z.
- Codex repetition 2 Sol / Terra: suites 20260904T225135Z and 20260904T234023Z.
- All four runner lanes exited successfully. At most two benchmark cells ran simultaneously, each lane sequentially.
  Individual model failures and timeouts remain outcomes; runner success does not imply artifact or protocol success.
- OpenCode 20260904T195607Z / 20260904T195630Z failed before provider calls and are excluded.
- Codex diagnostic suite 20260904T200756Z is excluded in full because the apply_patch adapter returned an empty
  Code Mode object instead of textual output. After the fix Native was also rerun. Diagnostic evidence is preserved.
- The choice of repetition order was recorded after partial main-series outcomes, before dispatch; not preregistered.

## Frozen implementation and verification

The final source manifest, source patch and binary hashes predate the valid comparisons.
No runtime source changes were made during the valid campaign.
Fixes address mandatory finish, shell nonzero exit classification, Paper nullability, and Codex apply_patch output.
Verification: OpenCode 17 tests plus typecheck; Codex 14 core tests and 6 CLI tests; fmt, scoped Clippy and CLI build.
One additional real-shell integration test is explicitly ignored on the managed host, not counted passed.
See VERIFICATION.md and ../PAPER-CONFORMANCE.md for exact scope.

## Main findings

- OpenCode/Sol V2: 40/40 checks and 62.0% less full main-loop input than Native.
- OpenCode/Terra: all state variants used more input and passed fewer checks than Native.
- Codex main V2/V3 matched Native aggregate scores at lower main-loop input.
- Across three Codex attempts V3 used 4.0% more main-loop input for Sol and 4.6% more for Terra than V2.
  Scores: Sol V2 120/120 vs V3 119/120; Terra V2 118/120 vs V3 117/120. These are repeated checks on five tasks.
- Adding observed guardian input changes Sol V3 vs V2 to -8.4%; Terra to +16.9%. These sums combine different models
  and are not monetary cost. All 38 linked descendants found were codex-auto-review guardians, not coding delegates.
- Each Codex Paper model finished only two of five tasks; three timed out. Positive Paper cases also remain reported.
  Domain schema and transport differences prevent treating this as a literal replication of the paper.

## Final audits

- Independent accounting: 546 OpenCode steps and 1,658 Codex usage records, no discrepancies.
  One zero-token OpenCode step lacks SDK total; unreturned usage from interrupted requests is not invented.
- 516 accepted V3 batches, one rejected; 170 failed and 60 skipped actions. Maximum observed batch: seven actions.
  Status audit is not a re-execution or proof of full nested-tool parameter validation.
- All 80 Codex cells retain host startup instructions. State flattens initial roles into P with textual labels;
  Native preserves API roles. This configured-host comparison is not a clean-room, role-matched ablation.
- V3 preflight checks the envelope, state, names and basic input kinds, not every nested tool parameter.
  Sequential calls may return live process handles and do not constitute a rollback-capable transaction.
- Credential-shaped plaintext scan: no findings. One initial match was in opaque encrypted_content and triaged
  without printing or decoding it. Typed ciphertext fields are omitted from plaintext scanning; raw logs unchanged.
  This is a heuristic audit, not a guarantee of absence of all confidential information or publication authorization.
- Publication QA verifies all 120 cells, 441 archived file hashes, auxiliary usage sums, local links and exact
  generated article table rows. The PNG figure was rendered and visually inspected.
- Prespecified examples whose V3 advantage did not repeat remain in the article. New trace examples include
  21 successful repeated compiles and a Paper HTTP run ending with an empty workspace.

## Deliverables

- ../../articles/skill-state-in-coding-agents.md — ready technical article.
- ../../articles/linkedin-post.md — short standalone post.
- ../../articles/figures/input-by-task.png and .svg — main comparison figure.
- REPORT.md, data.json, publication-tables.md and comparisons.json — final results.
- ../../journals/ARTICLE-20260904.md — final journal entry.
- ../../journals/RESEARCH-ARTICLE-PLAN.md — separate future confirmatory work, not required for this technical article.

Regeneration commands and publication boundaries are in README.md. Do not launch further runs as continuation of
this completed campaign. New experiments require a separately identified series.
