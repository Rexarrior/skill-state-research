# Invalid binary-provenance probe

This probe is not SKILL.state evidence. It scored 7/7 but the persisted rollout contained zero `skill_step` calls.
Sharing one Cargo target directory between the pristine checkout and the research checkout caused the CLI to be linked
against a cached pristine `codex-core` artifact. The affected binary SHA-256 was
`a0c4947f39d13bbf680f4b6085b15bca372de6418b31f099e096be9b49913252`.

The package-scoped `codex-core` and `codex-cli` build artifacts were cleaned and rebuilt from the research checkout.
Later probes must contain persisted `skill_step` transitions before they are accepted.
