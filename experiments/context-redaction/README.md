# Post-redaction artifact integrity

This directory records the publishable artifact snapshot after NDA-context redaction and repair of two archived Bun lockfiles. It does not rerun the experiments or reconstruct the removed context.

## Historical versus current fingerprints

The original `source-manifest.json` and `workspace-manifest.json` files remain unchanged. Their hashes describe historical bytes, including context that is no longer published. Historical Git commit identifiers may no longer resolve after the privacy-related history rewrite.

`artifact-manifest.json` records each covered file's **current** SHA-256 and byte size separately from its `historical` fingerprints and their source manifests. Files without an original recorded fingerprint are explicitly marked as such. Recorded differences are classified as context redaction, public registry URL repair, or verification adaptation. This classification documents known changes; it is not a proof that every redaction was correctly scoped.

Verification requires both a recognized historical fingerprint and an exact match to the cleaned snapshot. It does not accept arbitrary hash mismatches. The independently edited article and its index are explicit exclusions from the frozen snapshot; the article checker still validates data, figures and links. Generated verification receipts are also excluded to allow repeated checks.

## Lockfile repair

Only the tarball URLs in the baseline and state `mini-template` lockfiles from `20260904T195726Z` were changed. The replacement URLs came from public npm package metadata. All 25 unique packages passed metadata integrity comparison and HTTP HEAD checks. Versions, dependency metadata and SHA-512 integrity strings were preserved. See `registry-verification.json` for the checked URLs and integrity values.

`bun experiments/context-redaction/repair-lock-urls.ts` performs a network-backed dry check. `--apply` explicitly repairs the two files and writes the receipt. No dependency installation is needed.

## Local checks

From the repository root:

```sh
bun test ./experiments/context-redaction/integrity.test.ts
bun experiments/context-redaction/verify.ts
bun experiments/article-20260904/verify-publication.ts
bun experiments/codex-sol-repeats-20260906/verify.ts
bun experiments/codex-sol-controls-20260906/verify.ts
bun articles/update-20260906/verify.ts
```

New check results go to `verification/`; historical QA receipts, results and manifests are not overwritten. The repeat/control checks explicitly report historical executables as `not-rechecked` when their host paths were redacted or their binaries are unavailable. Passing artifact checks therefore does not imply that those executables were verified again.

`capture.ts` creates the snapshot once and refuses to overwrite it. Use `--replace-reviewed` only after deliberately reviewing subsequent artifact changes; never regenerate the snapshot merely to make a failing check pass. Historical analysis/collection commands remain historical and should not be rerun to update frozen data after redaction.
