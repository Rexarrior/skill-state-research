import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const manifest = await Bun.file(path.join(import.meta.dir, "source-manifest.json")).json()
for (const [file, expected] of Object.entries(manifest.files)) {
  const bytes = new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`Frozen source changed: ${file}`)
}
const campaign = await Bun.file(path.join(import.meta.dir, "suites.json")).json() as Array<{
  runtime: "OpenCode" | "Codex", model: string, suite: string, repetition: number, modes: string[],
}>
const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
const directories: Record<string, string> = { native: "baseline", paper: "skill-state-paper", v2: "skill-state", v3: "skill-state-v3" }
const rows = []
const binaryHashes = new Set<string>()
const companionHashes = new Set<string>()
let missing = 0
for (const suite of campaign) {
  for (const project of projects) for (const mode of suite.modes) {
    const folder = suite.runtime === "OpenCode" ? "skill-state" : "codex-skill-state"
    const file = `experiments/${folder}/results/${suite.suite}/${directories[mode]}/${project}/summary.json`
    if (!await Bun.file(path.join(root, file)).exists()) { missing++; continue }
    const cell = await Bun.file(path.join(root, file)).json()
    if (!cell.model.endsWith(`gpt-5.6-${suite.model}`)) throw new Error(`Wrong model: ${file}`)
    if (cell.protocolMode !== (mode === "native" ? "baseline" : mode)) throw new Error(`Wrong mode: ${file}`)
    if (["v2", "v3"].includes(mode) && cell.observationWindow !== 3) throw new Error(`Wrong memory window: ${file}`)
    if (cell.cellTimeoutMs !== 900_000) throw new Error(`Wrong time budget: ${file}`)
    const expectedChecks = project === "http-kv" ? 9 : project === "dependency-planner" ? 7 : 8
    if (cell.evaluation.total !== expectedChecks) throw new Error(`Unexpected evaluator denominator: ${file}`)
    if (suite.runtime === "Codex") {
      binaryHashes.add(cell.binary.sha256)
      if (mode === "native") {
        if (!cell.binary.codeModeHostSha256) throw new Error(`Native Code Mode companion missing: ${file}`)
        companionHashes.add(cell.binary.codeModeHostSha256)
      }
    }
    const m = cell.metrics
    // OpenCode's getUsage subtracts BOTH cache categories from its input field.
    const input = suite.runtime === "OpenCode" ? m.input + m.cacheRead + m.cacheWrite : m.input
    rows.push({
      ...suite, modes: undefined, mode, project, source: file,
      passed: cell.evaluation.passed, checks: cell.evaluation.total,
      artifactPass: cell.evaluation.passed === cell.evaluation.total,
      exitCode: cell.exitCode, timedOut: cell.timedOut,
      completed: cell.exitCode === 0 && !cell.timedOut,
      protocolFinished: mode === "native" ? null : m.finishCalls > 0,
      input, cached: m.cachedInput ?? m.cacheRead, cacheWrite: m.cacheWriteInput ?? m.cacheWrite,
      output: suite.runtime === "OpenCode" ? m.output + m.reasoning : m.output,
      reasoning: m.reasoning, calls: m.samples ?? m.turns,
      durationMs: m.durationMs, stateErrors: m.stateErrors, finishCalls: m.finishCalls,
      actions: m.batchedActions, multiBatches: m.multiActionBatches, maxBatch: m.maxActionsPerBatch,
      failedBatches: m.failedBatches, skippedActions: m.skippedActions,
    })
  }
}
const planned = 120
if (binaryHashes.size > 1 || companionHashes.size > 1) throw new Error("Mixed Codex executables in the campaign")
const keys = rows.map((r) => `${r.runtime}/${r.model}/${r.repetition}/${r.mode}/${r.project}`)
if (new Set(keys).size !== keys.length) throw new Error("Duplicate campaign cell")
const expectedKeys = new Set<string>()
for (const runtime of ["OpenCode", "Codex"]) for (const model of ["sol", "terra"])
  for (const mode of ["native", "paper", "v2", "v3"]) for (const project of projects)
    expectedKeys.add(`${runtime}/${model}/0/${mode}/${project}`)
for (const model of ["sol", "terra"]) for (const rep of [1, 2]) for (const mode of ["v2", "v3"])
  for (const project of projects) expectedKeys.add(`Codex/${model}/${rep}/${mode}/${project}`)
