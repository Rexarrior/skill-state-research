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
