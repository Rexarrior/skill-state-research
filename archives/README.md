# Archived experiment artifacts

## raw-experiment-private-20260911.tar.zst

Compressed raw artifacts from the Codex repeat and Paper2 benchmark runs.

- Created: 2026-09-11
- Archive size: approximately 18 MiB
- Uncompressed size: 471,449,600 bytes
- Entries: 5,480
- SHA-256: `9c4af498adca19799933f9b4a18883d8a43ceb3c22ea6535af69e5a091771498`

The archive contains the ignored `.private` trees from:

- `experiments/codex-astra-repeats-20260908`
- `experiments/codex-sol-large-context-20260909`
- `experiments/codex-astra-large-context-20260908`
- `experiments/codex-sol-clean-20260908`
- `experiments/codex-paper2-20260910`
- `experiments/codex-paper2-small-context-20260910`

It preserves raw results, stdout/stderr logs, isolation metadata, and small
verification workspaces. Rebuildable `.private/source` copies were excluded.

Verify:

```bash
zstd -t archives/raw-experiment-private-20260911.tar.zst
shasum -a 256 archives/raw-experiment-private-20260911.tar.zst
```

Restore from the repository root:

```bash
zstd -dc archives/raw-experiment-private-20260911.tar.zst | tar -xf -
```
