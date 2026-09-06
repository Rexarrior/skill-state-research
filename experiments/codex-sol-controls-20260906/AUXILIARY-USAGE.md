# Codex auxiliary usage

Status: complete. Main-loop counters are kept separate from linked descendants.

These are observed completed-response tokens, not billed costs. Descendants may use a different model; their model IDs and parent links are retained in [the underlying records](./auxiliary-usage.json). No prompts or reasoning are exported by this collector. Zero means no recorded descendant usage found, not a guarantee that an interrupted request was free.

| Model | Rep | Mode | Cells | Main input | Auxiliary input | Observed combined input | Auxiliary output |
|---|---:|---|---:|---:|---:|---:|---:|
| sol | 1 | native | 5 | 1,933,670 | 66,616 | 2,000,286 | 426 |
| sol | 1 | paper | 5 | 2,307,093 | 19,860 | 2,326,953 | 190 |
| sol | 2 | native | 5 | 1,932,550 | 128,297 | 2,060,847 | 682 |
| sol | 2 | paper | 5 | 2,148,815 | 89,851 | 2,238,666 | 499 |
| sol | 3 | native | 5 | 1,800,378 | 40,762 | 1,841,140 | 386 |
| sol | 3 | paper | 5 | 2,076,298 | 13,705 | 2,090,003 | 183 |
| sol | 4 | native | 5 | 1,879,196 | 83,193 | 1,962,389 | 626 |
| sol | 4 | paper | 5 | 2,642,086 | 84,293 | 2,726,379 | 440 |
| sol | 5 | native | 5 | 2,167,098 | 61,160 | 2,228,258 | 350 |
| sol | 5 | paper | 5 | 2,904,115 | 89,647 | 2,993,762 | 489 |
| sol | 6 | native | 5 | 2,238,863 | 64,717 | 2,303,580 | 404 |
| sol | 6 | paper | 5 | 3,326,013 | 18,362 | 3,344,375 | 448 |
| sol | 7 | native | 5 | 2,014,289 | 53,149 | 2,067,438 | 322 |
| sol | 7 | paper | 5 | 6,837,664 | 0 | 6,837,664 | 0 |
| sol | 8 | native | 5 | 1,947,012 | 71,295 | 2,018,307 | 420 |
| sol | 8 | paper | 5 | 2,788,874 | 20,698 | 2,809,572 | 337 |
| sol | 9 | native | 5 | 1,516,461 | 11,599 | 1,528,060 | 147 |
| sol | 9 | paper | 5 | 2,992,921 | 87,521 | 3,080,442 | 666 |
| sol | 10 | native | 5 | 2,058,016 | 62,954 | 2,120,970 | 385 |
| sol | 10 | paper | 5 | 4,294,795 | 45,067 | 4,339,862 | 283 |
