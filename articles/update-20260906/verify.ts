import path from "node:path"
import { loadArtifactIntegrity, verificationOutput } from "../../scripts/artifact-integrity"

const root = path.resolve(import.meta.dir, "../..")
const integrity = await loadArtifactIntegrity(root)
const read = (file: string) => Bun.file(path.join(root, file)).json()
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())).digest("hex")
const articleFile = "articles/skill-state-in-coding-agents.md"
const article = await Bun.file(path.join(root, articleFile)).text()
const plots = await read("articles/update-20260906/figure-data.json")
for (const [file, expected] of Object.entries(plots.sources))
  if (await hash(file) !== expected) throw new Error(`Figure data changed: ${file}`)

// Prior benchmark verification remains a dated snapshot. Only these two prose
// files may differ after the user's explicit authorization to update the article.
const allowedEditorialEdits = [articleFile, "articles/README.md"]
const frozen = await read("experiments/codex-sol-controls-20260906/source-manifest.json")
let protectedFiles = 0
for (const [file, expected] of Object.entries({ ...frozen.source.files, ...frozen.protectedFiles })) {
  if (allowedEditorialEdits.includes(file)) continue
  await integrity.verify(file, expected as string)
  protectedFiles++
}
const original = await read("experiments/article-20260904/data.json")
const combined = await read("experiments/codex-sol-controls-20260906/combined-data.json")
const v2v3 = await read("experiments/codex-sol-repeats-20260906/data.json")
const controls = await read("experiments/codex-sol-controls-20260906/data.json")
if (original.missing || original.rows.length !== 120 || combined.missing || combined.rows.length !== 200)
  throw new Error("Incomplete cohorts")
const rawRows = new Map([...v2v3.rows, ...controls.rows].map(row => [row.source, row]))
if (rawRows.size !== 200 || new Set(combined.rows.map(row => row.threadID)).size !== 200)
  throw new Error("Duplicated outcomes")
for (const row of combined.rows) {
  const raw = rawRows.get(row.source)
  for (const key of ["input", "calls", "passed", "checks", "completed", "protocolFinished", "timedOut", "durationMs"])
    if (!raw || raw[key] !== row[key]) throw new Error(`Combined row differs: ${row.source}/${key}`)
}
const oldTables = await Bun.file(path.join(root, "experiments/article-20260904/publication-tables.md")).text()
for (const line of oldTables.split("\n").filter(line => line.startsWith("|")))
  if (!article.includes(line)) throw new Error(`Original table changed: ${line}`)

const names = { native: "Native", paper: "Paper", v2: "V2", v3: "V3" }
for (const stat of combined.statistics) {
  const cells = combined.rows.filter(row => row.mode === stat.mode)
  if (cells.length !== 50 || cells.reduce((sum, row) => sum + row.input, 0) !== stat.input ||
      cells.reduce((sum, row) => sum + row.calls, 0) !== stat.calls) throw new Error("Incorrect mode totals")
  const ratio = stat.input / combined.statistics.find(s => s.mode === "native").input - 1
  const delta = stat.mode === "native" ? "—" : `${ratio < 0 ? "−" : "+"}${Math.abs(ratio * 100).toFixed(1).replace(".", ",")}%`
  const line = `| ${names[stat.mode]} | ${(stat.input / 1e6).toFixed(3).replace(".", ",")} | ${delta} | ${stat.calls} | ${stat.correctedSuccess}/50 | ${stat.timeouts} |`
  if (!article.includes(line)) throw new Error(`New article table differs: ${line}`)
  const points = plots.repeatValues.filter(point => point.mode === stat.mode)
  if (points.length !== 10 || new Set(points.map(point => point.repetition)).size !== 10)
    throw new Error("Wrong figure sample count")
  for (const point of points) {
    const sample = cells.filter(row => row.repetition === point.repetition)
    for (const [field, key, divisor] of [["inputPerTask", "input", 5], ["callsPerTask", "calls", 5], ["minutesPerTask", "durationMs", 300000]] as const) {
      const expected = sample.reduce((sum, row) => sum + row[key], 0) / divisor
      if (Math.abs(point[field] - expected) > 1e-8) throw new Error(`Wrong plotted value: ${field}`)
    }
    if (point.timeouts !== sample.filter(row => row.timedOut).length) throw new Error("Wrong timeout marker")
  }
}
const figHashes = {}
if (plots.figures.length !== 6) throw new Error("Expected six paired/summary figures")
for (const name of plots.figures) {
  if (!article.includes(`](./figures/${name}.png)`)) throw new Error(`Figure not embedded: ${name}`)
  for (const suffix of ["png", "svg"]) {
    const file = `articles/figures/${name}.${suffix}`
    if (!(await Bun.file(path.join(root, file)).exists())) throw new Error(`Missing figure: ${file}`)
    figHashes[file] = await hash(file)
  }
}
let links = 0
for (const file of [articleFile, "articles/README.md", "articles/update-20260906/README.md", "journals/ARTICLE-20260904.md"]) {
  const text = await Bun.file(path.join(root, file)).text()
  if (/\bTODO\b|\bTBD\b/.test(text)) throw new Error(`Editorial placeholder: ${file}`)
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^https?:\/\//.test(match[1]) || match[1].startsWith("#")) continue
    const target = path.resolve(root, path.dirname(file), match[1].split("#")[0])
    const ownOutput = path.join(import.meta.dir, "qa.json")
    if (!target.startsWith(root + path.sep) || (target !== ownOutput && !await Bun.file(target).exists()))
      throw new Error(`Broken link: ${file}/${match[1]}`)
    links++
  }
}
const qa = { checkedAt: new Date().toISOString(), status: "passed", originalCells: 120, additionalCells: 200,
  oldAndNewTablesMatch: true, frozenFilesVerified: protectedFiles, allowedEditorialEdits,
  repeatPointsVerified: plots.repeatValues.length, figureHashes: figHashes, localLinks: links,
  articleSha256: await hash(articleFile),
  scope: "Local data, tables, plotted point values, links and frozen files; not scientific validation or external publication." }
await Bun.write(verificationOutput(root, "article-update"), JSON.stringify(qa, null, 2) + "\n")
console.log(JSON.stringify(qa))
