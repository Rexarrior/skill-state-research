import path from "node:path"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const source = path.join(here, ".private/source")
const baseCommit = "85630a5b"
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: source, stdout: "pipe", stderr: "pipe" })
  const output = await new Response(proc.stdout).text()
  if (await proc.exited) throw new Error("Source provenance git command failed")
  return output.trim()
}
if (await Bun.file(path.join(here, "build-manifest.json")).exists())
  throw new Error("Build record already exists; never replace a frozen build")
if (await git("rev-parse", "HEAD") !== await git("rev-parse", baseCommit))
  throw new Error("Unexpected source base")
const changed = [
  "codex/codex-rs/core/src/skill_state.rs",
  "codex/codex-rs/core/src/skill_state_history.rs",
  "codex/codex-rs/core/src/skill_state_tests.rs",
  "codex/codex-rs/core/src/tools/parallel.rs",
  "codex/codex-rs/exec/tests/suite/skill_state_v2.rs",
].sort()
const actual = (await git("diff", "--name-only", "HEAD", "--", "codex")).split("\n").sort()
if (JSON.stringify(actual) !== JSON.stringify(changed) ||
    await git("ls-files", "--others", "--exclude-standard", "--", "codex"))
  throw new Error("Unexpected source changes; inspect instead of widening the allowlist")
const patch = await Bun.file(path.join(here, "kernel.patch")).text()
if (patch.trim() !== await git("diff", "--binary", "HEAD", "--", "codex"))
  throw new Error("Saved patch differs from the tested build")
const files: Record<string, string> = {}
for (const file of [...changed, "codex/codex-rs/Cargo.lock", "codex/codex-rs/Cargo.toml",
  "codex/codex-rs/rust-toolchain.toml"])
  files[path.join(".private/source", file)] = await hash(path.join(source, file))
const oldExecutableSha256 = await hash(path.join(root, "codex/codex-rs/target/debug/codex"))
const codeModeHostSha256 = await hash(path.join(source, "codex/codex-rs/target/debug/codex-code-mode-host"))
if (oldExecutableSha256 !== "24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc" ||
    codeModeHostSha256 !== "b5ce3a2a9d1c65389c5fb32fa2b734251b644929d039cf4867683d39a90b9630")
  throw new Error("Historical executable/companion changed")
const executableSha256 = await hash(path.join(source, "codex/codex-rs/target/debug/codex"))
if (executableSha256 === oldExecutableSha256) throw new Error("Experimental binary was not rebuilt")
await Bun.write(path.join(here, "build-manifest.json"), JSON.stringify({
  capturedAt: new Date().toISOString(), baseCommit: await git("rev-parse", "HEAD"),
  patchSha256: await hash(path.join(here, "kernel.patch")), files,
  executableSha256, oldExecutableSha256, codeModeHostSha256,
  limitsBytes: { state: 2097152, actionInput: 2097152, observationInput: 2097152,
    observationResult: 2097152, comment: 1024 },
  build: "cargo build --offline -p codex-cli --bin codex (default dev profile)",
  source: "Detached sparse worktree; original source and executable are untouched.",
  history: "Per-transition persisted fallback allowance prevents JSON container truncation.",
}, null, 2) + "\n")
console.log(JSON.stringify({ executableSha256, oldExecutablePreserved: true, codeModeHostSha256 }))
