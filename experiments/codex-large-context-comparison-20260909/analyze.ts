import path from "node:path"

const here = import.meta.dir
const data = await Bun.file(path.join(here, "data.json")).json()
const deletion = await Bun.file(path.join(here, "taskboard-delete-audit.json")).json()
const budgets = await Bun.file(path.join(here, "context-budget-audit.json")).json()
const names: Record<string, string> = { native: "Native", paper: "Paper", v2: "V2", v3: "V3" }
const number = (n: number) => n.toLocaleString("ru-RU").replaceAll("\u00a0", " ")
const million = (n: number) => (n / 1e6).toFixed(3).replace(".", ",")
const percent = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n * 100).toFixed(1).replace(".", ",") + "%"
const statistics = []
const repeats = []
for (const cohort of ["astra", "sol"]) {
  const cells = data.rows.filter((row: { cohort: string }) => row.cohort === cohort)
  const baseline = cells.filter((row: { mode: string }) => row.mode === "native")
    .reduce((n: number, row: { input: number }) => n + row.input, 0)
  for (const mode of Object.keys(names)) {
    const rows = cells.filter((row: { mode: string }) => row.mode === mode)
    if (rows.length !== 25) throw new Error("Expected 25 sessions per group")
    const corrected = rows.map((row: { id: string, project: string, passed: number, total: number, completed: boolean, protocolFinished: boolean }) => {
      const audit = deletion.outcomes.find((o: { id: string }) => o.id === row.id)
      if (row.project === "taskboard-cli" && !audit) throw new Error("Missing supplementary check")
      const passed = row.passed + (audit ? Number(audit.supplementaryPassed) - Number(audit.rawCheckPassed) : 0)
      return { passed, success: passed === row.total && row.completed && row.protocolFinished }
    })
    const total = (key: string) => rows.reduce((n: number, row: Record<string, number>) => n + row[key], 0)
    const audits = rows.map((row: { id: string }) => budgets.audits.find((a: { id: string }) => a.id === row.id))
    if (audits.some((audit: unknown) => !audit)) throw new Error("Missing budget audit")
    const auditSum = (key: string) => audits.reduce((n: number, a: Record<string, number>) => n + a[key], 0)
    const auditMax = (key: string) => Math.max(...audits.map((a: Record<string, number>) => a[key]))
    statistics.push({ cohort, mode, sessions: rows.length, input: total("input"), output: total("output"),
      cachedInput: total("cachedInput"), calls: total("calls"), durationMs: total("durationMs"),
      inputPerTask: total("input") / 25, callsPerTask: total("calls") / 25,
      inputPerCall: total("input") / total("calls"), minutesPerTask: total("durationMs") / 1500000,
      relativeInput: total("input") / baseline - 1, passed: total("passed"), checks: total("total"),
      rawSuccess: rows.filter((r: { rawSuccess: boolean }) => r.rawSuccess).length,
      artifactsPassing: rows.filter((r: { artifactPass: boolean }) => r.artifactPass).length,
      correctedPassed: corrected.reduce((n: number, r: { passed: number }) => n + r.passed, 0),
      correctedSuccess: corrected.filter((r: { success: boolean }) => r.success).length,
      timeouts: rows.filter((r: { timedOut: boolean }) => r.timedOut).length,
      malformedTransitions: auditSum("malformedTransitions"), inputPreviews: auditSum("inputPreviews"),
      skillResultTruncations: auditSum("skillResultTruncations"), earlierToolTruncationMarkers: auditSum("earlierToolTruncationMarkers"),
      maxStateBytes: auditMax("maxStateBytes"), maxInputBytes: auditMax("maxInputBytes"), maxResultBytes: auditMax("maxResultBytes"),
    })
    for (let repetition = 1; repetition <= 5; repetition++) {
      const sample = rows.filter((row: { repetition: number }) => row.repetition === repetition)
      if (sample.length !== 5 || new Set(sample.map((r: { project: string }) => r.project)).size !== 5)
        throw new Error("Incomplete repeat")
      const sum = (key: string) => sample.reduce((n: number, row: Record<string, number>) => n + row[key], 0)
      repeats.push({ cohort, mode, repetition, inputPerTask: sum("input") / 5, callsPerTask: sum("calls") / 5,
        minutesPerTask: sum("durationMs") / 300000, timeouts: sample.filter((r: { timedOut: boolean }) => r.timedOut).length })
    }
  }
}
await Bun.write(path.join(here, "statistics.json"), JSON.stringify({ statistics, repeats }, null, 2) + "\n")
for (const cohort of ["astra", "sol"]) {
  const group = statistics.filter(row => row.cohort === cohort)
  const run = data.runs.find((r: { cohort: string }) => r.cohort === cohort)
  const source = `codex-${cohort}-large-context-2026090${cohort === "astra" ? 8 : 9}`
  const label = cohort === "astra" ? "Astra" : "Sol"
  const changes = deletion.outcomes.filter((r: { cohort: string, rawCheckPassed: boolean, supplementaryPassed: boolean }) =>
    r.cohort === cohort && r.rawCheckPassed !== r.supplementaryPassed).length
  const lines = [
    `# Codex / ${label}: пять повторов с лимитами 2 MiB`, "",
    `100/100 сессий; модель ${run.model}, reasoning medium, до пяти CLI одновременно. Пять повторов пяти прежних проектов в каждом режиме; 25 сессий и 200 исходных assertions на режим. Лимит — 15 минут, V2/V3 — k=3.`, "",
    `Начало: ${run.startedAt}; окончание: ${run.endedAt}. [Протокол](../${source}/PROTOCOL.md), [конечное состояние](../${source}/run.json).`, "",
    "| Режим | Input, млн | К Native | Обращения | Полный успех | Таймауты |",
    "|---|---:|---:|---:|---:|---:|",
    ...group.map(s => "| " + [names[s.mode], million(s.input), s.mode === "native" ? "—" : percent(s.relativeInput),
      s.calls, s.correctedSuccess + "/25", s.timeouts].join(" | ") + " |"), "",
    "Полный успех: все проверки после спецификационной проверки CLI delete, exit 0 без таймаута и turn.completed у Native либо принятый finish у state. Все исходы включены в токены, циклы и время; никакого best-of или замены таймаутов. Input включает cached input без повторного прибавления; отдельный permission reviewer не входит в эти суммы. Это не расчёт стоимости. Его расход в данном дополнении не пересчитывался.", "",
    "## Качество и время", "",
    "| Режим | Исходные проверки | После CLI-аудита | Cached input | Output | Минуты на задачу |",
    "|---|---:|---:|---:|---:|---:|",
    ...group.map(s => "| " + [names[s.mode], `${s.passed}/${s.checks}`, `${s.correctedPassed}/${s.checks}`,
      number(s.cachedInput), number(s.output), s.minutesPerTask.toFixed(2).replace(".", ",")].join(" | ") + " |"), "",
    `Проверка удаления выполнена на изолированных копиях всех 20 CLI-проектов этой модели, 40 для обеих моделей. Число изменившихся оценок здесь: ${changes}. Исходный оценщик и его результаты не переписаны. [Исходы дополнительной проверки](taskboard-delete-audit.json). Остальные требования повторно не оценивались.`, "",
    "Время включает ожидания и ограничено таймаутом; это не чистое время модели и не время успешного решения оборванных задач. Цикл — зарегистрированный ответ основной модели, а не отдельное действие или все сетевые попытки. 200 assertions не являются 200 независимыми задачами.", "",
    "## Обрезка и фактические размеры", "",
    "| Режим | Обрезки input/result SKILL.state | Повреждённые переходы | Max state, байт | Max input действия, байт | Max result, байт | Более ранние маркеры усечения* |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...group.filter(s => s.mode !== "native").map(s => "| " + [names[s.mode], `${s.inputPreviews}/${s.skillResultTruncations}`,
      s.malformedTransitions, s.maxStateBytes, s.maxInputBytes, s.maxResultBytes, s.earlierToolTruncationMarkers].join(" | ") + " |"), "",
    "*Эвристический поиск маркеров в сохранённых ответах, не измерение всех потерянных байтов и не packet capture. У Native этот диагностический счётчик переходов неприменим. Отсутствие обрезок SKILL.state не означает отключения штатных лимитов инструментов или провайдера.", "",
    "Для обеих серий использован один вариант бинарника: четыре ограничения подняты до 2 097 152 байт каждое, а JSON перехода защищён от вторичной обрезки контейнера при сохранении истории. Comment остался 1 KiB. Схемы, инструкции, k, инструменты и правила finish не менялись. Это совместная проверка нескольких изменений, не их отдельная абляция. 2 MiB — верхний предел поля, не фактический размер каждого запроса и не окно модели.", "",
    "Глобальные источники временно перемещались и восстановлены; в начальных контекстах нет проверяемых маркеров скиллов/профиля. Источники и бинарник сверены по замороженным отпечаткам. Native использует Code Mode, state — Direct tools: отличие поверхности инструментов остаётся. Сопоставление со старыми лимитами — между отдельными сериями, не парный причинный эксперимент.", "",
    "## Каждый повтор", "",
    "| Повтор | Режим | Input на задачу | Обращения на задачу | Минуты на задачу | Таймауты |",
    "|---|---|---:|---:|---:|---:|",
    ...repeats.filter(r => r.cohort === cohort).map(r => "| " + [r.repetition, names[r.mode], number(r.inputPerTask),
      r.callsPerTask.toFixed(2), r.minutesPerTask.toFixed(2), r.timeouts].join(" | ") + " |"), "",
    "## Данные", "",
    "[Персессионные результаты](data.json), [usage по обращениям](usage-records.json), [размеры и маркеры обрезки](context-budget-audit.json), [стартовый контекст: только отпечатки и признаки](initial-context-audit.json), [статистика и точки графиков](statistics.json), [manifest проектов](archive-manifest.json), [происхождение](source-hashes.json). Код проектов — в artifacts по полю archive. Сырые промпты, рассуждения и вывод инструментов остаются локально в .private; этот пакет их не публикует.", "",
  ]
  await Bun.write(path.join(here, `REPORT-${cohort}.md`), lines.join("\n"))
}
console.log(JSON.stringify(statistics, null, 2))
