// Isolated native/paper campaign copy; never run analysis scripts in the prior campaign.
// Campaign-local copy of ../article-20260904/archive-workspaces.ts; outputs stay in this separate series.
import path from "node:path"
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises"

// Post-run preservation only: this script never executes or modifies generated code.
const root = path.resolve(import.meta.dir, "../..")
const data = await Bun.file(path.join(import.meta.dir, "data.json")).json()
const excludedDirectories = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache"])
let archived = 0
for (const row of data.rows) {
  const summary = await Bun.file(path.join(root, row.source)).json()
  const workspace = await realpath(summary.workspace)
  const parentName = row.runtime === "OpenCode" ? "opencode-skill-state-one-shot" : "codex-skill-state-one-shot"
  const expectedSuffix = `/${parentName}/${row.suite}/${summary.mode}/${row.project}`
  if (!workspace.endsWith(expectedSuffix)) throw new Error(`Unexpected workspace: ${workspace}`)
  const output = path.join(root, path.dirname(row.source), "workspace")
  const manifestPath = path.join(root, path.dirname(row.source), "workspace-manifest.json")
  if (await Bun.file(manifestPath).exists()) continue
  const files: Array<{ path: string, bytes: number, sha256: string }> = []
  const skipped: Array<{ path: string, reason: string }> = []
  let total = 0
  async function visit(relative = "") {
    for (const name of (await readdir(path.join(workspace, relative))).sort()) {
      const item = path.join(relative, name)
      const source = path.join(workspace, item)
      const stat = await lstat(source)
      if (stat.isSymbolicLink()) { skipped.push({ path: item, reason: "symlink not followed" }); continue }
      if (stat.isDirectory()) {
        if (excludedDirectories.has(name)) { skipped.push({ path: item, reason: "dependency/cache/VCS directory" }); continue }
        await visit(item)
        continue
      }
      if (!stat.isFile()) { skipped.push({ path: item, reason: "not a regular file" }); continue }
      if (name === ".env" || name.startsWith(".env.") || /^(credentials|auth)\.json$/.test(name)) {
        skipped.push({ path: item, reason: "potential secret-bearing configuration" }); continue
      }
      if (stat.size > 5 * 1024 * 1024 || total + stat.size > 20 * 1024 * 1024) {
        skipped.push({ path: item, reason: "archive size limit" }); continue
      }
      const destination = path.join(output, item)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(source, destination)
      const bytes = new Uint8Array(await Bun.file(destination).arrayBuffer())
      files.push({ path: item, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") })
      total += bytes.length
    }
  }
  await visit()
  await Bun.write(manifestPath, JSON.stringify({
    capturedAt: new Date().toISOString(), sourceWorkspace: workspace,
    phase: "after runner completion and external evaluation", files, skipped,
  }, null, 2) + "\n")
  archived++
}
console.log(JSON.stringify({ newlyArchived: archived, completedCells: data.rows.length }))

