import path from "node:path"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const article = await Bun.file(path.join(root, "articles/skill-state-in-coding-agents.md")).text()
const stats = await Bun.file(path.join(root, "experiments/codex-clean-comparison-20260908/statistics.json")).json()
const figures = await Bun.file(path.join(here, "figure-data.json")).json()
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())).digest("hex")
for (const [file, expected] of Object.entries(figures.sources))
  if (await hash(file) !== expected) throw new Error("Figure source changed")
if (figures.figures.length !== 2 || JSON.stringify(figures.points) !== JSON.stringify(stats.repeats))
  throw new Error("Wrong new figure count/values")
const names: Record<string, string> = { native: "Native", paper: "Paper", v2: "V2", v3: "V3" }
for (const s of stats.statistics) {
  const delta = s.mode === "native" ? "—" : (s.relativeInput < 0 ? "−" : "+") + Math.abs(s.relativeInput * 100).toFixed(1).replace(".", ",") + "%"
  const line = "| " + [names[s.mode], (s.input / 1e6).toFixed(3).replace(".", ","), delta, s.calls,
    s.correctedSuccess + "/25", s.timeouts].join(" | ") + " |"
  if (!article.includes(line)) throw new Error("Article table differs: " + line)
}
for (const fig of figures.figures) {
  if (!article.includes("](./figures/" + fig.name + ".png)")) throw new Error("Missing embedded figure")
  for (const [file, expected] of Object.entries(fig.hashes))
    if (await hash(file) !== expected) throw new Error("Figure differs")
}
const old = await Bun.file(path.join(root, "articles/update-20260906/figure-data.json")).json()
for (const name of old.figures)
  if (!article.includes("](./figures/" + name + ".png)")) throw new Error("Old figure removed")
if (!article.includes("520 исходов") || !article.includes("T > 1 + 2M/h") || !article.includes("Таких данных у нас просто нет."))
  throw new Error("Missing cohort count, derivation or long-task caveat")
let links = 0
for (const file of ["articles/skill-state-in-coding-agents.md", "articles/README.md", "articles/update-20260908/README.md",
  "experiments/codex-clean-comparison-20260908/README.md", "experiments/codex-clean-comparison-20260908/REPORT-sol.md",
  "experiments/codex-clean-comparison-20260908/REPORT-astra.md", "journals/CODEX-CLEAN-20260908.md"]) {
  const text = await Bun.file(path.join(root, file)).text()
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^https?:\/\//.test(match[1]) || match[1].startsWith("#")) continue
    const target = path.resolve(root, path.dirname(file), match[1].split("#")[0])
    if (!target.startsWith(root + path.sep) || !await Bun.file(target).exists()) throw new Error("Broken local link: " + file + "/" + match[1])
    links++
  }
}
const result = { checkedAt: new Date().toISOString(), status: "passed", newSessions: 200, totalArticleOutcomes: 520,
  newTables: 2, newFigures: 2, preservedOldFigures: old.figures.length, checkedPoints: figures.points.length,
  localLinks: links, articleSha256: await hash("articles/skill-state-in-coding-agents.md"),
  scope: "New tables, plotted values, figure bytes and links; not a causal scientific validation or external publication." }
await Bun.write(path.join(here, "verification.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
