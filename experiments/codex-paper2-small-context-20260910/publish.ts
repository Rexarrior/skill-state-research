import path from "node:path"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"

// Post-run analysis only: no model calls, no changes to the frozen runner or scores.
const here = import.meta.dir
const read = async (file: string) => Bun.file(path.join(here, file)).json()
const run = await read("run.json")
if (run.status !== "complete" || run.isolation !== "restored" || run.cells.length !== 50)
  throw new Error("Expected 50 completed outcomes and restored isolation")
const rows = []
const deletion = []
const sources: Record<string, string> = {}
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
for (const cell of run.cells) {
  if (cell.status !== "complete") throw new Error("Incomplete cell")
  const directory = path.dirname(cell.source)
  const summary = await read(cell.source)
  const protocol = await read(path.join(directory, "protocol-audit.json"))
  const budget = await read(path.join(directory, "context-budget-audit.json"))
  const initial = await read(path.join(directory, "initial-context-audit.json"))
  if (summary.model !== cell.model || summary.project !== cell.project || summary.protocolMode !== "paper2" ||
      summary.observationWindow !== 1 || protocol.protocol !== "skill.state/paper2" ||
      budget.models.length !== 1 || budget.models[0] !== cell.model || budget.malformedTransitions ||
      budget.input !== summary.metrics.input || budget.calls !== summary.metrics.samples ||
      initial.initial.length === 0 || initial.initial.some((item: { skills: boolean, hostProfile: boolean }) => item.skills || item.hostProfile))
    throw new Error("Source audit mismatch: " + cell.source)
  for (const name of ["summary.json", "protocol-audit.json", "context-budget-audit.json", "initial-context-audit.json"])
    sources[path.join(directory, name)] = await hash(path.join(here, directory, name))
  const id = `${cell.model}/${cell.repetition}/${cell.project}`
  const rawDelete = summary.evaluation.checks.find((check: { name: string }) => check.name === "delete and missing ids")?.passed
  let correctedPassed = summary.evaluation.passed
  if (cell.project === "taskboard-cli") {
    const auditFile = path.join(here, ".private", "publication-delete", `${cell.model}-${cell.repetition}.json`)
    const recorded = Bun.file(auditFile)
    const audit = await recorded.exists() ? await recorded.json() : await checkDelete(summary.workspace, id, rawDelete)
    if (audit.id !== id || audit.rawCheckPassed !== rawDelete) throw new Error("Supplementary audit mismatch")
    if (!await recorded.exists()) await Bun.write(auditFile, JSON.stringify(audit, null, 2) + "\n")
    correctedPassed += Number(audit.supplementaryPassed) - Number(rawDelete)
    deletion.push(audit)
  }
  rows.push({ id, cohort: cell.model === "gpt-5.6-sol" ? "sol" : "astra", model: cell.model,
    repetition: cell.repetition, project: cell.project, mode: "small", source: cell.source,
    carried: cell.carried, attempt: cell.attempt, input: summary.metrics.input,
    cachedInput: summary.metrics.cachedInput, output: summary.metrics.output, calls: summary.metrics.samples,
    durationMs: summary.metrics.durationMs, timedOut: summary.timedOut, exitCode: summary.exitCode,
    acceptedFinish: protocol.acceptedFinish, rawPassed: summary.evaluation.passed,
    correctedPassed, total: summary.evaluation.total,
    fullSuccess: correctedPassed === summary.evaluation.total && !summary.timedOut && summary.exitCode === 0 && protocol.acceptedFinish,
    checks: summary.evaluation.checks.map((check: { name: string, passed: boolean }) => ({ name: check.name, passed: check.passed })),
    budget, initial })
}
if (deletion.length !== 10 || new Set(rows.map(row => row.id)).size !== 50) throw new Error("Incomplete audit")
const controls = await read("../codex-paper2-20260910/statistics.json")
const statistics = controls.statistics.filter((s: { mode: string }) => s.mode === "paper2").map((s: object) => ({ ...s, mode: "large" }))
const repeats = controls.repeats.filter((s: { mode: string }) => s.mode === "paper2").map((s: object) => ({ ...s, mode: "large" }))
for (const cohort of ["sol", "astra"]) {
  const sample = rows.filter(row => row.cohort === cohort)
  if (sample.length !== 25) throw new Error("Expected 25 outcomes per model")
  const input = sample.reduce((n, row) => n + row.input, 0)
  const calls = sample.reduce((n, row) => n + row.calls, 0)
  const durationMs = sample.reduce((n, row) => n + row.durationMs, 0)
  const baseline = statistics.find((s: { cohort: string, mode: string }) => s.cohort === cohort && s.mode === "large")
  statistics.push({ cohort, mode: "small", sessions: 25, input, calls, durationMs,
    inputPerTask: input / 25, callsPerTask: calls / 25, minutesPerTask: durationMs / 1500000,
    relativeInput: input / baseline.input - 1,
    passed: sample.reduce((n, row) => n + row.rawPassed, 0),
    correctedPassed: sample.reduce((n, row) => n + row.correctedPassed, 0),
    checks: sample.reduce((n, row) => n + row.total, 0),
    correctedSuccess: sample.filter(row => row.fullSuccess).length,
    artifactsPassing: sample.filter(row => row.correctedPassed === row.total).length,
    timeouts: sample.filter(row => row.timedOut).length })
  for (let repetition = 1; repetition <= 5; repetition++) {
    const cells = sample.filter(row => row.repetition === repetition)
    if (cells.length !== 5 || new Set(cells.map(row => row.project)).size !== 5) throw new Error("Incomplete repeat")
    repeats.push({ cohort, mode: "small", repetition,
      inputPerTask: cells.reduce((n, row) => n + row.input, 0) / 5,
      callsPerTask: cells.reduce((n, row) => n + row.calls, 0) / 5,
      minutesPerTask: cells.reduce((n, row) => n + row.durationMs, 0) / 300000,
      timeouts: cells.filter(row => row.timedOut).length })
  }
}
sources["../codex-paper2-20260910/statistics.json"] = await hash(path.join(here, "../codex-paper2-20260910/statistics.json"))
for (const file of ["run.json", "restoration.json", "isolation-watch.json"])
  sources[file] = await hash(path.join(here, file))
