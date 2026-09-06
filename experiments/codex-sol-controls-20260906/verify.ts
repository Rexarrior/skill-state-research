// Isolated native/paper campaign copy; never run analysis scripts in the prior campaign.
import path from "node:path"
import { loadArtifactIntegrity, verifyRecordedBinary, verificationOutput } from "../../scripts/artifact-integrity"

const here = import.meta.dir, root = path.resolve(here, "../..")
const integrity = await loadArtifactIntegrity(root)
const read = (name: string) => Bun.file(path.join(here, name)).json()
const data = await read("data.json"), run = await read("run.json")
if (data.missing || data.rows.length !== 100 || run.status !== "complete" || run.attempts.length !== 10)
  throw new Error("Incomplete series")
const combined = await read("combined-data.json"), context = await read("context-comparison.json")
if (combined.missing || combined.rows.length !== 200 || new Set(combined.rows.map((r: any) => r.threadID)).size !== 200 ||
    combined.statistics.length !== 4 || combined.statistics.some((s: any) => s.cells !== 50 || s.checks !== 400 || s.fullAttempts !== 10 || s.auxiliaryCells !== 50))
  throw new Error("Incomplete four-way comparison")
if (context.partial || context.cells.length !== 200 || context.distinctNormalizedProfileHashes !== 1 || context.groups.some((g: any) => g.missingProfile))
  throw new Error("Host-profile comparison requires investigation")
const truncation = await read("truncation-audit.json")
if (truncation.partial || truncation.rows.length !== 150 || truncation.groups.length !== 3 ||
    truncation.groups.some((g: any) => g.cells !== 50 || g.clipped > g.results || g.clippedSteps > g.steps))
  throw new Error("Incomplete state-result truncation audit")
if (new Set(run.attempts.map((a: any) => a.suite)).size !== 10 || run.attempts.some((a: any) => a.status !== "complete" || a.exitCode !== 0))
  throw new Error("Invalid suite completion")
const keys = data.rows.map((r: any) => `${r.repetition}/${r.mode}/${r.project}`)
if (new Set(keys).size !== 100 || data.groups.length !== 20 || data.groups.some((g: any) => g.cells !== 5 || g.checks !== 40))
  throw new Error("Repeated or missing experimental cell")
if (data.rows.some((r: any) => !r.threadID) || new Set(data.rows.map((r: any) => r.threadID)).size !== 100)
  throw new Error("Main sessions were missing or reused")
for (const file of ["usage-audit.json", "trace-audit.json", "artifact-scan.json"]) {
  const audit = await read(file)
  if (audit.partial || (audit.issues?.length ?? 0) || (audit.findings?.length ?? 0)) throw new Error(`Unresolved audit: ${file}`)
}
const host = await read("host-context-audit.json"), auxiliary = await read("auxiliary-usage.json")
if (host.partial || host.cells.length !== 100 || auxiliary.partial || auxiliary.outcomes.length !== 100)
  throw new Error("Incomplete host/auxiliary audit")
const actionErrors = await read("action-errors.json")
if (actionErrors.partial || actionErrors.rows.length !== 100 || actionErrors.groups.some((g: any) =>
    Object.values(g.counts).reduce((n: number, value: any) => n + value, 0) !== g.errors))
  throw new Error("Incomplete action-error classification")
const deletion = await read("taskboard-delete-audit.json")
const taskboardSources = new Set(data.rows.filter((r: any) => r.project === "taskboard-cli").map((r: any) => r.source))
if (deletion.partial || deletion.outcomes.length !== 20 || new Set(deletion.outcomes.map((o: any) => o.source)).size !== 20 ||
    deletion.outcomes.some((o: any) => !taskboardSources.has(o.source)))
  throw new Error("Supplementary deletion audit does not cover both modes/all attempts")
for (const child of auxiliary.descendants) for (const key of ["input_tokens", "output_tokens"]) {
  const sum = child.records.reduce((n: number, record: any) => n + (record.usage?.[key] ?? 0), 0)
  if (sum !== (child.usage?.[key] ?? 0)) throw new Error("Auxiliary usage sum mismatch")
}
const manifest = await read("source-manifest.json")
const hash = async (file: string) => new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const binary = manifest.binaries["skill-state"]
const binaryChecks = [await verifyRecordedBinary(binary.path, binary.sha256),
  await verifyRecordedBinary(manifest.binaries.baseline.codeModeHostPath, manifest.binaries.baseline.codeModeHostSha256)]
for (const [file, expected] of Object.entries({ ...manifest.source.files, ...manifest.protectedFiles }))
  await integrity.verify(file, expected as string)
if (await hash(path.join(here, "run.ts")) !== manifest.orchestrationSha256 || await hash(path.join(here, "PROTOCOL.md")) !== manifest.protocolSha256)
  throw new Error("Dispatch protocol changed after the start")
const events = run.attempts.flatMap((a: any) => [
  { at: Date.parse(a.startedAt), delta: 1, worker: a.worker }, { at: Date.parse(a.endedAt), delta: -1, worker: a.worker },
]).sort((a: any, b: any) => a.at - b.at || a.delta - b.delta)
let active = 0, maximum = 0
const workers = new Set<number>()
for (const e of events) {
  if (!Number.isFinite(e.at) || !Number.isInteger(e.worker) || e.worker < 1 || e.worker > 5) throw new Error("Invalid worker interval")
  if (e.delta > 0) { if (workers.has(e.worker)) throw new Error("Worker intervals overlap"); workers.add(e.worker) }
  else { if (!workers.delete(e.worker)) throw new Error("Worker ends before starting") }
  active += e.delta; maximum = Math.max(maximum, active)
}
if (maximum > 5 || active !== 0) throw new Error("Concurrency bound violated")
let archives = 0, archivedFiles = 0
for (const row of data.rows) {
  const directory = path.join(root, path.dirname(row.source))
  const archive = await Bun.file(path.join(directory, "workspace-manifest.json")).json()
  archives++
  for (const file of archive.files) {
    const location = path.resolve(directory, "workspace", file.path)
    if (!location.startsWith(path.join(directory, "workspace") + path.sep)) throw new Error("Archive path escapes destination")
    await integrity.verify(path.relative(root, location), file.sha256, file.bytes)
    archivedFiles++
  }
}
let links = 0
for (const name of ["README.md", "RESULTS.md", "REPORT.md", "COMPARE-FOUR.md", "READING-LOOP-NOTE.md", "AUXILIARY-USAGE.md"]) {
  const text = await Bun.file(path.join(here, name)).text()
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^https?:\/\//.test(match[1]) || match[1].startsWith("#")) continue
    const target = path.resolve(here, match[1].split("#")[0])
    if (!target.startsWith(root + path.sep) || !await Bun.file(target).exists()) throw new Error(`Broken link: ${name}/${match[1]}`)
    links++
  }
}
const result = { checkedAt: new Date().toISOString(), status: "passed", cells: 100, uniqueMainSessions: 100, pairedAttempts: 10,
  binaryChecks,
  combinedCells: 200, normalizedProfileHashes: context.distinctNormalizedProfileHashes,
  archives, archivedFiles, protectedFiles: Object.keys(manifest.protectedFiles).length, maximumSuiteWorkers: maximum,
  auxiliaryThreads: auxiliary.descendants.length, supplementaryDeletionProjects: deletion.outcomes.length, links,
  scope: "Recorded suite intervals, usage, archive hashes and source/article preservation; not a guarantee about all unrecorded HTTP requests or scientific generalizability." }
await Bun.write(verificationOutput(root, "codex-sol-controls"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
