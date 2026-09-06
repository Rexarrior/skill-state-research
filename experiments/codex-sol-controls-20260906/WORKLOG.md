# Active native/paper campaign — continuation instructions

User requested ten full repeats per mode on Sol, same five projects, up to five primary CLI workers.
100 new cells; combine with 100 completed V2/V3 cells WITHOUT changing their files or the article.

Main exec session **90520**. Poll this existing session. DO NOT restart run.ts or change frozen run.ts/PROTOCOL.md.
Source of truth: run.json. First five suites dispatched; outer workers will automatically dispatch attempts6–10.
CLI modes passed to legacy runner are baseline and paper. Reports call baseline native.
Same fixed binary, model gpt-5.6-sol, medium, 900000ms/task. Expected main binary SHA
24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc; Code Mode companion also checked.
No core/runner/evaluator changes or model retries. All original files/article/V2V3 results are protected by hashes.

Run analyze.ts as cells finish; archive-workspaces.ts preserves projects. Helpers are copies confined to this directory.
compare.ts reads the prior V2/V3 data and generates combined-data.json + COMPARE-FOUR.md here only.
context-comparison.ts compares normalized host-profile hashes (exact workspaces + current_date only), no text exported.
Native completion comes from events.jsonl turn.completed plus clean exit, not skill_step/finish.

At finish run all collection scripts from README, analyze.ts --final, compare.ts, context-comparison.ts and verify.ts.
Check all200 combined outcomes, all40 supplementary CLI deletion checks across both campaigns, audit findings,
100 new archives, protected hashes and max5 workers. Correct metadata/audit bugs, not model outcomes.
Write a human RESULTS.md with all4 results, clear raw vs deletion-sensitive quality, finish/timeouts,
input/calls/distributions, auxiliary totals and limitations. Link from README, final verify + git diff --check.
The additional series is later, not randomized/interleaved with prior V2/V3. Ordinal reps are not shared seeds.
No article edit/commit/push requested. Do not stop at launch confirmation; finish and deliver measured results.

Checkpoint 2026-09-06 01:45 UTC: 32/100 new cells, first five suites still running. Suite IDs:
1=20260906T010725Z, 2=20260906T010737Z, 3=20260906T010746Z, 4=20260906T010756Z, 5=20260906T010805Z.
Native17 cells: 135/138 raw checks,14 successes, no timeout. Paper15:119/121 checks,12 successes,1 timeout.
Native CLI repeats3/4 are known evaluator false negatives; all first10 CLI supplementary tests passed.
Native CSV repeat1 and paper CSV repeat5 double sums (strings correctly formatted, unlike old V3 numeric outputs).
Paper template repeat4 fails this.name; same expected [0:a/T][1:b/T], got [0:/T][1:/T].
Paper HTTP repeat3 timed out:9/9 artifact checks, exit143, no finish,79calls,1,292,369input,7stateErrors.
Its79 actions:71exec_command success,7exec_command error,1apply_patch success. Only1exactrepeat,maxstreak2.
Do not infer a precise root cause or a literal repetitive loop from long duration alone.
Later inspection of the last8 actions of paper HTTP repeat3 confirmed repeated sed/rg reads of the same
server.py/test_server.py/README.md with varying line ranges: READING-LOOP-NOTE.md. Exact repetition metric
under-counts this semantic repetition. Do not claim a causal effect of any one state field from this case.
Normalized host-profile comparison has1hash across all129 cells then available (all prior100 plusnew29).
Current analyzed data may be newer; rerun scripts for source of truth. No core or frozen evaluator changes.
verify.ts now also requires all200 combined rows, auxiliary coverage, normalized profile equality and companion hash.
action-errors.ts covers skill_step only; native zero counts explicitly unsupported, NOT no native errors.

Checkpoint 02:15 UTC:56/100; ALL TEN ATTEMPTS HAVE BEEN DISPATCHED, nothing else to launch.
New suite IDs:6=20260906T015507Z,7=20260906T020250Z,8=20260906T020321Z,9=20260906T020613Z,10=20260906T021023Z.
First5 full attempts complete. Native29:228/232raw,25success,0timeouts. Paper27:214/216,19success,6timeouts.
Native CLI repeat7 is another confirmed evaluator false negative (in addition to3/4); supplementary11/11 at last audit.
Paper timeouts so far HTTP1/2/3/4, template5, CLI6, all passed external artifact checks. Refresh exact data at finish.

IMPORTANT ADDITION: first timed-out paper HTTP's last8 results ALL truncated at4KiB +30-byte suffix (4126bytes).
Shared MAX_RESULT_BYTES=4*1024 in core/src/skill_state.rs applies to all state modes; native uses own tool policy.
This limit was EXPLICITLY documented before runs in experiments/PAPER-CONFORMANCE.md, not a newly found code change.
READING-LOOP-NOTE.md now covers truncation; don't assert causality. New truncation-audit.ts reads combined-data.json
and counts exact suffix markers only, excluding skipped actions. Run after compare.ts at finish; verify requires150statecells.
At56newcells:paper504/849results clipped; priorV2 172/556; V3 365/1005. Counts are created observations, not exposures.
COMPARE-FOUR now explicitly notes4KiB, role-label packing in P, direct-tools vs Code Mode, recursive paper patch vs
top-level replacement V2/V3. This is a practical implementation comparison, not isolated memory/role/patch ablation.

Checkpoint 03:08 UTC:92/100 new cells; attempts1–6 and8 complete,7/9/10 active in exec session90520.
DO NOT restart dispatcher. Native47cells:373/377raw,43success,0timeouts; paper45:347/361raw,27success,15timeouts.
All20new supplementary deletion checks pass; false negatives native3/4/7 and paper10.
New genuine failures: paper template10 this.name (also timeout), CSV10 decimal numbers instead of strings (also timeout).
Paper HTTP8:0/9,timeout,EMPTY workspace; raw evaluator reports bad server banner, not9 separate failed behavior checks.
Trace shows repeated empty-workspace inspection, host-profile references, then broad SKILL.md searches and repeated
write_stdin waiting for the search. No server was created. Detailed note added to READING-LOOP-NOTE.md; not a rerun.
Current same normalized host profile hash across190 sessions. Auxiliary88cells:21threads,911116input; refresh finally.
verify.ts now explicitly checks BOTH audit.issues and audit.findings arrays (no finding should be masked).

COMPLETE 2026-09-06 03:40 UTC. Exec session90520 exited0; all10 suites complete; NO more model runs.
100new/200combined, all audits and verify.ts passed. Native input19,487,533/calls632,0timeouts,correctedSuccess49/50.
Paper input32,318,674/calls2005,18timeouts,correctedSuccess30/50; raw43artifactpasses,corrected44.
Last paper planner7 timed out and missed README only (6/7checks). Paper14/18timeouts have fully passing raw artifacts.
100archives/448files; protected971oldfiles plus15sourcefiles unchanged; normalized host profile1hash/200sessions.
Auxiliary new26threads/1,112,746input; final combined totals in COMPARE-FOUR.md. Truncation paper1283/2003results.
RESULTS.md contains final interpretation, limitations and links. README updated; article/prior data remain unchanged.
