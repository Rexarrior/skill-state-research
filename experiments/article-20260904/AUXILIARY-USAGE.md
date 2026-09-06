# Codex auxiliary usage

Status: complete. Main-loop counters are kept separate from linked descendants.

These are observed completed-response tokens, not billed costs. Descendants may use a different model; their model IDs and parent links are retained in [the underlying records](./auxiliary-usage.json). No prompts or reasoning are exported by this collector. Zero means no recorded descendant usage found, not a guarantee that an interrupted request was free.

| Model | Rep | Mode | Cells | Main input | Auxiliary input | Observed combined input | Auxiliary output |
|---|---:|---|---:|---:|---:|---:|---:|
| sol | 0 | native | 5 | 1,640,364 | 80,019 | 1,720,383 | 796 |
| sol | 0 | paper | 5 | 4,185,286 | 183,637 | 4,368,923 | 819 |
| sol | 0 | v2 | 5 | 1,397,264 | 394,246 | 1,791,510 | 1,056 |
| sol | 0 | v3 | 5 | 1,280,086 | 144,581 | 1,424,667 | 544 |
| sol | 1 | v3 | 5 | 1,067,675 | 248,569 | 1,316,244 | 603 |
| sol | 1 | v2 | 5 | 1,273,218 | 395,077 | 1,668,295 | 1,112 |
| terra | 1 | v3 | 5 | 1,476,275 | 552,113 | 2,028,388 | 2,152 |
| terra | 1 | v2 | 5 | 1,695,519 | 160,982 | 1,856,501 | 1,199 |
| terra | 0 | native | 5 | 1,526,797 | 122,687 | 1,649,484 | 926 |
| terra | 0 | paper | 5 | 6,744,338 | 0 | 6,744,338 | 0 |
| terra | 0 | v2 | 5 | 1,000,050 | 89,764 | 1,089,814 | 644 |
| terra | 0 | v3 | 5 | 1,092,484 | 200,815 | 1,293,299 | 1,524 |
| sol | 2 | v2 | 5 | 1,065,343 | 313,650 | 1,378,993 | 1,544 |
| sol | 2 | v3 | 5 | 1,539,278 | 151,828 | 1,691,106 | 656 |
| terra | 2 | v2 | 5 | 1,038,586 | 170,732 | 1,209,318 | 1,264 |
| terra | 2 | v3 | 5 | 1,337,564 | 200,104 | 1,537,668 | 1,187 |
