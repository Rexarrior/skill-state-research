import path from "node:path"
import { artifactDigest, editorialFiles, manifestFile, type ArtifactManifest } from "../../scripts/artifact-integrity"

const root = path.resolve(import.meta.dir, "../..")
const destination = path.join(root, manifestFile)
if (await Bun.file(destination).exists() && !process.argv.includes("--replace-reviewed"))
  throw new Error("Manifest exists. Review changes explicitly before using --replace-reviewed.")
const git = (...args: string[]) => {
  const command = Bun.spawnSync(["git", ...args], { cwd: root })
  if (command.exitCode !== 0) throw new Error("Git enumeration failed")
  return command.stdout.toString()
}
const names = [...new Set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean))]
const historical = new Map<string, ArtifactManifest["files"][string]["historical"]>()
const add = (file: string, sha256: string, manifest: string, bytes?: number) => {
  const values = historical.get(file) ?? []
  if (!values.some(v => v.sha256 === sha256 && v.manifest === manifest && v.bytes === bytes))
    values.push({ sha256, ...(bytes === undefined ? {} : { bytes }), manifest })
  historical.set(file, values)
}
const historicalManifests = ["article-20260904", "codex-sol-repeats-20260906", "codex-sol-controls-20260906"]
  .map(name => `experiments/${name}/source-manifest.json`)
for (const file of historicalManifests) {
  const manifest = await Bun.file(path.join(root, file)).json()
  for (const [name, hash] of Object.entries({ ...(manifest.source?.files ?? manifest.files), ...manifest.protectedFiles }))
    add(name, hash as string, file)
}
for (const file of names.filter(n => n.endsWith("/workspace-manifest.json"))) {
  const manifest = await Bun.file(path.join(root, file)).json()
  for (const entry of manifest.files)
    add(path.posix.join(path.posix.dirname(file), "workspace", entry.path), entry.sha256, file, entry.bytes)
}
const adapted = new Set([
  "articles/update-20260906/verify.ts", "experiments/article-20260904/verify-publication.ts",
  "experiments/codex-sol-controls-20260906/verify.ts", "experiments/codex-sol-repeats-20260906/verify.ts",
  "experiments/article-20260904/host-context-audit.ts", "experiments/codex-sol-repeats-20260906/host-context-audit.ts",
])
const locks = new Set(["baseline", "skill-state"].map(mode =>
  `experiments/skill-state/results/20260904T195726Z/${mode}/mini-template/workspace/bun.lock`))
const selected = [...new Set([...names.filter(file =>
  file.startsWith("experiments/") || file.startsWith("articles/") || file === "scripts/artifact-integrity.ts"),
  ...historical.keys()])].filter(file => !editorialFiles.includes(file) && file !== manifestFile &&
    !file.startsWith("experiments/context-redaction/verification/")).sort()
const files: ArtifactManifest["files"] = {}
for (const file of selected) {
  const digest = await artifactDigest(path.join(root, file))
  const prior = historical.get(file) ?? []
  const differs = prior.some(p => p.sha256 !== digest.sha256)
  const redacted = differs && (await Bun.file(path.join(root, file)).text()).includes("<nda context deleted, size :")
  if (differs && !redacted && !adapted.has(file) && !locks.has(file))
    throw new Error(`Unexplained historical mismatch: ${file}`)
  files[file] = { ...digest, historical: prior,
    reason: differs ? locks.has(file) ? "public-registry-url-repair" : adapted.has(file) ? "verification-adaptation" : "context-redaction"
      : prior.length ? "unchanged" : "cleaned-snapshot-no-historical-fingerprint" }
}
await Bun.write(destination, JSON.stringify({ version: 1, capturedAt: new Date().toISOString(),
  baselineCommit: git("rev-parse", "HEAD").trim(), editorialExclusions: editorialFiles,
  scope: "Post-redaction artifact snapshot. Historical fingerprints are provenance, not the expected bytes of redacted files. This does not reconstruct deleted text or certify the classification of every removed fragment.",
  historicalManifests, files,
}, null, 2) + "\n")
console.log(JSON.stringify({ files: selected.length, changedFromHistorical: Object.values(files).filter(f => f.historical.some(h => h.sha256 !== f.sha256)).length }))
