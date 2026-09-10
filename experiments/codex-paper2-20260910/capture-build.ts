import path from "node:path"

const here = import.meta.dir
const source = path.join(here, ".private/source")
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: source, stdout: "pipe", stderr: "pipe" })
  const output = await new Response(proc.stdout).text()
  if (await proc.exited) throw new Error("Source provenance command failed")
  return output.trim()
}
if (await Bun.file(path.join(here, "build-manifest.json")).exists())
  throw new Error("Build record already exists; never replace a frozen build")
const baseCommit = await git("rev-parse", "HEAD")
if (baseCommit !== "85630a5b6d89465ed52cdb0ad56eec15f07fdfae") throw new Error("Unexpected source base")
if (await git("ls-files", "--others", "--exclude-standard", "--", "codex"))
  throw new Error("Untracked source; include explicitly in patch before capture")
const patch = await Bun.file(path.join(here, "kernel.patch")).text()
if (patch.trim() !== await git("diff", "--binary", "HEAD", "--", "codex"))
  throw new Error("Saved patch differs from tested sources")
const changed = (await git("diff", "--name-only", "HEAD", "--", "codex")).split("\n")
const files: Record<string, string> = {}
for (const file of [...changed, "codex/codex-rs/Cargo.lock", "codex/codex-rs/Cargo.toml", "codex/codex-rs/rust-toolchain.toml"])
  files[path.join(".private/source", file)] = await hash(path.join(source, file))
const executable = path.join(source, "codex/codex-rs/target/debug/codex")
const companion = path.join(source, "codex/codex-rs/target/debug/codex-code-mode-host")
const previous = await Bun.file(path.join(here, "../codex-astra-large-context-20260908/build-manifest.json")).json()
const previousExecutable = path.join(here, "../codex-astra-large-context-20260908/.private/source/codex/codex-rs/target/debug/codex")
if (await hash(previousExecutable) !== previous.executableSha256) throw new Error("Historical binary changed")
const executableSha256 = await hash(executable)
if (executableSha256 === previous.executableSha256) throw new Error("Paper2 CLI not rebuilt")
const codeModeHostSha256 = await hash(companion)
if (codeModeHostSha256 !== previous.codeModeHostSha256) throw new Error("Companion unexpectedly changed")
await Bun.write(path.join(here, "build-manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(),
  baseCommit, patchSha256: await hash(path.join(here, "kernel.patch")), files,
  executableSha256, codeModeHostSha256, historicalExecutableSha256: previous.executableSha256,
  limitsBytes: previous.limitsBytes, mode: "paper2", protocol: "skill.state/paper2",
  observationWindow: 1, comment: false, modelRevision: false,
  source: "Separate sparse worktree; Paper2 changes only the latest observation versus large-context Paper."
}, null, 2) + "\n")
console.log(JSON.stringify({ executableSha256, historicalExecutablePreserved: true }))
