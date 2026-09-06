# Technical article campaign results

Status: complete. 120 cells.

Input is full provider-reported input of the main agent loop: OpenCode input + cache.read + cache.write; Codex input_tokens already includes cached input. Output includes reasoning (OpenCode output + reasoning; Codex output_tokens). Codex permission-reviewer descendants are measured separately in auxiliary-usage.json; interrupted requests without returned usage are not estimated. Legacy OpenCode suite reports omit cache.write from their prompt metric; use this corrected table. These are not monetary costs. Checks describe artifacts; exit and finish describe execution. Repetitions are independent attempts, not new tasks.

| Runtime | Model | Rep | Mode | Checks | Projects | Exit clean | Finish | Input | Calls | Output | Minutes |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| OpenCode | sol | 0 | native | 40/40 | 5/5 | 5/5 | — | 1,480,680 | 59 | 37,551 | 11.0 |
| OpenCode | sol | 0 | paper | 40/40 | 5/5 | 5/5 | 5/5 | 1,967,954 | 119 | 54,714 | 14.4 |
| OpenCode | sol | 0 | v2 | 40/40 | 5/5 | 5/5 | 5/5 | 563,281 | 32 | 30,722 | 6.1 |
| OpenCode | sol | 0 | v3 | 40/40 | 5/5 | 5/5 | 5/5 | 674,403 | 37 | 32,670 | 8.3 |
| Codex | sol | 0 | native | 40/40 | 5/5 | 5/5 | — | 1,640,364 | 62 | 59,784 | 22.1 |
| Codex | sol | 0 | paper | 39/40 | 4/5 | 2/5 | 2/5 | 4,185,286 | 259 | 125,446 | 56.3 |
| Codex | sol | 0 | v2 | 40/40 | 5/5 | 5/5 | 5/5 | 1,397,264 | 77 | 72,196 | 27.5 |
| Codex | sol | 0 | v3 | 40/40 | 5/5 | 5/5 | 5/5 | 1,280,086 | 67 | 59,653 | 23.3 |
| OpenCode | terra | 0 | native | 40/40 | 5/5 | 5/5 | — | 1,073,652 | 47 | 28,367 | 9.1 |
| OpenCode | terra | 0 | paper | 39/40 | 4/5 | 5/5 | 5/5 | 2,121,319 | 129 | 54,292 | 15.3 |
| OpenCode | terra | 0 | v2 | 38/40 | 3/5 | 5/5 | 5/5 | 1,162,696 | 65 | 38,692 | 8.4 |
| OpenCode | terra | 0 | v3 | 39/40 | 4/5 | 5/5 | 5/5 | 1,083,885 | 58 | 34,474 | 7.5 |
| Codex | sol | 1 | v3 | 39/40 | 4/5 | 5/5 | 5/5 | 1,067,675 | 56 | 65,552 | 23.8 |
| Codex | sol | 1 | v2 | 40/40 | 5/5 | 5/5 | 5/5 | 1,273,218 | 72 | 65,077 | 25.7 |
| Codex | terra | 1 | v3 | 39/40 | 4/5 | 5/5 | 5/5 | 1,476,275 | 81 | 48,473 | 20.5 |
| Codex | terra | 1 | v2 | 40/40 | 5/5 | 5/5 | 5/5 | 1,695,519 | 96 | 47,117 | 20.5 |
| Codex | terra | 0 | native | 39/40 | 4/5 | 5/5 | — | 1,526,797 | 56 | 38,673 | 15.0 |
| Codex | terra | 0 | paper | 25/40 | 2/5 | 2/5 | 2/5 | 6,744,338 | 435 | 136,528 | 66.6 |
| Codex | terra | 0 | v2 | 39/40 | 4/5 | 5/5 | 5/5 | 1,000,050 | 58 | 34,160 | 14.0 |
| Codex | terra | 0 | v3 | 39/40 | 4/5 | 5/5 | 5/5 | 1,092,484 | 62 | 41,145 | 16.7 |
| Codex | sol | 2 | v2 | 40/40 | 5/5 | 5/5 | 5/5 | 1,065,343 | 61 | 53,008 | 21.0 |
| Codex | sol | 2 | v3 | 40/40 | 5/5 | 5/5 | 5/5 | 1,539,278 | 81 | 73,080 | 27.5 |
| Codex | terra | 2 | v2 | 39/40 | 4/5 | 5/5 | 5/5 | 1,038,586 | 60 | 33,902 | 14.3 |
| Codex | terra | 2 | v3 | 39/40 | 4/5 | 5/5 | 5/5 | 1,337,564 | 75 | 39,461 | 16.6 |

## Source suites

