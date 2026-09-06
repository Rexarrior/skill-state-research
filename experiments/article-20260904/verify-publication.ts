import path from "node:path"
import { loadArtifactIntegrity, verificationOutput } from "../../scripts/artifact-integrity"

const root = path.resolve(import.meta.dir, "../..")
const integrity = await loadArtifactIntegrity(root)
const data = await Bun.file(path.join(import.meta.dir, "data.json")).json()
if (data.missing || data.rows.length !== 120) throw new Error("Cannot sign off an incomplete campaign")
for (const name of ["trace-audit.json", "usage-audit.json"]) {
  const audit = await Bun.file(path.join(import.meta.dir, name)).json()
  if (audit.partial || (audit.findings ?? audit.issues ?? []).length) throw new Error(`Unresolved audit: ${name}`)
}
const auxiliary = await Bun.file(path.join(import.meta.dir, "auxiliary-usage.json")).json()
if (auxiliary.partial || auxiliary.outcomes.length !== data.rows.filter((r: any) => r.runtime === "Codex").length)
  throw new Error("Incomplete auxiliary usage audit")
for (const child of auxiliary.descendants) for (const key of ["input_tokens", "output_tokens"]) {
  const sum = child.records.reduce((s: number, r: any) => s + (r.usage?.[key] ?? 0), 0)
  if (sum !== (child.usage?.[key] ?? 0)) throw new Error(`Auxiliary usage sum mismatch: ${child.threadID}/${key}`)
}
const hostContext = await Bun.file(path.join(import.meta.dir, "host-context-audit.json")).json()
if (hostContext.partial || hostContext.cells.length !== auxiliary.outcomes.length)
  throw new Error("Incomplete host context audit")
const scan = await Bun.file(path.join(import.meta.dir, "artifact-scan.json")).json()
if (scan.partial || scan.findings.length) throw new Error("Unresolved artifact scan")
let archivedFiles = 0
for (const row of data.rows) {
  const directory = path.join(root, path.dirname(row.source))
  const archive = await Bun.file(path.join(directory, "workspace-manifest.json")).json()
  for (const file of archive.files) {
    const location = path.resolve(directory, "workspace", file.path)
    if (!location.startsWith(path.join(directory, "workspace") + path.sep)) throw new Error("Invalid archive path")
    await integrity.verify(path.relative(root, location), file.sha256, file.bytes)
    archivedFiles++
  }
}
const files = ["articles/skill-state-in-coding-agents.md", "articles/linkedin-post.md", "articles/README.md",
  "experiments/article-20260904/README.md", "experiments/article-20260904/REPORT.md"]
const checkedLinks = []
for (const file of files) {
  const body = await Bun.file(path.join(root, file)).text()
  if (/<!--\s*(EDITORIAL|CAMPAIGN_RESULTS)|\bTODO\b|\bTBD\b/.test(body)) throw new Error(`Editorial placeholder: ${file}`)
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1].replace(/^<|>$/g, "")
    if (/^https?:\/\//.test(href) || href.startsWith("#")) continue
    const resolved = path.resolve(path.dirname(path.join(root, file)), decodeURI(href.split("#")[0]))
    if (!resolved.startsWith(root + path.sep)) throw new Error(`Non-portable article link: ${file}: ${href}`)
    if (!await Bun.file(resolved).exists()) throw new Error(`Broken file link: ${file}: ${href}`)
    checkedLinks.push({ file, href })
  }
}
const body = await Bun.file(path.join(root, files[0])).text()
const figures: string[] = (await Bun.file(path.join(root, "articles/update-20260906/figure-data.json")).json()).figures
for (const figure of figures) {
  if (!body.includes(`](./figures/${figure}.png)`)) throw new Error(`Missing article figure: ${figure}`)
  for (const suffix of ["png", "svg"]) {
    const file = Bun.file(path.join(root, "articles/figures", `${figure}.${suffix}`))
    if (!await file.exists() || !file.size) throw new Error(`Missing or empty figure: ${figure}.${suffix}`)
  }
}
const tables = await Bun.file(path.join(import.meta.dir, "publication-tables.md")).text()
for (const line of tables.split("\n").filter((line) => line.startsWith("|")))
  if (!body.includes(line)) throw new Error(`Article diverges from generated table: ${line}`)
const words = body.replace(/```[\s\S]*?```/g, "").split(/\s+/).filter(Boolean).length
await Bun.write(verificationOutput(root, "article-publication"), JSON.stringify({
  checkedAt: new Date().toISOString(), cells: data.rows.length, tableRowsMatch: true, editorialPlaceholders: false,
  archivedFilesVerified: archivedFiles, auxiliaryCellsVerified: auxiliary.outcomes.length, artifactScanFindings: scan.findings.length,
  hostContextCellsVerified: hostContext.cells.length,
  articleWordsExcludingCode: words, checkedLinks,
  figuresVerified: figures,
  limits: "Local link existence and numeric table consistency; external publication URLs and manual prose/visual review are separate checks.",
}, null, 2) + "\n")
console.log(JSON.stringify({ cells: data.rows.length, tableRowsMatch: true, archivedFiles, articleWordsExcludingCode: words, localLinks: checkedLinks.length }))
