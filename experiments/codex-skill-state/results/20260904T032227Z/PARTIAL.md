# Partially interrupted Terra suite

The first ten cells in this suite completed cleanly. The remaining five cells encountered a host/network interruption
(`No route to host`) and/or timed out: `http-kv` v2/v3 and all three `dependency-planner` modes. Those five cells are not
valid model outcomes and must not be interpreted as token savings or failures.

Only the failed cells were repeated in fresh workspaces with one active runner. The authoritative composite report is
[`20260904T114822Z`](../20260904T114822Z/report.md); it combines the ten clean cells here with five clean retries while
retaining source provenance.
