import path from "node:path"

const here = import.meta.dir
const data = await Bun.file(path.join(here, "data.json")).json()
const deletion = await Bun.file(path.join(here, "taskboard-delete-audit.json")).json()
const auxiliary = await Bun.file(path.join(here, "auxiliary-usage.json")).json()
const names: Record<string, string> = { native: "Native", paper: "Paper", v2: "V2", v3: "V3" }
const number = (n: number) => n.toLocaleString("ru-RU").replaceAll("\u00a0", " ")
const million = (n: number) => (n / 1e6).toFixed(3).replace(".", ",")
const pct = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n * 100).toFixed(1).replace(".", ",") + "%"
const statistics = []
const repeats = []
for (const cohort of ["sol", "astra"]) {
  const cells = data.rows.filter((row: { cohort: string }) => row.cohort === cohort)
  const baseline = cells.filter((row: { mode: string }) => row.mode === "native")
    .reduce((n: number, row: { input: number }) => n + row.input, 0)
  for (const mode of Object.keys(names)) {
    const rows = cells.filter((row: { mode: string }) => row.mode === mode)
    if (rows.length !== 25) throw new Error("Expected 25 sessions per group")
    let correctedPassed = 0, correctedSuccess = 0
    for (const row of rows) {
      const audit = deletion.outcomes.find((o: { id: string }) => o.id === row.id)
      if (row.project === "taskboard-cli" && !audit) throw new Error("Missing supplementary check")
      const passed = row.passed + (audit ? Number(audit.supplementaryPassed) - Number(audit.rawCheckPassed) : 0)
      correctedPassed += passed
      correctedSuccess += Number(passed === row.total && row.completed && row.protocolFinished)
    }
    const total = (key: string) => rows.reduce((n: number, row: Record<string, number>) => n + row[key], 0)
    const observedAuxiliary = auxiliary.outcomes.filter((a: { id: string }) => rows.some((r: { id: string }) => r.id === a.id))
    statistics.push({ cohort, mode, sessions: rows.length, input: total("input"), output: total("output"),
      cachedInput: total("cachedInput"), calls: total("calls"), durationMs: total("durationMs"),
      inputPerTask: total("input") / 25, callsPerTask: total("calls") / 25,
      inputPerCall: total("input") / total("calls"), minutesPerTask: total("durationMs") / 25 / 60000,
      relativeInput: total("input") / baseline - 1, passed: total("passed"), checks: total("total"),
      artifactsPassing: rows.filter((r: { artifactPass: boolean }) => r.artifactPass).length,
      rawSuccess: rows.filter((r: { rawSuccess: boolean }) => r.rawSuccess).length, correctedPassed, correctedSuccess,
      timeouts: rows.filter((r: { timedOut: boolean }) => r.timedOut).length,
      auxiliaryInput: observedAuxiliary.reduce((n: number, r: { input: number }) => n + r.input, 0),
      auxiliaryCalls: observedAuxiliary.reduce((n: number, r: { calls: number }) => n + r.calls, 0),
    })
    for (let rep = 1; rep <= 5; rep++) {
      const sample = rows.filter((row: { repetition: number }) => row.repetition === rep)
      if (sample.length !== 5 || new Set(sample.map((r: { project: string }) => r.project)).size !== 5)
        throw new Error("Incomplete repeat")
      const sum = (key: string) => sample.reduce((n: number, row: Record<string, number>) => n + row[key], 0)
      repeats.push({ cohort, mode, repetition: rep, inputPerTask: sum("input") / 5, callsPerTask: sum("calls") / 5,
        minutesPerTask: sum("durationMs") / 300000, timeouts: sample.filter((r: { timedOut: boolean }) => r.timedOut).length })
    }
  }
}
await Bun.write(path.join(here, "statistics.json"), JSON.stringify({ statistics, repeats }, null, 2) + "\n")
for (const cohort of ["sol", "astra"]) {
  const group = statistics.filter(row => row.cohort === cohort)
  const run = data.runs.find((r: { cohort: string }) => r.cohort === cohort)
  const label = cohort === "sol" ? "Sol" : "Astra"
  const source = cohort === "sol" ? "codex-sol-clean-20260908" : "codex-astra-repeats-20260908"
  const table = [
    "| Режим | Input, млн | К Native | Обращения | Полный успех | Таймауты |",
    "|---|---:|---:|---:|---:|---:|",
    ...group.map(s => "| " + [names[s.mode], million(s.input), s.mode === "native" ? "—" : pct(s.relativeInput),
      s.calls, s.correctedSuccess + "/25", s.timeouts].join(" | ") + " |"),
  ].join("\n")
  let report = "# Codex / " + label + ": пять повторов без глобальных скиллов\n\n"
  report += "Завершено 100/100 сессий: пять повторов пяти задач в каждом из четырёх режимов. Модель " +
    run.model + ", reasoning medium, k=3 для V2/V3, лимит 15 минут, до пяти основных CLI одновременно.\n\n"
  report += "Начало: " + run.startedAt + "; окончание: " + run.endedAt + ". [Протокол](../" + source +
    "/PROTOCOL.md), [конечное состояние](../" + source + "/run.json).\n\n"
  report += table + "\n\n"
  report += "Полный успех: все спецификационно-корректные проверки, чистое завершение без таймаута и turn.completed (Native) либо принятый finish (state). Все исходы включены в токены, циклы и время. Таймаут — не успешное завершение, даже если написанный код проходит тесты.\n\n"
  report += "## Проверки и дополнительные счётчики\n\n"
  report += "| Режим | Исходные проверки | После CLI-аудита | Артефакты со всеми проверками | Cached input | Output | Время на задачу, мин | Вспомогательный input |\n|---|---:|---:|---:|---:|---:|---:|---:|\n"
  for (const s of group) report += "| " + [names[s.mode], s.passed + "/" + s.checks, s.correctedPassed + "/" + s.checks,
    s.artifactsPassing + "/25", number(s.cachedInput), number(s.output), s.minutesPerTask.toFixed(2).replace(".", ","),
    number(s.auxiliaryInput)].join(" | ") + " |\n"
  report += "\nДополнительная проверка удаления применена ко всем 20 CLI-проектам каждой модели на отдельных копиях. "
  report += "В новых сериях она не изменила ни одной исходной оценки: результаты двух проверок совпали для всех 40 проектов; 38 прошли, два не прошли. "
  report += "[Подробности](taskboard-delete-audit.json). Это не новые вызовы модели и не исправление проектов.\n\n"
  report += "Input основного агента уже включает cached input. Вспомогательный расход собран отдельно по parent_thread_id; "
  report += "он не включён в таблицу статьи. Это зарегистрированные ответы, а не биллинг; у прерванного запроса может не быть записи расхода. "
  report += "Время включает ожидания и ограничено таймаутом, а число циклов не равно числу действий.\n\n"
  report += "## Каждый повтор\n\n| Повтор | Режим | Input на задачу | Обращения на задачу | Минуты на задачу | Таймауты |\n|---|---|---:|---:|---:|---:|\n"
  for (const r of repeats.filter(row => row.cohort === cohort)) report += "| " + [r.repetition, names[r.mode],
    number(r.inputPerTask), r.callsPerTask.toFixed(2), r.minutesPerTask.toFixed(2), r.timeouts].join(" | ") + " |\n"
  report += "\n## Интерпретация и границы\n\n"
  report += cohort === "sol"
    ? "V2 сократила основной input на 31,0% относительно Native; полный успех — 24/25 против 25/25. V3 дороже V2 на 13,4% и сделала 309 обращений против 288. Paper — 17 таймаутов. Это отдельная серия, не средняя со старой Sol: в старой было десять повторов и другой глобальный контекст.\n\n"
    : "Native здесь явно лучше: все 25 сессий завершены с полным успехом, в среднем 5,44 обращения на задачу. V2/V3 сделали 25,56/21,92 обращения на задачу и израсходовали в 4,16/3,69 раза больше основного input. Paper не завершила ни одной сессии в срок, хотя 24 артефакта прошли исходный оценщик. [Диагностический аудит](../../journals/CODEX-ASTRA-NATIVE-EFFICIENCY-AUDIT-20260908.md) обсуждает перечитывание и обрезку наблюдений, но не устанавливает причинность.\n\n"
  if (cohort === "astra") report += "Astra выполнялась двумя отрезками: 35 исходов, затем 65 ранее не начатых сессий. Перерыв вызван защитой от появления скрытого выключенного кэша .system. Guard исправлен после проверки загрузчика; бинарник и модельные инструкции не менялись, исходы первого отрезка не перезапускались. [Поправка протокола](../codex-astra-repeats-20260908/RESUME-1.md).\n\n"
  report += "Для обеих серий перемещены и восстановлены 18 глобальных источников. Во всех 200 начальных контекстах нет проверяемых маркеров каталога скиллов и профиля. Это аудит записанных сообщений и файлов, не перехват provider-запросов и не изоляция ОС. Мы сравниваем конфигурации целиком: Native использует Code Mode, state — Direct tools; наблюдения state обрезаются. Длинные задачи для Astra не проверялись.\n\n"
  report += "## Данные\n\n[Персессионные результаты](data.json), [записи usage по обращениям](usage-records.json), "
  report += "[вспомогательные вызовы](auxiliary-usage.json), [аудит контекста](initial-context-audit.json), "
  report += "[сводки и точки графиков](statistics.json), [архивный manifest](archive-manifest.json), [происхождение](source-hashes.json). "
  report += "Проекты находятся в artifacts; поля archive в data.json указывают на соответствующие папки. "
  report += "Сырые промпты, рассуждения и вывод инструментов остаются локально в .private и в Git не копируются.\n"
  await Bun.write(path.join(here, "REPORT-" + cohort + ".md"), report)
}
console.log(JSON.stringify(statistics, null, 2))