if (expectedKeys.size !== planned || keys.some((key) => !expectedKeys.has(key))) throw new Error("Unplanned campaign cell")
missing = expectedKeys.size - rows.length
if (missing !== 0 && !process.argv.includes("--partial")) throw new Error(`${missing} missing cells; refuse final report`)
const groups = []
for (const suite of campaign) for (const mode of suite.modes) {
  const cells = rows.filter((row) => row.runtime === suite.runtime && row.model === suite.model && row.repetition === suite.repetition && row.mode === mode)
  const sum = (key: keyof typeof rows[number]) => cells.reduce((n, row) => n + (typeof row[key] === "number" ? row[key] as number : 0), 0)
  groups.push({ runtime: suite.runtime, model: suite.model, repetition: suite.repetition, mode,
    cells: cells.length, passed: sum("passed"), checks: sum("checks"),
    projectsPassed: cells.filter((r) => r.artifactPass).length,
    projectsSucceeded: cells.filter((r) => r.artifactPass && r.completed && r.protocolFinished !== false).length,
    completed: cells.filter((r) => r.completed).length,
    finished: cells.filter((r) => r.protocolFinished).length,
    input: sum("input"), cached: sum("cached"), cacheWrite: sum("cacheWrite"), output: sum("output"),
    calls: sum("calls"), durationMs: sum("durationMs"), stateErrors: sum("stateErrors"),
    actions: sum("actions"), multiBatches: sum("multiBatches"), failedBatches: sum("failedBatches"), skippedActions: sum("skippedActions"),
    maxBatch: Math.max(0, ...cells.map((r) => r.maxBatch)),
  })
}
const n = (v: number) => v.toLocaleString("en-US")
let report = `# Technical article campaign results\n\nStatus: ${missing ? `INCOMPLETE (${missing} missing)` : "complete"}. ${rows.length} cells.\n\n`
report += "Input is full provider-reported input of the main agent loop: OpenCode input + cache.read + cache.write; Codex input_tokens already includes cached input. Output includes reasoning (OpenCode output + reasoning; Codex output_tokens). Codex permission-reviewer descendants are measured separately in auxiliary-usage.json; interrupted requests without returned usage are not estimated. Legacy OpenCode suite reports omit cache.write from their prompt metric; use this corrected table. These are not monetary costs. Checks describe artifacts; exit and finish describe execution. Repetitions are independent attempts, not new tasks.\n\n"
report += "| Runtime | Model | Rep | Mode | Checks | Projects | Exit clean | Finish | Input | Calls | Output | Minutes |\n|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|\n"
for (const g of groups) report += `| ${g.runtime} | ${g.model} | ${g.repetition} | ${g.mode} | ${g.passed}/${g.checks} | ${g.projectsPassed}/${g.cells} | ${g.completed}/${g.cells} | ${g.mode === "native" ? "—" : `${g.finished}/${g.cells}`} | ${n(g.input)} | ${g.calls} | ${n(g.output)} | ${(g.durationMs / 60000).toFixed(1)} |\n`
report += "\n## Source suites\n\n"
for (const s of campaign) report += `- ${s.runtime}/${s.model}, repetition ${s.repetition}: [${s.suite}](../${s.runtime === "OpenCode" ? "skill-state" : "codex-skill-state"}/results/${s.suite}/report.md).\n`
report += "\n## Individual outcomes\n\n| Runtime/model | Rep | Task | Mode | Checks | Input | Calls | Timeout | Finish |\n|---|---:|---|---|---:|---:|---:|---|---|\n"
for (const r of rows) report += `| ${r.runtime}/${r.model} | ${r.repetition} | ${r.project} | ${r.mode} | ${r.passed}/${r.checks} | ${n(r.input)} | ${r.calls} | ${r.timedOut} | ${r.protocolFinished ?? "—"} |\n`
await Bun.write(path.join(import.meta.dir, "data.json"), JSON.stringify({ generatedAt: new Date().toISOString(), missing, groups, rows }, null, 2) + "\n")
await Bun.write(path.join(import.meta.dir, "REPORT.md"), report)
console.log(JSON.stringify({ cells: rows.length, missing, groups }, null, 2))