- OpenCode/sol, repetition 0: [20260904T195726Z](../skill-state/results/20260904T195726Z/report.md).
- Codex/sol, repetition 0: [20260904T202639Z](../codex-skill-state/results/20260904T202639Z/report.md).
- OpenCode/terra, repetition 0: [20260904T203726Z](../skill-state/results/20260904T203726Z/report.md).
- Codex/sol, repetition 1: [20260904T212003Z](../codex-skill-state/results/20260904T212003Z/report.md).
- Codex/terra, repetition 1: [20260904T220955Z](../codex-skill-state/results/20260904T220955Z/report.md).
- Codex/terra, repetition 0: [20260904T223606Z](../codex-skill-state/results/20260904T223606Z/report.md).
- Codex/sol, repetition 2: [20260904T225135Z](../codex-skill-state/results/20260904T225135Z/report.md).
- Codex/terra, repetition 2: [20260904T234023Z](../codex-skill-state/results/20260904T234023Z/report.md).

## Individual outcomes

| Runtime/model | Rep | Task | Mode | Checks | Input | Calls | Timeout | Finish |
|---|---:|---|---|---:|---:|---:|---|---|
| OpenCode/sol | 0 | taskboard-cli | native | 8/8 | 342,788 | 14 | false | — |
| OpenCode/sol | 0 | taskboard-cli | paper | 8/8 | 180,556 | 11 | false | true |
| OpenCode/sol | 0 | taskboard-cli | v2 | 8/8 | 83,872 | 5 | false | true |
| OpenCode/sol | 0 | taskboard-cli | v3 | 8/8 | 185,988 | 10 | false | true |
| OpenCode/sol | 0 | csv-insights | native | 8/8 | 230,771 | 9 | false | — |
| OpenCode/sol | 0 | csv-insights | paper | 8/8 | 316,819 | 19 | false | true |
| OpenCode/sol | 0 | csv-insights | v2 | 8/8 | 66,988 | 4 | false | true |
| OpenCode/sol | 0 | csv-insights | v3 | 8/8 | 128,713 | 7 | false | true |
| OpenCode/sol | 0 | mini-template | native | 8/8 | 293,522 | 12 | false | — |
| OpenCode/sol | 0 | mini-template | paper | 8/8 | 96,366 | 6 | false | true |
| OpenCode/sol | 0 | mini-template | v2 | 8/8 | 102,726 | 6 | false | true |
| OpenCode/sol | 0 | mini-template | v3 | 8/8 | 124,328 | 7 | false | true |
| OpenCode/sol | 0 | http-kv | native | 9/9 | 380,167 | 14 | false | — |
| OpenCode/sol | 0 | http-kv | paper | 9/9 | 740,760 | 45 | false | true |
| OpenCode/sol | 0 | http-kv | v2 | 9/9 | 145,054 | 8 | false | true |
| OpenCode/sol | 0 | http-kv | v3 | 9/9 | 130,759 | 7 | false | true |
| OpenCode/sol | 0 | dependency-planner | native | 7/7 | 233,432 | 10 | false | — |
| OpenCode/sol | 0 | dependency-planner | paper | 7/7 | 633,453 | 38 | false | true |
| OpenCode/sol | 0 | dependency-planner | v2 | 7/7 | 164,641 | 9 | false | true |
| OpenCode/sol | 0 | dependency-planner | v3 | 7/7 | 104,615 | 6 | false | true |
| Codex/sol | 0 | taskboard-cli | native | 8/8 | 322,807 | 14 | false | — |
| Codex/sol | 0 | taskboard-cli | paper | 8/8 | 1,080,252 | 66 | true | false |
| Codex/sol | 0 | taskboard-cli | v2 | 8/8 | 144,312 | 8 | false | true |
| Codex/sol | 0 | taskboard-cli | v3 | 8/8 | 174,460 | 9 | false | true |
| Codex/sol | 0 | csv-insights | native | 8/8 | 291,928 | 10 | false | — |
| Codex/sol | 0 | csv-insights | paper | 7/8 | 1,396,898 | 86 | true | false |
| Codex/sol | 0 | csv-insights | v2 | 8/8 | 221,643 | 12 | false | true |
| Codex/sol | 0 | csv-insights | v3 | 8/8 | 318,751 | 16 | false | true |
| Codex/sol | 0 | mini-template | native | 8/8 | 247,307 | 11 | false | — |
| Codex/sol | 0 | mini-template | paper | 8/8 | 1,082,380 | 68 | true | false |
| Codex/sol | 0 | mini-template | v2 | 8/8 | 165,591 | 10 | false | true |
| Codex/sol | 0 | mini-template | v3 | 8/8 | 232,427 | 13 | false | true |
| Codex/sol | 0 | http-kv | native | 9/9 | 363,895 | 13 | false | — |
| Codex/sol | 0 | http-kv | paper | 9/9 | 189,034 | 12 | false | true |
| Codex/sol | 0 | http-kv | v2 | 9/9 | 644,546 | 35 | false | true |
| Codex/sol | 0 | http-kv | v3 | 9/9 | 466,232 | 24 | false | true |
| Codex/sol | 0 | dependency-planner | native | 7/7 | 414,427 | 14 | false | — |
| Codex/sol | 0 | dependency-planner | paper | 7/7 | 436,722 | 27 | false | true |
| Codex/sol | 0 | dependency-planner | v2 | 7/7 | 221,172 | 12 | false | true |
| Codex/sol | 0 | dependency-planner | v3 | 7/7 | 88,216 | 5 | false | true |
| OpenCode/terra | 0 | taskboard-cli | native | 8/8 | 252,563 | 12 | false | — |
| OpenCode/terra | 0 | taskboard-cli | paper | 8/8 | 271,908 | 17 | false | true |
| OpenCode/terra | 0 | taskboard-cli | v2 | 8/8 | 563,400 | 31 | false | true |
| OpenCode/terra | 0 | taskboard-cli | v3 | 8/8 | 265,725 | 14 | false | true |
| OpenCode/terra | 0 | csv-insights | native | 8/8 | 182,544 | 8 | false | — |
| OpenCode/terra | 0 | csv-insights | paper | 8/8 | 1,093,112 | 66 | false | true |
| OpenCode/terra | 0 | csv-insights | v2 | 8/8 | 158,392 | 9 | false | true |
| OpenCode/terra | 0 | csv-insights | v3 | 8/8 | 151,406 | 8 | false | true |
| OpenCode/terra | 0 | mini-template | native | 8/8 | 187,125 | 8 | false | — |
| OpenCode/terra | 0 | mini-template | paper | 7/8 | 159,735 | 10 | false | true |
| OpenCode/terra | 0 | mini-template | v2 | 7/8 | 120,808 | 7 | false | true |
| OpenCode/terra | 0 | mini-template | v3 | 7/8 | 112,811 | 6 | false | true |
| OpenCode/terra | 0 | http-kv | native | 9/9 | 241,039 | 10 | false | — |
| OpenCode/terra | 0 | http-kv | paper | 9/9 | 248,827 | 15 | false | true |
| OpenCode/terra | 0 | http-kv | v2 | 8/9 | 85,091 | 5 | false | true |
| OpenCode/terra | 0 | http-kv | v3 | 9/9 | 105,657 | 6 | false | true |
| OpenCode/terra | 0 | dependency-planner | native | 7/7 | 210,381 | 9 | false | — |
| OpenCode/terra | 0 | dependency-planner | paper | 7/7 | 347,737 | 21 | false | true |
| OpenCode/terra | 0 | dependency-planner | v2 | 7/7 | 235,005 | 13 | false | true |
| OpenCode/terra | 0 | dependency-planner | v3 | 7/7 | 448,286 | 24 | false | true |
| Codex/sol | 1 | taskboard-cli | v3 | 8/8 | 202,437 | 11 | false | true |
| Codex/sol | 1 | taskboard-cli | v2 | 8/8 | 251,273 | 15 | false | true |
| Codex/sol | 1 | csv-insights | v3 | 7/8 | 177,882 | 9 | false | true |
| Codex/sol | 1 | csv-insights | v2 | 8/8 | 133,887 | 8 | false | true |
| Codex/sol | 1 | mini-template | v3 | 8/8 | 186,590 | 10 | false | true |
| Codex/sol | 1 | mini-template | v2 | 8/8 | 132,629 | 8 | false | true |
| Codex/sol | 1 | http-kv | v3 | 9/9 | 385,635 | 20 | false | true |
| Codex/sol | 1 | http-kv | v2 | 9/9 | 594,022 | 32 | false | true |
| Codex/sol | 1 | dependency-planner | v3 | 7/7 | 115,131 | 6 | false | true |
| Codex/sol | 1 | dependency-planner | v2 | 7/7 | 161,407 | 9 | false | true |
| Codex/terra | 1 | taskboard-cli | v3 | 8/8 | 335,312 | 18 | false | true |
| Codex/terra | 1 | taskboard-cli | v2 | 8/8 | 361,310 | 20 | false | true |
| Codex/terra | 1 | csv-insights | v3 | 8/8 | 314,041 | 17 | false | true |
| Codex/terra | 1 | csv-insights | v2 | 8/8 | 135,267 | 8 | false | true |
| Codex/terra | 1 | mini-template | v3 | 7/8 | 174,102 | 10 | false | true |
| Codex/terra | 1 | mini-template | v2 | 8/8 | 207,801 | 12 | false | true |
| Codex/terra | 1 | http-kv | v3 | 9/9 | 254,995 | 14 | false | true |
| Codex/terra | 1 | http-kv | v2 | 9/9 | 704,007 | 39 | false | true |
| Codex/terra | 1 | dependency-planner | v3 | 7/7 | 397,825 | 22 | false | true |
| Codex/terra | 1 | dependency-planner | v2 | 7/7 | 287,134 | 17 | false | true |
| Codex/terra | 0 | taskboard-cli | native | 8/8 | 303,167 | 11 | false | — |
| Codex/terra | 0 | taskboard-cli | paper | 3/8 | 1,537,719 | 98 | true | false |
| Codex/terra | 0 | taskboard-cli | v2 | 8/8 | 191,536 | 11 | false | true |
| Codex/terra | 0 | taskboard-cli | v3 | 8/8 | 273,616 | 15 | false | true |
| Codex/terra | 0 | csv-insights | native | 7/8 | 352,044 | 12 | false | — |
| Codex/terra | 0 | csv-insights | paper | 8/8 | 1,522,817 | 98 | true | false |
| Codex/terra | 0 | csv-insights | v2 | 8/8 | 176,018 | 10 | false | true |
| Codex/terra | 0 | csv-insights | v3 | 8/8 | 154,446 | 9 | false | true |
| Codex/terra | 0 | mini-template | native | 8/8 | 142,200 | 7 | false | — |
| Codex/terra | 0 | mini-template | paper | 7/8 | 860,535 | 56 | false | true |
| Codex/terra | 0 | mini-template | v2 | 7/8 | 116,018 | 7 | false | true |
| Codex/terra | 0 | mini-template | v3 | 7/8 | 227,642 | 13 | false | true |
| Codex/terra | 0 | http-kv | native | 9/9 | 484,973 | 14 | false | — |
| Codex/terra | 0 | http-kv | paper | 0/9 | 1,633,487 | 106 | true | false |
| Codex/terra | 0 | http-kv | v2 | 9/9 | 182,936 | 11 | false | true |
| Codex/terra | 0 | http-kv | v3 | 9/9 | 250,950 | 14 | false | true |
| Codex/terra | 0 | dependency-planner | native | 7/7 | 244,413 | 12 | false | — |
| Codex/terra | 0 | dependency-planner | paper | 7/7 | 1,189,780 | 77 | false | true |
| Codex/terra | 0 | dependency-planner | v2 | 7/7 | 333,542 | 19 | false | true |
| Codex/terra | 0 | dependency-planner | v3 | 7/7 | 185,830 | 11 | false | true |
| Codex/sol | 2 | taskboard-cli | v2 | 8/8 | 184,024 | 11 | false | true |
| Codex/sol | 2 | taskboard-cli | v3 | 8/8 | 159,554 | 9 | false | true |
| Codex/sol | 2 | csv-insights | v2 | 8/8 | 117,328 | 7 | false | true |
| Codex/sol | 2 | csv-insights | v3 | 8/8 | 281,107 | 15 | false | true |
| Codex/sol | 2 | mini-template | v2 | 8/8 | 154,242 | 9 | false | true |
| Codex/sol | 2 | mini-template | v3 | 8/8 | 159,066 | 9 | false | true |
| Codex/sol | 2 | http-kv | v2 | 9/9 | 257,014 | 15 | false | true |
| Codex/sol | 2 | http-kv | v3 | 9/9 | 320,536 | 17 | false | true |
| Codex/sol | 2 | dependency-planner | v2 | 7/7 | 352,735 | 19 | false | true |
| Codex/sol | 2 | dependency-planner | v3 | 7/7 | 619,015 | 31 | false | true |
| Codex/terra | 2 | taskboard-cli | v2 | 8/8 | 171,786 | 10 | false | true |
| Codex/terra | 2 | taskboard-cli | v3 | 8/8 | 195,679 | 11 | false | true |
| Codex/terra | 2 | csv-insights | v2 | 8/8 | 174,936 | 10 | false | true |
| Codex/terra | 2 | csv-insights | v3 | 8/8 | 194,724 | 11 | false | true |
| Codex/terra | 2 | mini-template | v2 | 7/8 | 134,307 | 8 | false | true |
| Codex/terra | 2 | mini-template | v3 | 7/8 | 154,120 | 9 | false | true |
| Codex/terra | 2 | http-kv | v2 | 9/9 | 264,593 | 15 | false | true |
| Codex/terra | 2 | http-kv | v3 | 9/9 | 419,910 | 23 | false | true |
| Codex/terra | 2 | dependency-planner | v2 | 7/7 | 292,964 | 17 | false | true |
| Codex/terra | 2 | dependency-planner | v3 | 7/7 | 373,131 | 21 | false | true |
