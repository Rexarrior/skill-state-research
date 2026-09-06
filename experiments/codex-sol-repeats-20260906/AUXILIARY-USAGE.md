# Codex auxiliary usage

Status: complete. Main-loop counters are kept separate from linked descendants.

These are observed completed-response tokens, not billed costs. Descendants may use a different model; their model IDs and parent links are retained in [the underlying records](./auxiliary-usage.json). No prompts or reasoning are exported by this collector. Zero means no recorded descendant usage found, not a guarantee that an interrupted request was free.

| Model | Rep | Mode | Cells | Main input | Auxiliary input | Observed combined input | Auxiliary output |
|---|---:|---|---:|---:|---:|---:|---:|
| sol | 1 | v2 | 5 | 873,982 | 85,582 | 959,564 | 461 |
| sol | 1 | v3 | 5 | 1,242,029 | 49,861 | 1,291,890 | 323 |
| sol | 2 | v2 | 5 | 907,242 | 34,821 | 942,063 | 341 |
| sol | 2 | v3 | 5 | 1,098,641 | 39,626 | 1,138,267 | 402 |
| sol | 3 | v2 | 5 | 799,487 | 33,606 | 833,093 | 303 |
| sol | 3 | v3 | 5 | 1,496,599 | 49,938 | 1,546,537 | 252 |
| sol | 4 | v2 | 5 | 742,748 | 18,993 | 761,741 | 251 |
| sol | 4 | v3 | 5 | 901,770 | 62,169 | 963,939 | 518 |
| sol | 5 | v2 | 5 | 1,254,538 | 58,331 | 1,312,869 | 301 |
| sol | 5 | v3 | 5 | 1,584,507 | 139,945 | 1,724,452 | 574 |
| sol | 6 | v2 | 5 | 896,417 | 43,206 | 939,623 | 291 |
| sol | 6 | v3 | 5 | 1,686,196 | 186,738 | 1,872,934 | 804 |
| sol | 7 | v2 | 5 | 1,271,468 | 335,218 | 1,606,686 | 928 |
| sol | 7 | v3 | 5 | 1,420,084 | 53,874 | 1,473,958 | 455 |
| sol | 8 | v2 | 5 | 1,315,103 | 443,516 | 1,758,619 | 1,641 |
| sol | 8 | v3 | 5 | 909,644 | 19,154 | 928,798 | 141 |
| sol | 9 | v2 | 5 | 742,593 | 12,829 | 755,422 | 203 |
| sol | 9 | v3 | 5 | 1,162,693 | 139,541 | 1,302,234 | 721 |
| sol | 10 | v2 | 5 | 991,060 | 107,979 | 1,099,039 | 621 |
| sol | 10 | v3 | 5 | 1,566,447 | 247,350 | 1,813,797 | 779 |
