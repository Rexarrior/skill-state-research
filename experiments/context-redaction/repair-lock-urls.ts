import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const files = ["baseline", "skill-state"].map(mode =>
  `experiments/skill-state/results/20260904T195726Z/${mode}/mini-template/workspace/bun.lock`)
const inputs = await Promise.all(files.map(async file => {
  const text = await Bun.file(path.join(root, file)).text()
  return { file, text, lock: JSON.parse(text.replace(/,\s*([}\]])/g, "$1")) }
}))
const packages = new Map<string, { url: string; integrity: string }>()
for (const input of inputs) for (const [name, value] of Object.entries(input.lock.packages)) {
  const tuple = value as [string, string, unknown, string]
  if (packages.has(tuple[0])) {
    if (packages.get(tuple[0])!.integrity !== tuple[3]) throw new Error("Inconsistent lockfile integrity")
    continue
  }
  const version = tuple[0].slice(name.length + 1)
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Registry metadata unavailable: ${tuple[0]}/${response.status}`)
  const metadata = await response.json()
  if (metadata.dist.integrity !== tuple[3]) throw new Error(`Registry integrity differs: ${tuple[0]}`)
  const url = new URL(metadata.dist.tarball)
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") throw new Error("Unexpected tarball host")
  const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) })
  if (!head.ok) throw new Error(`Tarball unavailable: ${tuple[0]}/${head.status}`)
  packages.set(tuple[0], { url: url.href, integrity: tuple[3] })
}
// Validate the complete set before writing either file; preserve all tuple fields
// except the tarball URL, including versions, platform constraints and integrity.
const repaired = inputs.map(input => {
  let text = input.text
  for (const value of Object.values(input.lock.packages)) {
    const tuple = value as [string, string, unknown, string]
    text = text.replaceAll(JSON.stringify(tuple[1]), JSON.stringify(packages.get(tuple[0])!.url))
  }
  const after = JSON.parse(text.replace(/,\s*([}\]])/g, "$1"))
  for (const [name, value] of Object.entries(after.packages)) (value as unknown[])[1] = input.lock.packages[name][1]
  if (JSON.stringify(after) !== JSON.stringify(input.lock)) throw new Error("Non-URL lockfile change")
  return { file: input.file, text }
})
if (process.argv.includes("--apply")) {
  for (const input of repaired) await Bun.write(path.join(root, input.file), input.text)
  await Bun.write(path.join(import.meta.dir, "registry-verification.json"), JSON.stringify({
    checkedAt: new Date().toISOString(), files,
    packages: Object.fromEntries(packages), metadataIntegrityMatches: true, tarballHeadChecks: packages.size,
    unchanged: "Package versions, dependency graph, platform constraints and integrity fields.",
  }, null, 2) + "\n")
}
console.log(JSON.stringify({ packages: packages.size, files: files.length, applied: process.argv.includes("--apply") }))
