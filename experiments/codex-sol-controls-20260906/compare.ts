import path from "node:path"

const here = import.meta.dir, root = path.resolve(here, "../..")
const previous = path.join(root, "experiments/codex-sol-repeats-20260906")
const before = await Bun.file(path.join(previous, "data.json")).json(), current = await Bun.file(path.join(here, "data.json")).json()
if (before.missing || before.rows.length !== 100) throw new Error("Prior series incomplete")
const rows = [...before.rows.map((row: object) => ({ ...row, phase: "earlier-v2-v3" })), ...current.rows]
if (new Set(rows.map(row => row.source)).size !== rows.length || new Set(rows.map(row => row.threadID)).size !== rows.length)
  throw new Error("Duplicate source or reused main thread")
const corrected = new Set<string>(), auxiliary = new Map<string, number>()
for (const directory of [previous, here]) {
  const deletion = Bun.file(path.join(directory, "taskboard-delete-audit.json"))
  if (await deletion.exists()) for (const row of (await deletion.json()).outcomes)
    if (row.rawCheckPassed === false && row.supplementaryPassed) corrected.add(row.source)
  const usage = Bun.file(path.join(directory, "auxiliary-usage.json"))
  if (await usage.exists()) for (const row of (await usage.json()).outcomes) auxiliary.set(row.source, row.auxiliaryInput)
}
const modes = ["native", "paper", "v2", "v3"]
const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
const sum = (values: number[]) => values.reduce((n, value) => n + value, 0)
const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const i = (sorted.length - 1) * p
  return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i - Math.floor(i))
}
const distribution = (values: number[]) => ({ n: values.length, mean: values.length ? sum(values) / values.length : null,
  min: quantile(values, 0), q25: quantile(values, .25), median: quantile(values, .5), q75: quantile(values, .75), max: quantile(values, 1) })
