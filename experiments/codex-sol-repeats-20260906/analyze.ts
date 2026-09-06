import path from "node:path"

const here = import.meta.dir, root = path.resolve(here, "../..")
const run = await Bun.file(path.join(here, "run.json")).json()
const manifest = await Bun.file(path.join(here, "source-manifest.json")).json()
const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
const modes = { v2: "skill-state", v3: "skill-state-v3" }
const rows: any[] = [], issues: any[] = []
for (const attempt of run.attempts) {
  if (!attempt.suite) continue
  for (const [mode, folder] of Object.entries(modes)) for (const project of projects) {
    const source = `experiments/codex-skill-state/results/${attempt.suite}/${folder}/${project}/summary.json`
    const file = Bun.file(path.join(root, source))
    if (!await file.exists()) continue
    const s = await file.json(), m = s.metrics
    if (s.suite !== attempt.suite || s.project !== project || s.protocolMode !== mode || s.model !== "gpt-5.6-sol" ||
        s.observationWindow !== 3 || s.cellTimeoutMs !== 900000 || s.binary.sha256 !== manifest.binaries[folder].sha256)
      throw new Error(`Unexpected run contract: ${source}`)
    const checks = project === "http-kv" ? 9 : project === "dependency-planner" ? 7 : 8
    if (s.evaluation.total !== checks) throw new Error(`Evaluator denominator: ${source}`)
    const raw = Bun.file(path.join(root, path.dirname(source), "rollout.jsonl"))
    const totals = { input: 0, output: 0, calls: 0 }
    const batching = { accepted: 0, rejected: 0, listedActions: 0, executedActions: 0, failed: 0, multi: 0 }
    if (await raw.exists()) {
      for (const line of (await raw.text()).split("\n")) {
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.type === "token_usage_record") {
          totals.input += event.payload.usage.input_tokens
          totals.output += event.payload.usage.output_tokens
          totals.calls++
        }
        if (mode === "v3" && event.type === "response_item" && event.payload?.type === "function_call_output" && event.payload.name === "skill_step") {
          let observation
          try { observation = JSON.parse(event.payload.output).observation } catch { continue }
          if (!Array.isArray(observation?.actions)) continue
          if (!observation.actions.length) { batching.rejected++; continue }
          batching.accepted++
          batching.listedActions += observation.actions.length
          batching.executedActions += observation.actions.filter((a: any) => a.status !== "skipped").length
          if (observation.actions.length > 1) batching.multi++
          if (observation.actions.some((a: any) => a.status === "error")) batching.failed++
        }
      }
      if (totals.input !== m.input || totals.output !== m.output || totals.calls !== m.samples)
        issues.push({ source, issue: "Usage sum differs from runner metrics", totals, reported: { input: m.input, output: m.output, calls: m.samples } })
    } else issues.push({ source, issue: "No rollout; do not infer zero provider activity" })
    rows.push({ runtime: "Codex", model: "sol", suite: attempt.suite, repetition: attempt.repetition,
      mode, project, source, threadID: m.threadID, passed: s.evaluation.passed, checks, artifactPass: s.evaluation.passed === checks,
      exitCode: s.exitCode, timedOut: s.timedOut, completed: s.exitCode === 0 && !s.timedOut,
      protocolFinished: m.finishCalls > 0, input: m.input, cached: m.cachedInput, output: m.output,
      reasoning: m.reasoning, calls: m.samples, durationMs: m.durationMs, stateErrors: m.stateErrors,
      finishCalls: m.finishCalls, actions: m.batchedActions, multiBatches: m.multiActionBatches,
      failedBatches: m.failedBatches, skippedActions: m.skippedActions, maxBatch: m.maxActionsPerBatch,
      acceptedBatches: batching.accepted, rejectedBatches: batching.rejected, executedBatchActions: batching.executedActions,
      listedBatchActions: batching.listedActions, acceptedFailedBatches: batching.failed,
      stateCalls: m.stateCalls,
      repeatedActions: m.repeatedActions, maxRepeatStreak: m.maxRepeatStreak })
  }
}
const successful = (r: any) => r.artifactPass && r.completed && r.protocolFinished
const sum = (items: any[], key: string) => items.reduce((n, r) => n + r[key], 0)
const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const i = (sorted.length - 1) * p, lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
}
const distribution = (values: number[]) => ({ n: values.length, mean: values.length ? sum(values.map((v) => ({ v })), "v") / values.length : null,
  min: values.length ? Math.min(...values) : null, q25: quantile(values, .25), median: quantile(values, .5),
  q75: quantile(values, .75), p90: quantile(values, .9), max: values.length ? Math.max(...values) : null })
