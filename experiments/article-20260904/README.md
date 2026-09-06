# Technical article experiment package

Completed on 2026-09-05 UTC: all 120 planned cells are preserved. This directory separates the publication campaign
from earlier exploratory runs. Historical cells are not substituted into its four-mode comparison.

## Read

- [Protocol and exclusion rules](./PROTOCOL.md).
- [Paper conformance audit](../PAPER-CONFORMANCE.md), including deliberate transport/domain adaptations.
- [Source manifest](./source-manifest.json) and [patch against the recorded base commit](./source.patch).
- [Host runtime versions](./environment.json) and [independent usage checks](./usage-audit.json).
- [Recorded startup-context fingerprints](./host-context-audit.json): host instructions were not fully disabled.
- [Kernel and CLI verification](./VERIFICATION.md).
- [Campaign report](./REPORT.md), [per-cell data](./data.json), and [suite inventory](./suites.json).
- [Raw-trace checks](./trace-audit.json), [verified repeated-command example](./trace-cases.json),
  and [auxiliary reviewer usage](./AUXILIARY-USAGE.md).
- [Ready technical article](../../articles/skill-state-in-coding-agents.md), [figure](../../articles/figures/input-by-task.png),
  and [final publication QA](./publication-qa.json): table consistency, local links, and 441 archived file hashes.

Every suite contains one summary and raw session logs per cell. Completed workspaces are copied alongside them
under `workspace/`, with a `workspace-manifest.json` containing hashes and explicitly skipped paths. These are
post-evaluation snapshots; dependency, VCS and cache directories are excluded, and symlinks are not followed.
The task specifications and evaluator are versioned in the repository and hashed in the source manifest.

## Regenerate analysis

From the repository root, using Bun and an isolated Python environment with Matplotlib:

```sh
bun experiments/article-20260904/build-report.ts
bun experiments/article-20260904/audit-traces.ts
bun experiments/article-20260904/verify-usage.ts
bun experiments/article-20260904/trace-cases.ts
bun experiments/article-20260904/host-context-audit.ts
bun experiments/article-20260904/publication-tables.ts
uv run --with matplotlib python experiments/article-20260904/plot.py
bun experiments/article-20260904/scan-artifacts.ts
bun experiments/article-20260904/verify-publication.ts
```

`build-report.ts` refuses a final report unless all 120 planned cells are present, source hashes still match,
and the same Codex binary and Code Mode companion were used. `--partial` is for monitoring only.

The two preservation scripts use the original host's temporary workspaces/session storage:

```sh
bun experiments/article-20260904/archive-workspaces.ts
bun experiments/article-20260904/auxiliary-usage.ts
```

Their outputs are retained so readers do not need access to those host paths. The auxiliary file contains only
usage records of linked descendants, not their prompts or reasoning. The primary table remains main-loop usage;
neither it nor the auxiliary sum is an invoice estimate.

## Run models again

Use the existing runners with a configured provider and the recorded patched binaries. Start at most two cells
globally; set Codex `CODEX_SKILL_STATE_MAX_CONCURRENCY=1` for each sequential lane. A runner creates a new suite
and fresh per-cell directories rather than overwriting these observations. Required model IDs and settings are
in the source suite summaries. Do not use the old retry-failed convenience sweep for this campaign: timeouts and
model failures are outcomes, and the protocol permits replacement only with explicit infrastructure evidence.