const groups = [...before.groups, ...current.groups]
const statistics = modes.map(mode => {
  const selected = rows.filter(row => row.mode === mode), full = groups.filter(group => group.mode === mode && group.cells === 5)
  const artifact = (row: typeof rows[number]) => row.passed + Number(corrected.has(row.source)) === row.checks
  return { mode, cells: selected.length, fullAttempts: full.length, phase: mode === "native" || mode === "paper" ? "later-native-paper" : "earlier-v2-v3",
    input: sum(selected.map(row => row.input)), output: sum(selected.map(row => row.output)), calls: sum(selected.map(row => row.calls)),
    passed: sum(selected.map(row => row.passed)), checks: sum(selected.map(row => row.checks)), artifactPass: selected.filter(row => row.artifactPass).length,
    finished: selected.filter(row => row.completed && row.protocolFinished).length, timeouts: selected.filter(row => row.timedOut).length,
    success: selected.filter(row => row.artifactPass && row.completed && row.protocolFinished).length,
    correctedChecks: sum(selected.map(row => row.passed + Number(corrected.has(row.source)))), correctedArtifacts: selected.filter(artifact).length,
    correctedSuccess: selected.filter(row => artifact(row) && row.completed && row.protocolFinished).length,
    auxiliaryCells: selected.filter(row => auxiliary.has(row.source)).length, auxiliaryInput: sum(selected.map(row => auxiliary.get(row.source) ?? 0)),
    attemptInput: distribution(full.map(group => group.input)), attemptCalls: distribution(full.map(group => group.calls)),
    cellMinutes: distribution(selected.map(row => row.durationMs / 60000)),
    perProject: projects.map(project => { const cells = selected.filter(row => row.project === project); return {
      project, cells: cells.length, input: distribution(cells.map(row => row.input)), calls: distribution(cells.map(row => row.calls)),
      finished: cells.filter(row => row.completed && row.protocolFinished).length, timeouts: cells.filter(row => row.timedOut).length,
      passed: sum(cells.map(row => row.passed)), checks: sum(cells.map(row => row.checks)), correctedChecks: sum(cells.map(row => row.passed + Number(corrected.has(row.source)))) } }) }
})
const n = (value: number | null) => value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 1 })
const pct = (value: number) => `${value >= 0 ? "+" : ""}${(100 * value).toFixed(1)}%`
let report = `# Codex / Sol: native, paper, V2 и V3\n\nСтатус: ${rows.length}/200 исходов. ${current.missing ? "Новая серия ещё идёт; её неполные суммы несопоставимы с полными V2/V3." : "Обе серии завершены."}\n\n`
report += "По десять повторов пяти задач на режим. V2/V3 выполнены раньше, native/paper позже; настройки и бинарник одинаковы, но четыре режима не перемешаны во времени. Номера повторов — порядковые метки, не одинаковые random seeds. Это не рандомизированный четырёхсторонний эксперимент. Native сохраняет Code Mode, state-режимы используют direct tools; V2/V3 имеют k=3, paper — только последнее наблюдение.\n\n"
report += "## Исходный оценщик\n\n| Режим | Задач | Проверки | Артефакты прошли | Чистое завершение | Полный успех | Таймауты | Основной input | Обращения |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n"
for (const s of statistics) report += `| ${s.mode} | ${s.cells} | ${s.passed}/${s.checks} | ${s.artifactPass}/${s.cells} | ${s.finished}/${s.cells} | ${s.success}/${s.cells} | ${s.timeouts} | ${n(s.input)} | ${s.calls} |\n`
report += "\nЧистое завершение: exit=0 без таймаута плюс turn.completed для native либо finish для state. Полный успех дополнительно требует всех внешних проверок. Input включает кэшированный вход основной модели. Обращения — ответы с usage, не действия и не все HTTP-попытки.\n\n"
report += "## Поправка только к избыточному тесту delete\n\nИсходные оценки выше сохранены. Дополнительный тест фактического удаления применяется одинаково к CLI-проектам всех режимов; остальные проверки не переоцениваются. Для V2/V3 проблема обнаружена после начала прежней серии, для native/paper этот дополнительный срез объявлен до запуска. Это не замена исходного benchmark.\n\n| Режим | Проверки в срезе | Артефакты прошли | Полный успех |\n|---|---:|---:|---:|\n"
for (const s of statistics) report += `| ${s.mode} | ${s.correctedChecks}/${s.checks} | ${s.correctedArtifacts}/${s.cells} | ${s.correctedSuccess}/${s.cells} |\n`
report += "\n## Распределение полных повторов\n\n| Режим | Полных повторов | Input: медиана | Q25–Q75 | Min–Max | Обращения: медиана | Min–Max |\n|---|---:|---:|---:|---:|---:|---:|\n"
for (const s of statistics) report += `| ${s.mode} | ${s.fullAttempts} | ${n(s.attemptInput.median)} | ${n(s.attemptInput.q25)}–${n(s.attemptInput.q75)} | ${n(s.attemptInput.min)}–${n(s.attemptInput.max)} | ${n(s.attemptCalls.median)} | ${n(s.attemptCalls.min)}–${n(s.attemptCalls.max)} |\n`
report += "\nКвантили — линейная интерполяция, не доверительные интервалы.\n\n"
if (!current.missing) {
  const native = statistics[0]
  report += "## Разница к native\n\n| Режим | Основной input | Обращения |\n|---|---:|---:|\n"
  for (const s of statistics.slice(1)) report += `| ${s.mode} | ${pct(s.input / native.input - 1)} | ${pct(s.calls / native.calls - 1)} |\n`
}
report += "\n## Наблюдаемые вспомогательные вызовы\n\n| Режим | Покрытие | Основной input | Auxiliary input | Наблюдаемая сумма |\n|---|---:|---:|---:|---:|\n"
for (const s of statistics) report += `| ${s.mode} | ${s.auxiliaryCells}/${s.cells} | ${n(s.input)} | ${n(s.auxiliaryInput)} | ${s.auxiliaryCells === s.cells ? n(s.input + s.auxiliaryInput) : "ещё не собрано полностью"} |\n`
report += "\nЭто зарегистрированные ответы связанных дочерних сессий, иногда других моделей, не деньги и не оценка незавершённых запросов. Отсутствие записей не доказывает отсутствие расходов.\n\n## По проектам\n\n| Проект | Режим | Задач | Проверки | Чистое завершение | Таймауты | Средний input | Медиана input | Медиана обращений |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n"
for (const project of projects) for (const s of statistics) {
  const p = s.perProject.find(p => p.project === project)!
  report += `| ${project} | ${s.mode} | ${p.cells} | ${p.passed}/${p.checks} | ${p.finished}/${p.cells} | ${p.timeouts} | ${n(p.input.mean)} | ${n(p.input.median)} | ${n(p.calls.median)} |\n`
}
report += "\n## Все полные повторы\n\n| Повтор | Режим | Проверки | Input | Обращения | Полный успех |\n|---|---|---:|---:|---:|---:|\n"
for (let repetition = 1; repetition <= 10; repetition++) for (const mode of modes) {
  const g = groups.find(group => group.repetition === repetition && group.mode === mode)
  if (g?.cells === 5) report += `| ${repetition} | ${mode} | ${g.passed}/${g.checks} | ${n(g.input)} | ${g.calls} | ${g.projectsSucceeded}/5 |\n`
}
report += "\n## Ограничения и материалы\n\nПять задач не превращаются в пятьдесят независимых задач от повторения. Сохраняются настройки хоста и различия упаковки инструментов; время проведения — дополнительный фактор. State-режимы меняют несколько компонентов сразу, поэтому это сравнение реализаций, а не причинная абляция каждого изменения. Статья и её набор данных не изменены.\n\n"
report += "Общий state-лимит результата — 4 KiB плюс маркер: один последний результат у paper, окно действий у V2 и батчей у V3. Общие бюджеты свидетельств поэтому различаются; Native использует штатную политику инструментов. Paper рекурсивно сливает словари patch, V2/V3 заменяют затронутые верхнеуровневые значения. В state-режимах ранние developer/user сообщения упакованы в P с текстовыми метками ролей, Native сохраняет API-роли. Эти адаптации были описаны в [аудите соответствия](../PAPER-CONFORMANCE.md). Низкий счётчик точных повторов не исключает повторного чтения с меняющимися аргументами: [наблюдение и обрезка](./READING-LOOP-NOTE.md).\n\n"
report += "[Условия новых запусков](./PROTOCOL.md) · [новые исходы](./REPORT.md) · [V2/V3](../codex-sol-repeats-20260906/REPORT.md) · [разбор оценщика](../codex-sol-repeats-20260906/EVALUATOR-NOTE.md) · [машиночитаемая сводка](./combined-data.json).\n"
await Bun.write(path.join(here, "combined-data.json"), JSON.stringify({ generatedAt: new Date().toISOString(), missing: current.missing, statistics, groups, rows }, null, 2) + "\n")
await Bun.write(path.join(here, "COMPARE-FOUR.md"), report)
console.log(JSON.stringify({ cells: rows.length, missing: current.missing, statistics: statistics.map(({ mode, cells, input, calls, passed, checks, success, correctedSuccess, timeouts }) => ({ mode, cells, input, calls, passed, checks, success, correctedSuccess, timeouts })) }))
