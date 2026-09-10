import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rmdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fingerprint, restore, suspend } from "./isolation-resume"
import { finalizeRecovery, resumeCells } from "./resume-state"
import { schedule } from "./schedule"
import { checkReappearedSources } from "../codex-sol-large-context-20260909/isolation-guard"

test("deleted version parents are recreated without touching a newer version", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paper2-restore-"))
  const old = path.join(directory, "plugin/old/skills")
  const fresh = path.join(directory, "plugin/new/skills")
  await mkdir(old, { recursive: true })
  await Bun.write(path.join(old, "SKILL.md"), "old skill")
  const expected = await fingerprint(old)
  const ledger = await suspend([old], path.join(directory, "backup"))
  await rmdir(path.dirname(old))
  await mkdir(fresh, { recursive: true })
  await Bun.write(path.join(fresh, "SKILL.md"), "new skill")
  const result = await restore(path.join(ledger.directory, "ledger.json"))
  expect(result).toEqual({ restored: 1, preservedRecreated: 0, failures: [] })
  expect(await fingerprint(old)).toBe(expected)
  expect(await Bun.file(path.join(fresh, "SKILL.md")).text()).toBe("new skill")
  expect((await restore(path.join(ledger.directory, "ledger.json"))).failures).toEqual([])
})

test("one failed restoration does not block other roots or overwrite recreated data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paper2-restore-"))
  const good = path.join(directory, "good"), bad = path.join(directory, "bad")
  await Bun.write(good, "good")
  await Bun.write(bad, "original")
  const ledger = await suspend([good, bad], path.join(directory, "backup"))
  await Bun.write(ledger.entries[1]!.saved, "damaged")
  await Bun.write(bad, "recreated")
  const result = await restore(path.join(ledger.directory, "ledger.json"))
  expect(result.restored).toBe(1)
  expect(result.failures.length).toBe(1)
  expect(await Bun.file(good).text()).toBe("good")
  expect(await Bun.file(bad).text()).toBe("recreated")
  await Bun.write(ledger.entries[1]!.saved, "original")
  const retried = await restore(path.join(ledger.directory, "ledger.json"))
  expect(retried).toEqual({ restored: 2, preservedRecreated: 1, failures: [] })
})

test("restore exception cannot leave the last checkpoint running", async () => {
  const state = { status: "interrupted", isolation: "suspended", stopReason: "guard failure" }
  const snapshots: typeof state[] = []
  await finalizeRecovery(state, async () => { snapshots.push({ ...state }) }, async () => { throw new Error("disk error") })
  expect(snapshots.map(s => [s.status, s.isolation])).toEqual([
    ["interrupted", "restoring"], ["needs-attention", "restore-failed"],
  ])
  expect(state.stopReason).toContain("disk error")
})

test("completed outcomes including failures are carried; only external interruptions get attempt 2", () => {
  const prior = schedule()
  for (const cell of prior.slice(0, 4)) { cell.status = "complete"; cell.source = "original-summary.json" }
  for (const cell of prior.slice(4, 9)) cell.status = "interrupted"
  const copy = JSON.stringify(prior)
  const cells = resumeCells({ status: "interrupted", isolation: "restored", cells: prior })
  expect(cells.filter(c => c.carried).length).toBe(4)
  expect(cells.filter(c => c.attempt === 2 && c.previousAttempt?.status === "interrupted").length).toBe(5)
  expect(cells.filter(c => !c.carried).length).toBe(46)
  expect(JSON.stringify(prior)).toBe(copy)
  expect(() => resumeCells({ status: "running", isolation: "restored", cells: prior })).toThrow()
})

test("a checkpoint write failure still attempts source restoration", async () => {
  const state = { status: "interrupted", isolation: "suspended", stopReason: null as string | null }
  let saves = 0
  let restored = false
  await finalizeRecovery(state, async () => { if (++saves === 1) throw new Error("write error") },
    async () => { restored = true; return { failures: [] } })
  expect(restored).toBe(true)
  expect(state.isolation).toBe("restored")
  expect(saves).toBe(2)
})

test("new plugin sources are not silently allowed after an update", async () => {
  await expect(checkReappearedSources(["/some/plugin/new/skills"], "/disabled/skills")).rejects.toThrow("active global")
})

test("continuation scripts parse and checkpoint targets do not overwrite segment one", async () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  for (const file of ["resume.ts", "resume-state.ts", "isolation-resume.ts", "launch-resume-1.ts"]) {
    const source = await Bun.file(path.join(import.meta.dir, file)).text()
    expect(() => transpiler.transformSync(source)).not.toThrow()
  }
  const source = await Bun.file(path.join(import.meta.dir, "resume.ts")).text()
  expect(source).toContain('await rename(next, path.join(here, "run-resume-1.json"))')
  expect(source).not.toContain('await rename(next, path.join(here, "run.json"))')
})
