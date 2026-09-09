import path from "node:path"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const article = await Bun.file(path.join(root, "articles/skill-state-in-coding-agents.md")).text()
const source = "experiments/codex-large-context-comparison-20260909"
const stats = await Bun.file(path.join(root, source, "statistics.json")).json()
const figures = await Bun.file(path.join(here, "figure-data.json")).json()
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())).digest("hex")
for (const [file, expected] of Object.entries(figures.sources))
  if (await hash(file) !== expected) throw new Error("Figure source changed")
if (figures.figures.length !== 2 || JSON.stringify(figures.points) !== JSON.stringify(stats.repeats))
  throw new Error("Wrong new figure count/values")
const names: Record<string, string> = { native: "Native", paper: "Paper", v2: "V2", v3: "V3" }
const newStart = article.indexOf("#### Astra с расширенными лимитами:")
const split = article.indexOf("#### Sol с теми же лимитами:")
const end = article.indexOf("### Что видно в траекториях")
if (!(article.indexOf("#### Бонус: Astra") < article.indexOf("#### Кажется, я слишком") &&
      article.indexOf("#### Кажется, я слишком") < newStart && newStart < split && split < end))
  throw new Error("Unexpected section order")
for (const cohort of ["astra", "sol"]) {
  const section = cohort === "astra" ? article.slice(newStart, split) : article.slice(split, end)
  for (const s of stats.statistics.filter((s: { cohort: string }) => s.cohort === cohort)) {
    const delta = s.mode === "native" ? "—" : (s.relativeInput < 0 ? "−" : "+") + Math.abs(s.relativeInput * 100).toFixed(1).replace(".", ",") + "%"
    const line = "| " + [names[s.mode], (s.input / 1e6).toFixed(3).replace(".", ","), delta, s.calls,
      s.correctedSuccess + "/25", s.timeouts].join(" | ") + " |"
    if (!section.includes(line)) throw new Error("New article table differs: " + line)
  }
}
const oldStats = await Bun.file(path.join(root, "experiments/codex-clean-comparison-20260908/statistics.json")).json()
for (const s of oldStats.statistics) {
  const delta = s.mode === "native" ? "—" : (s.relativeInput < 0 ? "−" : "+") + Math.abs(s.relativeInput * 100).toFixed(1).replace(".", ",") + "%"
  const line = "| " + [names[s.mode], (s.input / 1e6).toFixed(3).replace(".", ","), delta, s.calls,
    s.correctedSuccess + "/25", s.timeouts].join(" | ") + " |"
  if (!article.slice(0, newStart).includes(line)) throw new Error("Old clean-series table changed")
}
let checkedFigures = 0
for (const directory of ["update-20260908", "update-20260909"]) {
  const record = await Bun.file(path.join(root, "articles", directory, "figure-data.json")).json()
  for (const fig of record.figures) {
    if (!article.includes("](./figures/" + fig.name + ".png)")) throw new Error("Missing embedded figure")
    for (const [file, expected] of Object.entries(fig.hashes))
      if (await hash(file) !== expected) throw new Error("Figure changed: " + file)
    checkedFigures++
  }
}
const old = await Bun.file(path.join(root, "articles/update-20260906/figure-data.json")).json()
const oldManifest = await Bun.file(path.join(root, "experiments/context-redaction/artifact-manifest.json")).json()
for (const name of old.figures) {
  if (!article.includes("](./figures/" + name + ".png)")) throw new Error("Old figure removed")
  for (const suffix of ["png", "svg"]) {
    const file = `articles/figures/${name}.${suffix}`
    if (!oldManifest.files[file] || await hash(file) !== oldManifest.files[file].sha256)
      throw new Error("Historical figure changed: " + file)
  }
  checkedFigures++
}
if (checkedFigures !== 10 || !article.includes("всего в статье их 720") ||
    !article.includes("T > 1 + 2M/h") || !article.includes("Таких данных у нас просто нет.") ||
    !article.includes("По исходному оценщику у него было 23/25."))
  throw new Error("Missing count, derivation or caveats")
let links = 0
for (const file of ["articles/skill-state-in-coding-agents.md", "articles/README.md", "articles/update-20260909/README.md",
  source + "/README.md", source + "/REPORT-sol.md", source + "/REPORT-astra.md"]) {
  const text = await Bun.file(path.join(root, file)).text()
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^https?:\/\//.test(match[1]) || match[1].startsWith("#")) continue
    const target = path.resolve(root, path.dirname(file), match[1].split("#")[0])
    if (!target.startsWith(root + path.sep) || !await Bun.file(target).exists()) throw new Error("Broken local link: " + file + "/" + match[1])
    links++
  }
}
const result = { checkedAt: new Date().toISOString(), status: "passed", newSessions: 200, totalArticleOutcomes: 720,
  newTables: 2, newFigures: 2, preservedOldFigures: 8, checkedNewPoints: figures.points.length,
  localLinks: links, articleSha256: await hash("articles/skill-state-in-coding-agents.md"),
  scope: "New tables, plotted values, all ten figure hashes, preservation of old figures and links. Not causal validation or external publication." }
await Bun.write(path.join(here, "verification.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
