import path from "node:path"

const here = import.meta.dir, root = path.resolve(here, "../..")
const run = await Bun.file(path.join(here, "run.json")).json()
const manifest = await Bun.file(path.join(here, "source-manifest.json")).json()
const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
const modes = { native: "baseline", paper: "skill-state-paper" }
const rows = [], issues = []
for (const attempt of run.attempts) {
  if (!attempt.suite) continue
  for (const [mode, folder] of Object.entries(modes)) for (const project of projects) {
    const source = `experiments/codex-skill-state/results/${attempt.suite}/${folder}/${project}/summary.json`
    if (!await Bun.file(path.join(root, source)).exists()) continue
    const summary = await Bun.file(path.join(root, source)).json(), metrics = summary.metrics
    const checks = project === "http-kv" ? 9 : project === "dependency-planner" ? 7 : 8
    if (summary.suite !== attempt.suite || summary.project !== project || summary.model !== "gpt-5.6-sol" ||
        summary.protocolMode !== (mode === "native" ? "baseline" : "paper") || summary.observationWindow !== undefined ||
        summary.cellTimeoutMs !== 900000 || summary.binary.sha256 !== manifest.binaries[folder].sha256 || summary.evaluation.total !== checks)
      throw new Error(`Unexpected frozen contract: ${source}`)
    if (mode === "native" && summary.binary.codeModeHostSha256 !== manifest.binaries.baseline.codeModeHostSha256)
      throw new Error(`Native companion changed: ${source}`)
    let input = 0, output = 0, calls = 0, terminal = false
    for (const line of (await Bun.file(path.join(root, path.dirname(source), "events.jsonl")).text()).split("\n")) {
      try { if (JSON.parse(line).type === "turn.completed") terminal = true } catch {}
    }
    const raw = Bun.file(path.join(root, path.dirname(source), "rollout.jsonl"))
    if (await raw.exists()) {
      for (const line of (await raw.text()).split("\n")) {
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.type !== "token_usage_record") continue
        input += event.payload.usage.input_tokens
        output += event.payload.usage.output_tokens
        calls++
      }
      if (input !== metrics.input || output !== metrics.output || calls !== metrics.samples)
        issues.push({ source, issue: "Usage mismatch", counted: { input, output, calls }, reported: { input: metrics.input, output: metrics.output, calls: metrics.samples } })
    } else issues.push({ source, issue: "Missing rollout; do not infer zero provider activity" })
    rows.push({ runtime: "Codex", model: "sol", suite: attempt.suite, repetition: attempt.repetition, mode, project, source,
      phase: "later-native-paper", threadID: metrics.threadID, passed: summary.evaluation.passed, checks,
      artifactPass: summary.evaluation.passed === checks, exitCode: summary.exitCode, timedOut: summary.timedOut,
      completed: summary.exitCode === 0 && !summary.timedOut, nativeTerminal: mode === "native" ? terminal : null,
      protocolFinished: mode === "native" ? terminal : metrics.finishCalls > 0, finishCalls: metrics.finishCalls,
      input: metrics.input, cached: metrics.cachedInput, output: metrics.output, reasoning: metrics.reasoning,
      calls: metrics.samples, durationMs: metrics.durationMs, stateCalls: metrics.stateCalls, stateErrors: metrics.stateErrors,
      repeatedActions: metrics.repeatedActions, maxRepeatStreak: metrics.maxRepeatStreak })
  }
}
const sum = (values: typeof rows, field: "passed" | "checks" | "input" | "output" | "cached" | "calls" | "durationMs") => values.reduce((n, row) => n + row[field], 0)
const successful = (row: typeof rows[number]) => row.artifactPass && row.completed && row.protocolFinished
const groups = run.attempts.flatMap((attempt: { repetition: number }) => Object.keys(modes).map(mode => {
  const cells = rows.filter(row => row.repetition === attempt.repetition && row.mode === mode)
  return { runtime: "Codex", model: "sol", repetition: attempt.repetition, mode, cells: cells.length,
    passed: sum(cells, "passed"), checks: sum(cells, "checks"), input: sum(cells, "input"), output: sum(cells, "output"),
    cached: sum(cells, "cached"), calls: sum(cells, "calls"), durationMs: sum(cells, "durationMs"),
    finished: cells.filter(row => row.protocolFinished).length, completed: cells.filter(row => row.completed).length,
    projectsPassed: cells.filter(row => row.artifactPass).length, projectsSucceeded: cells.filter(successful).length }
}))
const missing = 100 - rows.length
const n = (value: number) => value.toLocaleString("en-US")
let report = `# Codex / Sol: native и paper, десять повторов\n\nСтатус: ${missing ? `в работе, ${rows.length}/100` : "завершено, 100/100"}. Новые данные не входят в статью.\n\n`
report += "Те же настройки, что у V2/V3: medium, 15 минут, до пяти основных CLI. Native использует transcript и Code Mode, paper — исправленный режим статьи. Input включает кэшированный вход; auxiliary отдельно. Обращения — зарегистрированные ответы модели, не действия и не все сетевые попытки.\n\n"
report += "Завершение native определяется событием turn.completed и чистым выходом, paper — принятым finish и чистым выходом. Полный успех дополнительно требует прохождения всех внешних проверок.\n\n"
report += "| Повтор | Режим | Задач | Проверки | Input | Обращения | Артефакты прошли | Завершение протокола | Полный успех |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n"
for (const group of groups) report += `| ${group.repetition} | ${group.mode} | ${group.cells}/5 | ${group.passed}/${group.checks} | ${n(group.input)} | ${group.calls} | ${group.projectsPassed}/${group.cells} | ${group.finished}/${group.cells} | ${group.projectsSucceeded}/${group.cells} |\n`
report += "\n## Первичные исходы\n\n| Повтор | Режим | Проект | Проверки | Input | Обращения | Таймаут | Завершение протокола |\n|---|---|---|---:|---:|---:|---|---|\n"
for (const row of rows) report += `| ${row.repetition} | ${row.mode} | [${row.project}](../../${row.source}) | ${row.passed}/${row.checks} | ${n(row.input)} | ${row.calls} | ${row.timedOut} | ${row.protocolFinished} |\n`
report += "\n[План до запуска](./PROTOCOL.md). Четырёхсторонняя сводка с прежними V2/V3 формируется отдельно в COMPARE-FOUR.md. Исходный оценщик не изменён; дополнительный тест удаления CLI показывается отдельно.\n"
await Bun.write(path.join(here, "data.json"), JSON.stringify({ generatedAt: new Date().toISOString(), missing, groups, rows }, null, 2) + "\n")
await Bun.write(path.join(here, "usage-audit.json"), JSON.stringify({ partial: missing > 0, checkedCells: rows.length, issues }, null, 2) + "\n")
await Bun.write(path.join(here, "REPORT.md"), report)
if (process.argv.includes("--final")) {
  if (missing || run.status !== "complete" || issues.length) throw new Error("Incomplete or unresolved series")
  for (const [file, expected] of Object.entries({ ...manifest.source.files, ...manifest.protectedFiles })) {
    const hash = new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())).digest("hex")
    if (hash !== expected) throw new Error(`Protected source/results changed: ${file}`)
  }
}
console.log(JSON.stringify({ status: run.status, cells: rows.length, missing, usageIssues: issues.length,
  modes: Object.keys(modes).map(mode => { const cells = rows.filter(row => row.mode === mode); return { mode, cells: cells.length,
    input: sum(cells, "input"), calls: sum(cells, "calls"), passed: sum(cells, "passed"), checks: sum(cells, "checks"),
    success: cells.filter(successful).length, timeouts: cells.filter(row => row.timedOut).length } }) }))
