import { test, expect } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, symlink, readlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { assertSuspended, exists, fingerprint, restore, suspend } from "./isolation"

test("round-trip preserves bytes and symlinks; recreated source is kept separately", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "astra-isolation-test-"))
  const skills = path.join(root, "skills")
  await mkdir(skills)
  await Bun.write(path.join(skills, "SKILL.md"), "Test skill\n")
  await symlink("SKILL.md", path.join(skills, "linked"))
  const before = await fingerprint(skills)
  const ledger = await suspend([skills], path.join(root, "backup"))
  await assertSuspended(ledger)
  expect(await exists(skills)).toBe(false)
  await mkdir(skills)
  await Bun.write(path.join(skills, "recreated.txt"), "Another application's new data\n")
  await expect(assertSuspended(ledger)).rejects.toThrow("reappeared")
  expect(await restore(path.join(ledger.directory, "ledger.json"))).toEqual({ restored: 1, preservedRecreated: 1 })
  expect(await fingerprint(skills)).toBe(before)
  expect(await readlink(path.join(skills, "linked"))).toBe("SKILL.md")
  const recovered = await Bun.file(path.join(ledger.directory, "ledger.json")).json()
  expect(await Bun.file(path.join(recovered.entries[0].recreated, "recreated.txt")).text()).toContain("new data")
  expect((await restore(path.join(ledger.directory, "ledger.json"))).restored).toBe(1)
})

test("write-ahead recovery works if interrupted after move before status save", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "astra-isolation-test-"))
  const file = path.join(root, "AGENTS.md")
  await Bun.write(file, "Fixture instruction\n")
  const ledger = await suspend([file], path.join(root, "backup"))
  ledger.entries[0].status = "planned"
  await Bun.write(path.join(ledger.directory, "ledger.json"), JSON.stringify(ledger))
  await restore(path.join(ledger.directory, "ledger.json"))
  expect(await Bun.file(file).text()).toBe("Fixture instruction\n")
})

test("changed backup is rejected without overwriting a recreated original", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "astra-isolation-test-"))
  const file = path.join(root, "AGENTS.md")
  await Bun.write(file, "Original\n")
  const ledger = await suspend([file], path.join(root, "backup"))
  await Bun.write(ledger.entries[0].saved, "Changed backup\n")
  await Bun.write(file, "New original\n")
  await expect(restore(path.join(ledger.directory, "ledger.json"))).rejects.toThrow("fingerprint changed")
  expect(await Bun.file(file).text()).toBe("New original\n")
  expect(await Bun.file(ledger.entries[0].saved).text()).toBe("Changed backup\n")
})

test("broad and overlapping isolation targets are rejected before moving", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "astra-isolation-test-"))
  await expect(suspend(["/"], root)).rejects.toThrow("broad")
  await expect(suspend([path.join(root, "skills"), path.join(root, "skills/nested")], root)).rejects.toThrow("Nested")
})
