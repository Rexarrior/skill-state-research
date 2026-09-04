# Invalid partial Sol suite

This suite was stopped after the first two projects and must not be used for aggregate comparison. A preceding
`cargo clean` removed `codex-code-mode-host`, so baseline silently fell back from Code Mode to direct tools. Its first
two evaluator results were 1/8 and 2/8 and are infrastructure-contaminated.

The harness now rejects a missing or non-executable companion before starting. The authoritative clean Sol suite is
[`20260904T023020Z`](../20260904T023020Z/report.md); no cell from this directory is included in that report.
