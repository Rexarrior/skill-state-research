import path from "node:path"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const read = (file: string) => Bun.file(path.join(here, file)).json()
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const data = await read("data.json")
const usage = await read("usage-records.json")
const audits = await read("initial-context-audit.json")
const archives = await read("archive-manifest.json")
const deletion = await read("taskboard-delete-audit.json")
const aggregates = await read("statistics.json")
const auxiliary = await read("auxiliary-usage.json")
if (data.rows.length !== 200 || new Set(data.rows.map((r: { id: string }) => r.id)).size !== 200 ||
    new Set(data.rows.map((r: { threadID: string }) => r.threadID)).size !== 200 ||
    usage.records.length !== 200 || audits.audits.length !== 200 || archives.archives.length !== 200 ||
    deletion.outcomes.length !== 40 || aggregates.statistics.length !== 8 || aggregates.repeats.length !== 40)
  throw new Error("Incomplete or duplicate cohort")
let archivedFiles = 0
for (const row of data.rows) {
  const records = usage.records.find((r: { id: string }) => r.id === row.id)?.usage
  if (!records?.length || records.length !== row.calls) throw new Error("Usage record count")
  for (const key of ["input", "output", "cachedInput", "reasoning"])
    if (records.reduce((n: number, r: Record<string, number>) => n + r[key], 0) !== row[key]) throw new Error("Usage mismatch")
  const audit = audits.audits.find((r: { id: string }) => r.id === row.id)
  if (!audit?.initial.length || audit.initial.some((r: { skills: boolean, hostProfile: boolean }) => r.skills || r.hostProfile))
    throw new Error("Initial context flags")
  if (row.rawSuccess !== (row.artifactPass && row.completed && row.protocolFinished) ||
      row.artifactPass !== (row.passed === row.total) || row.completed !== (row.exitCode === 0 && !row.timedOut))
    throw new Error("Success definition differs")
  const archive = archives.archives.find((r: { id: string }) => r.id === row.id)
  if (!archive) throw new Error("Missing archive")
  for (const file of archive.files) {
    const full = path.resolve(here, row.archive, file.path)
    if (!full.startsWith(path.join(here, "artifacts") + path.sep)) throw new Error("Unsafe archive path")
    if (Bun.file(full).size !== file.bytes || await hash(full) !== file.sha256) throw new Error("Archive differs")
    archivedFiles++
  }
  if (row.project === "taskboard-cli") {
    const check = deletion.outcomes.find((r: { id: string }) => r.id === row.id)
    if (!check || check.supplementaryPassed !== (check.checks.length === 5 && check.checks.every((r: { passed: boolean }) => r.passed)))
      throw new Error("Supplementary result mismatch")
  }
}
for (const stat of aggregates.statistics) {
  const rows = data.rows.filter((r: { cohort: string, mode: string }) => r.cohort === stat.cohort && r.mode === stat.mode)
  if (rows.length !== 25) throw new Error("Incorrect group size")
  for (const key of ["input", "output", "cachedInput", "calls", "durationMs", "passed"])
    if (rows.reduce((n: number, r: Record<string, number>) => n + r[key], 0) !== stat[key]) throw new Error("Aggregate mismatch")
  const corrected = rows.map((r: { id: string, passed: number, total: number, completed: boolean, protocolFinished: boolean }) => {
    const check = deletion.outcomes.find((c: { id: string }) => c.id === r.id)
    const passed = r.passed + (check ? Number(check.supplementaryPassed) - Number(check.rawCheckPassed) : 0)
    return { passed, success: passed === r.total && r.completed && r.protocolFinished }
  })
  if (corrected.reduce((n: number, r: { passed: number }) => n + r.passed, 0) !== stat.correctedPassed ||
      corrected.filter((r: { success: boolean }) => r.success).length !== stat.correctedSuccess ||
      rows.filter((r: { timedOut: boolean }) => r.timedOut).length !== stat.timeouts) throw new Error("Quality totals mismatch")
  const aux = auxiliary.outcomes.filter((r: { id: string }) => rows.some((c: { id: string }) => c.id === r.id))
  if (aux.length !== 25 || aux.reduce((n: number, r: { input: number }) => n + r.input, 0) !== stat.auxiliaryInput)
    throw new Error("Auxiliary aggregate mismatch")
}
for (const point of aggregates.repeats) {
  const rows = data.rows.filter((r: { cohort: string, mode: string, repetition: number }) =>
    r.cohort === point.cohort && r.mode === point.mode && r.repetition === point.repetition)
  if (rows.length !== 5 || new Set(rows.map((r: { project: string }) => r.project)).size !== 5) throw new Error("Repeat sample mismatch")
  for (const [key, source, divisor] of [["inputPerTask", "input", 5], ["callsPerTask", "calls", 5], ["minutesPerTask", "durationMs", 300000]] as const)
    if (Math.abs(point[key] - rows.reduce((n: number, r: Record<string, number>) => n + r[source], 0) / divisor) > 1e-8)
      throw new Error("Repeat point mismatch")
}

const snapshotPath = path.join(here, "publication-manifest.json")
if (process.argv.includes("--seal")) {
  if (await Bun.file(snapshotPath).exists()) throw new Error("Already sealed; review changes explicitly, do not replace")
  const files: Record<string, string> = {}
  for await (const file of new Bun.Glob("**/*").scan({ cwd: here, onlyFiles: true, dot: true })) {
    if (file.startsWith(".private/") || file === "verification.json" || file === "publication-manifest.json") continue
    files[file] = await hash(path.join(here, file))
  }
  await Bun.write(snapshotPath, JSON.stringify({ capturedAt: new Date().toISOString(), files,
    scope: "New publishable results only. Original source manifests unchanged; raw prompts are not part of this export." }, null, 2) + "\n")
}
const manifest = await read("publication-manifest.json")
for (const row of data.rows) {
  const archive = archives.archives.find((r: { id: string }) => r.id === row.id)
  for (const file of archive.files) {
    const key = path.join(row.archive, file.path)
    if (manifest.files[key] !== file.sha256) throw new Error("Archive file omitted from publication manifest: " + key)
  }
}
for (const [file, expected] of Object.entries(manifest.files))
  if (await hash(path.join(here, file)) !== expected) throw new Error("Published file changed: " + file)
let localRawVerified = 0, localRawUnavailable = 0
for (const [file, expected] of Object.entries((await read("source-hashes.json")).files)) {
  const target = path.join(root, file)
  if (!await Bun.file(target).exists()) {
    if (!file.includes("/.private/")) throw new Error("Missing public provenance: " + file)
    localRawUnavailable++
    continue
  }
  if (await hash(target) !== expected) throw new Error("Source changed: " + file)
  localRawVerified++
}
const result = { checkedAt: new Date().toISOString(), status: "passed", sessions: data.rows.length,
  archivedFiles, initialContextsChecked: audits.audits.length, publicationFiles: Object.keys(manifest.files).length,
  localRawVerified, localRawUnavailable, supplementaryChecks: deletion.outcomes.length,
  scope: "Arithmetic, fingerprints and declared outcomes; no new model calls and no re-evaluation of all task requirements." }
await Bun.write(path.join(here, "verification.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
