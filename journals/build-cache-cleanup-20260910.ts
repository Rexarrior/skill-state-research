import path from "node:path"
import { lstat, rm, statfs } from "node:fs/promises"

// User-authorized, explicit cache allowlist. Keep frozen executables and all experiment logs.
const root = path.resolve(import.meta.dir, "..")
const targets = [
  "codex/codex-rs/target",
  "experiments/codex-astra-large-context-20260908/.private/source/codex/codex-rs/target",
  "experiments/codex-paper2-20260910/.private/source/codex/codex-rs/target",
  "experiments/codex-paper2-small-context-20260910/.private/source/codex/codex-rs/target",
]
const children = ["debug/deps", "debug/build", "debug/incremental", "debug/.fingerprint",
  "debug/gn_out", "debug/examples", "debug/codex-exec", "debug/codex.d", "tmp"]
const receipt = path.join(import.meta.dir, "BUILD-CACHE-CLEANUP-20260910.json")
if (await Bun.file(receipt).exists()) throw new Error("Cleanup already recorded; inspect before repeating")
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())).digest("hex")
const free = async () => { const fs = await statfs(root); return fs.bavail * fs.bsize }
const binaries = targets.flatMap(target => ["codex", "codex-code-mode-host"].map(name => path.join(target, "debug", name)))
const fingerprints: Record<string, string> = {}
for (const binary of binaries) fingerprints[binary] = await hash(binary)
const paths = []
for (const target of targets) {
  // Reject symlinked ancestors too; no deletion may escape the four validated build trees.
  let ancestor = root
  for (const component of target.split("/")) {
    ancestor = path.join(ancestor, component)
    const info = await lstat(ancestor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe build directory: " + ancestor)
  }
  const debug = await lstat(path.join(root, target, "debug"))
  if (!debug.isDirectory() || debug.isSymbolicLink()) throw new Error("Unsafe debug directory")
  for (const child of children) {
    const relative = path.join(target, child)
    const info = await lstat(path.join(root, relative)).catch(error => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (!info) continue
    if (info.isSymbolicLink()) throw new Error("Review symlink cache separately: " + relative)
    paths.push(relative)
  }
}
const manifest = await Bun.file(path.join(root,
  "experiments/codex-paper2-small-context-20260910/source-manifest.json")).json()
for (const file of Object.keys(manifest.files))
  if (paths.some(target => file === target || file.startsWith(target + "/")))
    throw new Error("Would remove an active frozen source: " + file)
const record = { startedAt: new Date().toISOString(), endedAt: null as string | null,
  status: "running", beforeAvailableBytes: await free(), afterAvailableBytes: null as number | null,
  planned: paths, removed: [] as string[], binaries: fingerprints, verifiedAfter: false,
  errors: [] as string[],
  note: "Cleanup overlaps an active Paper2-small campaign and can affect wall-clock timings. Eight frozen executables, nextest logs, all source code, model results and reports are retained. du sizes of APFS clones are not additive physical usage." }
await Bun.write(receipt, JSON.stringify(record, null, 2) + "\n")
for (const relative of paths) {
  await rm(path.join(root, relative), { recursive: true, force: false })
  record.removed.push(relative)
  await Bun.write(receipt, JSON.stringify(record, null, 2) + "\n")
  console.log(JSON.stringify({ removed: relative, done: record.removed.length, total: paths.length }))
}
for (const [file, expected] of Object.entries(fingerprints))
  if (await hash(file) !== expected) record.errors.push("Executable changed: " + file)
for (const [file, expected] of Object.entries(manifest.files))
  if (await hash(file) !== expected) record.errors.push("Active frozen source changed: " + file)
record.verifiedAfter = record.errors.length === 0
record.status = record.verifiedAfter ? "complete" : "needs-attention"
record.endedAt = new Date().toISOString()
record.afterAvailableBytes = await free()
await Bun.write(receipt, JSON.stringify(record, null, 2) + "\n")
console.log(JSON.stringify({ status: record.status, removed: record.removed.length,
  freedAvailableGiB: (record.afterAvailableBytes - record.beforeAvailableBytes) / 1024 ** 3,
  availableGiB: record.afterAvailableBytes / 1024 ** 3, preservedExecutables: binaries.length,
  activeManifestVerified: record.verifiedAfter }))
if (!record.verifiedAfter) process.exitCode = 1