await Bun.write(path.join(here, "data.json"), JSON.stringify({ rows, sources,
  scope: "50 fresh final outcomes, no external interruptions or replaced outcomes. Build-cache cleanup overlapped early cells; wall time is not an isolated performance measure. Raw prompts, reasoning and tool output are not exported." }, null, 2) + "\n")
await Bun.write(path.join(here, "taskboard-delete-audit.json"), JSON.stringify({ outcomes: deletion,
  scope: "Same prior specification-aligned check on isolated copies of all 10 Paper2 CLI artifacts; original scores unchanged, no code fixes or model calls. Other requirements not re-evaluated." }, null, 2) + "\n")
await Bun.write(path.join(here, "statistics.json"), JSON.stringify({ statistics, repeats,
  controls: "Large and small Paper2 cohorts on 10 September, sequential not interleaved. Four caps changed together; JSON-history protection retained. Cleanup overlapped early small-cap cells." }, null, 2) + "\n")
console.log(JSON.stringify({ paper2: statistics.filter((s: { mode: string }) => s.mode === "small"),
  corrected: deletion.filter(row => row.rawCheckPassed !== row.supplementaryPassed).map(row => row.id),
  timeouts: rows.filter(row => row.timedOut).map(row => ({ id: row.id, passed: row.correctedPassed, total: row.total, calls: row.calls, input: row.input, acceptedFinish: row.acceptedFinish })),
  malformed: rows.reduce((n, row) => n + row.budget.malformedTransitions, 0),
  inputPreviews: rows.reduce((n, row) => n + row.budget.inputPreviews, 0),
  resultTruncations: rows.reduce((n, row) => n + row.budget.skillResultTruncations, 0) }, null, 2))

async function checkDelete(source: string, id: string, rawCheckPassed: boolean) {
  if (!source.includes("/codex-paper2-small-one-shot/") || !source.endsWith("/taskboard-cli")) throw new Error("Unexpected workspace")
  const directory = await mkdtemp(path.join(tmpdir(), "paper2-delete-audit-"))
  const workspace = path.join(directory, "workspace")
  await mkdir(workspace)
  await cp(path.join(source, "src"), path.join(workspace, "src"), { recursive: true, dereference: false })
  if (await Bun.file(path.join(source, "package.json")).exists())
    await cp(path.join(source, "package.json"), path.join(workspace, "package.json"))
  const invoke = async (...args: string[]) => {
    const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: workspace,
      env: { PATH: process.env.PATH, TASKBOARD_FILE: path.join(directory, "tasks.json") }, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]).finally(() => clearTimeout(timer))
    let json
    try { json = JSON.parse(stdout) } catch { json = undefined }
    return { exitCode, json, validJSON: json !== undefined }
  }
  const first = await invoke("add", "--title", "First audit task")
  const second = await invoke("add", "--title", "Second audit task")
  const setup = first.exitCode === 0 && second.exitCode === 0 && Number.isInteger(first.json?.id) &&
    Number.isInteger(second.json?.id) && first.json.id !== second.json.id
  const checks = [{ name: "setup with two persistent tasks", passed: setup }]
  if (setup) {
    const deleted = await invoke("delete", String(second.json.id))
    checks.push({ name: "delete exits zero and prints one JSON value (no prescribed keys)", passed: deleted.exitCode === 0 && deleted.validJSON })
    const listed = await invoke("list")
    checks.push({ name: "deleted task absent and other task retained across processes", passed: listed.exitCode === 0 &&
      Array.isArray(listed.json) && listed.json.length === 1 && listed.json[0].id === first.json.id })
    const missing = await invoke("delete", "999999")
    checks.push({ name: "missing id fails", passed: missing.exitCode !== 0 })
    const after = await invoke("list")
    checks.push({ name: "failed delete does not replace data", passed: after.exitCode === 0 && JSON.stringify(after.json) === JSON.stringify(listed.json) })
  }
  return { id, rawCheckPassed, supplementaryPassed: checks.length === 5 && checks.every(check => check.passed),
    checks, evaluatedAt: new Date().toISOString(), sourceHashes: {
      cli: await hash(path.join(source, "src/cli.ts")),
      package: await Bun.file(path.join(source, "package.json")).exists() ? await hash(path.join(source, "package.json")) : null,
    } }
}
