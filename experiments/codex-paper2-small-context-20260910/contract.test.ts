import { expect, test } from "bun:test"
import path from "node:path"
import { schedule } from "./schedule"

test("50 unique Paper2 cells, five repeats per model and task", () => {
  const cells = schedule()
  expect(cells.length).toBe(50)
  expect(new Set(cells.map(c => `${c.model}/${c.repetition}/${c.project}`)).size).toBe(50)
  for (const model of ["gpt-5.6-sol", "gpt-6-astra"])
    for (const project of new Set(cells.map(c => c.project)))
      expect(cells.filter(c => c.model === model && c.project === project).length).toBe(5)
  expect(cells.every(c => c.mode === "paper2" && c.status === "pending" && c.source === null)).toBe(true)
})

test("runner and orchestration parse without running models", async () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  for (const file of ["run.ts", "runner.ts", "capture-build.ts", "launch.ts", "progress.ts"]) {
    const source = await Bun.file(path.join(import.meta.dir, file)).text()
    expect(() => transpiler.transformSync(source)).not.toThrow()
  }
})

test("runtime differs from large Paper2 only in four caps; runner only in workspace name", async () => {
  const previous = path.resolve(import.meta.dir, "../codex-paper2-20260910")
  const source = ".private/source/codex/codex-rs/core/src/"
  let expected = await Bun.file(path.join(previous, source, "skill_state.rs")).text()
  for (const [name, value] of [
    ["MAX_STATE_BYTES", "32 * 1024"], ["MAX_ACTION_REQUEST_BYTES", "64 * 1024"],
    ["MAX_OBSERVATION_INPUT_BYTES", "3 * 1024"], ["MAX_RESULT_BYTES", "4 * 1024"],
  ]) expected = expected.replace(`const ${name}: usize = 2 * 1024 * 1024;`, `const ${name}: usize = ${value};`)
  expect(await Bun.file(path.join(import.meta.dir, source, "skill_state.rs")).text()).toBe(expected)
  for (const name of ["skill_state_paper2.rs", "skill_state_history.rs", "tools/parallel.rs"])
    expect(await Bun.file(path.join(import.meta.dir, source, name)).text())
      .toBe(await Bun.file(path.join(previous, source, name)).text())
  expect(await Bun.file(path.join(import.meta.dir, "runner.ts")).text())
    .toBe((await Bun.file(path.join(previous, "runner.ts")).text()).replaceAll("codex-paper2-one-shot", "codex-paper2-small-one-shot"))
  expect(await Bun.file(path.join(import.meta.dir, "schedule.ts")).text())
    .toBe(await Bun.file(path.join(previous, "schedule.ts")).text())
})
