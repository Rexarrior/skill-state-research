import { expect, test } from "bun:test"
import path from "node:path"
import { schedule } from "./schedule"

test("100 fresh cells, five repeats of every project/mode, same admission order as Astra", async () => {
  const cells = schedule()
  const keys = cells.map(cell => `${cell.repetition}/${cell.project}/${cell.mode}`)
  expect(cells.length).toBe(100)
  expect(new Set(keys).size).toBe(100)
  for (const project of new Set(cells.map(cell => cell.project)))
    for (const mode of ["baseline", "paper", "v2", "v3"])
      expect(cells.filter(cell => cell.project === project && cell.mode === mode).length).toBe(5)
  expect(cells.every(cell => cell.status === "pending" && cell.source === null && cell.startedAt === null)).toBe(true)
  const astra = await Bun.file(path.join(import.meta.dir, "../codex-astra-repeats-20260908/run.json")).json()
  expect(keys).toEqual(astra.cells.map((cell: { repetition: number, project: string, mode: string }) =>
    `${cell.repetition}/${cell.project}/${cell.mode}`))
})

test("runner preserves the clean Sol contract except model, prefix, binary and header", async () => {
  const reference = await Bun.file(path.join(import.meta.dir, "../codex-sol-clean-20260908/runner.ts")).text()
  const current = await Bun.file(path.join(import.meta.dir, "runner.ts")).text()
  expect(current.split("\n").slice(2).join("\n")).toBe(reference
    .replaceAll("gpt-5.6-sol", "gpt-6-astra")
    .replaceAll("codex-sol-clean-one-shot", "codex-astra-large-context-one-shot")
    .replaceAll('path.join(repository, "codex/codex-rs/target/debug/codex")',
      'path.join(import.meta.dir, ".private/source/codex/codex-rs/target/debug/codex")')
    .split("\n").slice(2).join("\n"))
})

test("corrected isolation and draining helpers are unchanged from the completed Astra continuation", async () => {
  for (const name of ["isolation.ts", "isolation-guard.ts", "pool.ts"])
    expect(await Bun.file(path.join(import.meta.dir, name)).text()).toBe(
      await Bun.file(path.join(import.meta.dir, "../codex-astra-repeats-20260908", name)).text())
})
