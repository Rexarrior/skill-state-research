import assert from "node:assert/strict"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const source = "experiments/codex-paper2-20260910"
const read = async (file: string) => Bun.file(path.join(root, file)).json()
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())).digest("hex")
const data = await read(source + "/data.json")
const stats = await read(source + "/statistics.json")
const controls = await read("experiments/codex-large-context-comparison-20260909/statistics.json")
const deletion = await read(source + "/taskboard-delete-audit.json")
const figures = await read("articles/update-20260910/figure-data.json")
const article = await Bun.file(path.join(root, "articles/skill-state-in-coding-agents.md")).text()
assert.equal(data.rows.length, 50)
assert.equal(new Set(data.rows.map((row: { id: string }) => row.id)).size, 50)
assert.equal(deletion.outcomes.length, 10)
for (const [file, expected] of Object.entries(data.sources))
  assert.equal(await hash(path.join(source, file)), expected, file)
for (const s of stats.statistics) {
  if (s.mode !== "paper2") {
    assert.deepEqual(s, controls.statistics.find((c: { cohort: string, mode: string }) => c.cohort === s.cohort && c.mode === s.mode))
    continue
  }
  const rows = data.rows.filter((row: { cohort: string }) => row.cohort === s.cohort)
  assert.equal(rows.length, 25)
  for (const key of ["input", "calls", "durationMs", "correctedPassed"])
    assert.equal(s[key], rows.reduce((n: number, row: Record<string, number>) => n + row[key], 0))
  assert.equal(s.correctedSuccess, rows.filter((row: { fullSuccess: boolean }) => row.fullSuccess).length)
  for (const row of rows) {
    const correction = deletion.outcomes.find((d: { id: string }) => d.id === row.id)
    assert.equal(row.correctedPassed, row.rawPassed + (correction ? Number(correction.supplementaryPassed) - Number(correction.rawCheckPassed) : 0))
    assert.equal(row.fullSuccess, row.correctedPassed === row.total && row.exitCode === 0 && !row.timedOut && row.acceptedFinish)
  }
}
for (const point of stats.repeats) {
  if (point.mode !== "paper2") {
    assert.deepEqual(point, controls.repeats.find((p: { cohort: string, mode: string, repetition: number }) =>
      p.cohort === point.cohort && p.mode === point.mode && p.repetition === point.repetition))
    continue
  }
  const rows = data.rows.filter((row: { cohort: string, repetition: number }) => row.cohort === point.cohort && row.repetition === point.repetition)
  assert.equal(rows.length, 5)
  assert.equal(point.inputPerTask, rows.reduce((n: number, row: { input: number }) => n + row.input, 0) / 5)
  assert.equal(point.callsPerTask, rows.reduce((n: number, row: { calls: number }) => n + row.calls, 0) / 5)
  assert.equal(point.minutesPerTask, rows.reduce((n: number, row: { durationMs: number }) => n + row.durationMs, 0) / 300000)
  assert.equal(point.timeouts, rows.filter((row: { timedOut: boolean }) => row.timedOut).length)
}
assert.deepEqual(figures.points, stats.repeats)
assert.equal(figures.points.length, 30)
assert.equal(figures.figures.length, 2)
for (const [file, expected] of Object.entries(figures.sources)) assert.equal(await hash(file), expected)
for (const fig of figures.figures) {
  assert.ok(article.includes(`](./figures/${fig.name}.png)`))
  for (const [file, expected] of Object.entries(fig.hashes)) assert.equal(await hash(file), expected)
}
const start = article.indexOf("### Ещё один контроль: Paper2")
const end = article.indexOf("## Результаты")
assert.ok(article.indexOf("## Повторы Codex") < start && start < end && end < article.indexOf("## Что видно в прогонах"))
const section = article.slice(start, end)
const names: Record<string, string> = { native: "Native", paper: "Paper", paper2: "Paper2" }
for (const s of stats.statistics) {
  const delta = s.mode === "native" ? "—" : (s.relativeInput < 0 ? "−" : "+") + Math.abs(s.relativeInput * 100).toFixed(1).replace(".", ",") + "%"
  const line = "| " + [names[s.mode], (s.input / 1e6).toFixed(3).replace(".", ","), delta, s.calls, `${s.correctedSuccess}/25`, s.timeouts].join(" | ") + " |"
  assert.ok(section.includes(line), line)
}
assert.ok(article.includes("всего в статье их 770"))
assert.ok(article.includes("**770**"))
assert.ok(!article.includes("Её результаты сюда пока не включены"))
assert.ok(section.includes("расход тех пяти прерванных попыток не включён"))
assert.ok(section.includes("контрольные серии проведены раньше"))
// Preserve all ten figures covered by the previous update checks, plus the original article figures.
let preservedFigures = 0
for (const directory of ["update-20260908", "update-20260909"]) {
  const prior = await read(`articles/${directory}/figure-data.json`)
  for (const fig of prior.figures) {
    assert.ok(article.includes(`](./figures/${fig.name}.png)`))
    for (const [file, expected] of Object.entries(fig.hashes)) assert.equal(await hash(file), expected)
    preservedFigures++
  }
}
const older = await read("articles/update-20260906/figure-data.json")
const manifest = await read("experiments/context-redaction/artifact-manifest.json")
for (const name of older.figures) {
  assert.ok(article.includes(`](./figures/${name}.png)`))
  for (const suffix of ["png", "svg"]) {
    const file = `articles/figures/${name}.${suffix}`
    assert.equal(await hash(file), manifest.files[file].sha256)
  }
  preservedFigures++
}
assert.equal(preservedFigures, 10)
let links = 0
for (const file of ["articles/skill-state-in-coding-agents.md", "articles/README.md", "articles/update-20260910/README.md", source + "/README.md", source + "/REPORT.md"]) {
  const text = await Bun.file(path.join(root, file)).text()
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^https?:\/\//.test(match[1]) || match[1].startsWith("#")) continue
    const target = path.resolve(root, path.dirname(file), match[1].split("#")[0])
    assert.ok(target.startsWith(root + path.sep) && await Bun.file(target).exists(), file + ": " + match[1])
    links++
  }
}
const result = { status: "passed", newOutcomes: 50, totalArticleOutcomes: 770,
  separatelyInterruptedAttempts: 5, checkedPoints: 30, newFigures: 2, preservedFigures,
  localLinks: links, articleSha256: await hash("articles/skill-state-in-coding-agents.md"),
  scope: "Paper2 source fingerprints, aggregates, corrected success, repeat points, tables, figure hashes and links. No model calls; not causal validation." }
await Bun.write(path.join(import.meta.dir, "verification.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
