import path from "node:path"

const data = await Bun.file(path.join(import.meta.dir, "data.json")).json()
if (data.missing) throw new Error("Publication tables require the complete campaign")
const modes = ["native", "paper", "v2", "v3"]
const combinations = [["OpenCode", "sol"], ["OpenCode", "terra"], ["Codex", "sol"], ["Codex", "terra"]]
const million = (n: number) => (n / 1_000_000).toFixed(3).replace(".", ",")
const mark = (g: any) => g.completed < 5 || (g.mode !== "native" && g.finished < 5) ? "†" : ""
const percent = (ratio: number) => `${ratio >= 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(1).replace(".", ",")}%`
const get = (runtime: string, model: string, mode: string, repetition = 0) => {
  const g = data.groups.find((g: any) => g.runtime === runtime && g.model === model && g.mode === mode && g.repetition === repetition)
  if (!g || g.cells !== 5 || g.checks !== 40) throw new Error(`Incomplete group: ${runtime}/${model}/${mode}/${repetition}`)
  return g
}
let output = "В каждой ячейке: **пройденные проверки / 40; полный input в миллионах токенов**. Один запуск каждого проекта.\n\n"
output += "| Runtime / модель | Native | Paper | V2 | V3 |\n|---|---:|---:|---:|---:|\n"
const comparisons = []
for (const [runtime, model] of combinations) {
  const groups = modes.map((mode) => get(runtime, model, mode))
  output += `| ${runtime} / ${model === "sol" ? "Sol" : "Terra"} | ${groups.map((g) => `${g.passed}/40${mark(g)}; ${million(g.input)}`).join(" | ")} |\n`
  comparisons.push({ runtime, model, modes: groups.map((g) => ({
    mode: g.mode, checks: g.passed, input: g.input, vsNative: g.input / groups[0].input - 1,
    calls: g.calls, averageInputPerCall: g.input / g.calls,
    cleanRuns: g.completed, finished: g.finished,
  })), v3vsV2: groups[3].input / groups[2].input - 1 })
}
output += "\n† Есть таймаут, аварийное или непротокольное завершение: балл проверок оценивает только получившийся код.\n"
output += "\n### Повторы Codex\n\nПолный вход по всем пяти задачам в каждом повторе, млн токенов. В скобках — проверки / 40. Обращения — число зарегистрированных ответов основной модели, не отдельных действий внутри батчей.\n\n"
output += "| Модель | Попытка | V2: input | V2: обращения | V3: input | V3: обращения | V3 к V2: input |\n|---|---:|---:|---:|---:|---:|---:|\n"
const repetitions = []
for (const model of ["sol", "terra"]) {
  const attempts = [0, 1, 2].map((rep) => {
    const v2 = get("Codex", model, "v2", rep), v3 = get("Codex", model, "v3", rep)
    const ratio = v3.input / v2.input - 1
    output += `| ${model === "sol" ? "Sol" : "Terra"} | ${rep + 1} | ${million(v2.input)} (${v2.passed}/40${mark(v2)}) | ${v2.calls} | ${million(v3.input)} (${v3.passed}/40${mark(v3)}) | ${v3.calls} | ${percent(ratio)} |\n`
    return { repetition: rep, v2, v3, ratio }
  })
  repetitions.push({ model, attempts,
    aggregateInputRatio: attempts.reduce((s, a) => s + a.v3.input, 0) / attempts.reduce((s, a) => s + a.v2.input, 0) - 1,
    v3LowerInputAttempts: attempts.filter((a) => a.ratio < 0).length,
    v2Checks: attempts.reduce((s, a) => s + a.v2.passed, 0),
    v3Checks: attempts.reduce((s, a) => s + a.v3.passed, 0),
  })
}
output += "\nЭто три попытки на тех же пяти задачах, не 15 новых задач. У Native, Paper и всех OpenCode-ячеек остаётся одна попытка.\n"
const auxiliary = await Bun.file(path.join(import.meta.dir, "auxiliary-usage.json")).json()
if (auxiliary.partial) throw new Error("Auxiliary accounting is incomplete")
const auxiliaryBySource = new Map(auxiliary.outcomes.map((o: any) => [o.source, o]))
const auxiliaryRepetitions = ["sol", "terra"].map((model) => {
  const measure = (mode: string) => {
    const cells = data.rows.filter((r: any) => r.runtime === "Codex" && r.model === model && r.mode === mode)
    if (cells.length !== 15) throw new Error("Expected three complete repetitions")
    return cells.reduce((s: any, r: any) => {
      const a: any = auxiliaryBySource.get(r.source)
      if (!a) throw new Error(`Missing auxiliary record: ${r.source}`)
      return { cells: s.cells + 1, mainInput: s.mainInput + r.input,
        auxiliaryInput: s.auxiliaryInput + a.auxiliaryInput,
        observedCombinedInput: s.observedCombinedInput + a.observedCombinedInput }
    }, { cells: 0, mainInput: 0, auxiliaryInput: 0, observedCombinedInput: 0 })
  }
  const v2 = measure("v2"), v3 = measure("v3")
  return { model, v2, v3, combinedInputRatio: v3.observedCombinedInput / v2.observedCombinedInput - 1,
    scope: "Observed input summed across main and auxiliary models; not a monetary cost comparison." }
})
await Bun.write(path.join(import.meta.dir, "publication-tables.md"), output)
await Bun.write(path.join(import.meta.dir, "comparisons.json"), JSON.stringify({ comparisons, repetitions, auxiliaryRepetitions }, null, 2) + "\n")
console.log(output)