const groups: any[] = []
for (const a of run.attempts) for (const mode of Object.keys(modes)) {
  const cells = rows.filter((r) => r.repetition === a.repetition && r.mode === mode)
  groups.push({ runtime: "Codex", model: "sol", repetition: a.repetition, mode, cells: cells.length,
    passed: sum(cells, "passed"), checks: sum(cells, "checks"), input: sum(cells, "input"),
    output: sum(cells, "output"), cached: sum(cells, "cached"), calls: sum(cells, "calls"),
    durationMs: sum(cells, "durationMs"), finished: cells.filter((r) => r.protocolFinished).length,
    completed: cells.filter((r) => r.completed).length, projectsPassed: cells.filter((r) => r.artifactPass).length,
    projectsSucceeded: cells.filter(successful).length })
}
const missing = 100 - rows.length
const paired = rows.filter((r) => r.mode === "v2").flatMap((v2) => {
  const v3 = rows.find((r) => r.mode === "v3" && r.repetition === v2.repetition && r.project === v2.project)
  return v3 ? [{ repetition: v2.repetition, project: v2.project, v2, v3,
    inputRatio: v2.input ? v3.input / v2.input - 1 : null, inputDelta: v3.input - v2.input,
    callsDelta: v3.calls - v2.calls, bothSucceeded: successful(v2) && successful(v3) }] : []
})
const statistics = Object.keys(modes).map((mode) => {
  const cells = rows.filter((r) => r.mode === mode), full = groups.filter((g) => g.mode === mode && g.cells === 5)
  return { mode, cells: cells.length, fullAttempts: full.length, input: sum(cells, "input"), calls: sum(cells, "calls"),
    output: sum(cells, "output"), passed: sum(cells, "passed"), checks: sum(cells, "checks"),
    success: cells.filter(successful).length, timeouts: cells.filter((r) => r.timedOut).length,
    finished: cells.filter((r) => r.protocolFinished).length,
    attemptInput: distribution(full.map((g) => g.input)), attemptCalls: distribution(full.map((g) => g.calls)),
    cellMinutes: distribution(cells.map((r) => r.durationMs / 60000)),
    perProject: projects.map((project) => {
      const selected = cells.filter((r) => r.project === project)
      return { project, cells: selected.length, success: selected.filter(successful).length,
        passed: sum(selected, "passed"), checks: sum(selected, "checks"),
        input: distribution(selected.map((r) => r.input)), calls: distribution(selected.map((r) => r.calls)) }
    }) }
})
const fullPairs = run.attempts.flatMap((a: any) => {
  const v2 = groups.find((g) => g.repetition === a.repetition && g.mode === "v2"), v3 = groups.find((g) => g.repetition === a.repetition && g.mode === "v3")
  return v2.cells === 5 && v3.cells === 5 ? [{ repetition: a.repetition, v2, v3, ratio: v3.input / v2.input - 1 }] : []
})
const n = (v: number | null) => v === null ? "—" : Math.round(v).toLocaleString("en-US")
const fractional = (v: number | null) => v === null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 1 })
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`
let report = `# Codex / Sol — 10 повторов V2 и V3\n\nСтатус: ${missing ? `не завершено, ${rows.length}/100 задач` : "завершено, 100/100 задач"}. Отдельная серия для внутреннего анализа; не входит в статью.\n\n`
report += "Условия: k=3, medium reasoning, 15 минут на задачу, до пяти основных CLI одновременно. Input включает кэшированный вход основной модели; вспомогательные вызовы считаются отдельно. Обращения — зарегистрированные ответы модели, не действия батча и не все сетевые попытки. Это не денежная стоимость. Неудачные исходы сохранены.\n\n"
report += "## Полные попытки\n\n| Попытка | V2 проверки | V2 input | V2 обращения | V2 успех | V3 проверки | V3 input | V3 обращения | V3 успех | V3/V2 input |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n"
for (const p of fullPairs) report += `| ${p.repetition} | ${p.v2.passed}/40 | ${n(p.v2.input)} | ${p.v2.calls} | ${p.v2.projectsSucceeded}/5 | ${p.v3.passed}/40 | ${n(p.v3.input)} | ${p.v3.calls} | ${p.v3.projectsSucceeded}/5 | ${pct(p.ratio)} |\n`
report += "\nУспех = все внешние проверки пройдены, процесс завершился без ошибки/таймаута и принят finish.\n\n## Распределения\n\n| Режим | Задач | Проверки | Успех | Finish | Таймауты | Input всего | Обращения всего | Медиана input полной попытки | Q25–Q75 | Min–Max |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n"
for (const s of statistics) report += `| ${s.mode} | ${s.cells} | ${s.passed}/${s.checks} | ${s.success}/${s.cells} | ${s.finished}/${s.cells} | ${s.timeouts} | ${n(s.input)} | ${s.calls} | ${n(s.attemptInput.median)} | ${n(s.attemptInput.q25)}–${n(s.attemptInput.q75)} | ${n(s.attemptInput.min)}–${n(s.attemptInput.max)} |\n`
report += "\nКвантили вычислены линейной интерполяцией по упорядоченной выборке; интервалы здесь описательные, не доверительные.\n\n## По задачам\n\n| Проект | Режим | Успех | Проверки | Input: среднее | Медиана | Min–Max | Обращения: медиана | Min–Max |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n"
for (const project of projects) for (const s of statistics) {
  const p = s.perProject.find((p) => p.project === project)!
  report += `| ${project} | ${s.mode} | ${p.success}/${p.cells} | ${p.passed}/${p.checks} | ${n(p.input.mean)} | ${n(p.input.median)} | ${n(p.input.min)}–${n(p.input.max)} | ${fractional(p.calls.median)} | ${n(p.calls.min)}–${n(p.calls.max)} |\n`
}
report += "\n## Использование батчей V3\n\n"
const v3rows = rows.filter((r) => r.mode === "v3"), accepted = sum(v3rows, "acceptedBatches")
report += `Принятых непустых батчей: ${accepted}; отклонённых с пустым массивом результатов: ${sum(v3rows, "rejectedBatches")}. Действий в записанных батчах: ${sum(v3rows, "listedBatchActions")}, из них не пропущено: ${sum(v3rows, "executedBatchActions")}. Среднее число записанных действий на принятый батч: ${accepted ? (sum(v3rows, "listedBatchActions") / accepted).toFixed(2) : "—"}. Максимум: ${Math.max(0, ...v3rows.map((r) => r.maxBatch))}. Принятых батчей с ошибкой действия: ${sum(v3rows, "acceptedFailedBatches")}.\n\n`
report += "В это число входят finish и ошибочные действия; непустой батч не обязательно успешен. Непропущенный вызов инструмента не гарантирует завершение запущенного ОС-процесса. Число обращений к модели не подменяется числом принятых батчей.\n"
report += "\n## Парные сравнения и ограничения\n\n"
if (fullPairs.length) {
  const ratio = fullPairs.reduce((s, p) => s + p.v3.input, 0) / fullPairs.reduce((s, p) => s + p.v2.input, 0) - 1
  report += `В ${fullPairs.length} полных парных попытках V3 использовала ${pct(ratio)} основного input к V2; меньше входа в ${fullPairs.filter((p) => p.ratio < 0).length}/${fullPairs.length} попыток. Медиана относительной разницы: ${pct(quantile(fullPairs.map((p) => p.ratio), .5)!)}.\n\n`
  const input2 = fullPairs.reduce((s, p) => s + p.v2.input, 0), input3 = fullPairs.reduce((s, p) => s + p.v3.input, 0)
  const calls2 = fullPairs.reduce((s, p) => s + p.v2.calls, 0), calls3 = fullPairs.reduce((s, p) => s + p.v3.calls, 0)
  if (calls2 && calls3 && input2) report += `Разложение накопленного входа на число обращений и средний вход одного обращения: V2 — ${calls2} × ${n(input2 / calls2)}; V3 — ${calls3} × ${n(input3 / calls3)} (средние в тексте округлены). Обращений у V3 ${pct(calls3 / calls2 - 1)}, среднего input на обращение ${pct((input3 / calls3) / (input2 / calls2) - 1)}. Это арифметическое разложение измеренного расхода, не причинная оценка влияния batching.\n\n`
}
const valid = paired.filter((p) => p.bothSucceeded)
report += `Пар отдельных задач: ${paired.length}; обе версии полностью успешны в ${valid.length}. Среди только этих успешных пар меньше input у V3 в ${valid.filter((p) => p.inputDelta < 0).length}, равенство в ${valid.filter((p) => p.inputDelta === 0).length}. Это условный срез, не замена общей оценки качества.\n\n`
report += "Десять попыток повторяют пять известных задач, а не расширяют выборку до пятидесяти независимых задач. Порядок чередуется, но не рандомизирован. Время и конкурентность отличаются от прошлой серии; результаты не объединяются с ней. V2/V3 меняют и количество действий между запросами, и объём окна; причинные выводы о batching отдельно невозможны.\n\n"
const deletionAudit = Bun.file(path.join(here, "taskboard-delete-audit.json"))
if (await deletionAudit.exists()) {
  const audit = await deletionAudit.json()
  const eligible = new Set(audit.outcomes.filter((o: any) => o.rawCheckPassed === false && o.supplementaryPassed).map((o: any) => o.source))
  report += "## Чувствительность качества к избыточному требованию оценщика\n\n"
  report += `После начала серии обнаружено, что проверка delete требует поле id в JSON-ответе, хотя спецификация его не задаёт. Дополнительная проверка фактического удаления выполнена на ${audit.outcomes.length}/20 изолированных копий CLI-проектов обеих версий. Исходные баллы выше не изменены. Ниже — отдельный ретроспективный срез, заменяющий только эту проверку там, где её избыточность подтверждена; остальные проверки не переоцениваются. [Подробности](./EVALUATOR-NOTE.md), [данные перепроверки](./taskboard-delete-audit.json).\n\n`
  report += "| Режим | Исходные проверки | С заменой только проверки delete | Исходный успех задач | Успех в этом срезе |\n|---|---:|---:|---:|---:|\n"
  for (const s of statistics) {
    const cells = rows.filter((r) => r.mode === s.mode), gain = cells.filter((r) => eligible.has(r.source)).length
    const successes = cells.filter((r) => r.completed && r.protocolFinished && r.passed + (eligible.has(r.source) ? 1 : 0) === r.checks).length
    report += `| ${s.mode} | ${s.passed}/${s.checks} | ${s.passed + gain}/${s.checks} | ${s.success}/${s.cells} | ${successes}/${s.cells} |\n`
  }
  report += "\nЭтот срез не является новым заранее зарегистрированным benchmark и не даёт права считать все прочие тесты исчерпывающей проверкой спецификации. Input, обращения, завершение и исходные summaries не меняются.\n\n"
}
report += "## Исходные серии\n\n"
for (const a of run.attempts) if (a.suite) report += `- Попытка ${a.repetition}, порядок ${a.modes.join(" → ")}, статус ${a.status}: [${a.suite}](../codex-skill-state/results/${a.suite}/report.md).\n`
report += "\n## Отдельные исходы\n\n| Попытка | Проект | Режим | Проверки | Input | Обращения | Таймаут | Finish |\n|---|---|---|---:|---:|---:|---|---|\n"
for (const r of rows) report += `| ${r.repetition} | [${r.project}](../../${r.source}) | ${r.mode} | ${r.passed}/${r.checks} | ${n(r.input)} | ${r.calls} | ${r.timedOut} | ${r.protocolFinished} |\n`
await Bun.write(path.join(here, "data.json"), JSON.stringify({ generatedAt: new Date().toISOString(), missing, groups, rows }, null, 2) + "\n")
await Bun.write(path.join(here, "statistics.json"), JSON.stringify({ statistics, fullPairs, paired }, null, 2) + "\n")
await Bun.write(path.join(here, "usage-audit.json"), JSON.stringify({ partial: missing > 0, checkedCells: rows.length, issues }, null, 2) + "\n")
await Bun.write(path.join(here, "REPORT.md"), report)
if (process.argv.includes("--final")) {
  if (missing || run.status !== "complete" || issues.length) throw new Error("Incomplete or unresolved series")
  const hash = async (file: string) => new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())).digest("hex")
  for (const [file, expected] of Object.entries({ ...manifest.source.files, ...manifest.protectedFiles }))
    if (await hash(file) !== expected) throw new Error(`Protected file changed: ${file}`)
}
console.log(JSON.stringify({ status: run.status, cells: rows.length, missing, completeAttempts: fullPairs.length,
  modes: statistics.map(({ mode, cells, input, calls, passed, checks, success, timeouts }) => ({ mode, cells, input, calls, passed, checks, success, timeouts })), usageIssues: issues.length }))
