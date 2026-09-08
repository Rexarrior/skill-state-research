import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, mkdtemp, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { checkReappearedSources } from "./isolation-guard"

test("absent roots and only a disabled hidden system cache are accepted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "astra-guard-test-"))
  const root = path.join(directory, "skills")
  expect(await checkReappearedSources([], root)).toEqual({ ignoredDisabledSystemCaches: 0 })
  await mkdir(root)
  expect(await checkReappearedSources([root], root)).toEqual({ ignoredDisabledSystemCaches: 1 })
  await mkdir(path.join(root, ".system/builtin"), { recursive: true })
  await Bun.write(path.join(root, ".system/builtin/SKILL.md"), "Fixture not discoverable with bundled skills disabled\n")
  expect(await checkReappearedSources([root], root)).toEqual({ ignoredDisabledSystemCaches: 1 })
})

test("visible skills, hidden extras, instructions and newly installed plugin roots stop dispatch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "astra-guard-test-"))
  for (const name of ["visible", ".other", "SKILL.md"]) {
    const root = path.join(directory, name + "-root")
    await mkdir(root)
    await Bun.write(path.join(root, name), "Fixture\n")
    await expect(checkReappearedSources([root], root)).rejects.toThrow("more than")
  }
  for (const name of ["AGENTS.md", "AGENTS.override.md", "new-plugin/skills"])
    await expect(checkReappearedSources([path.join(directory, name)], path.join(directory, "skills"))).rejects.toThrow("active global")
})

test("symlink roots and symlinked system caches are not accepted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "astra-guard-test-"))
  const target = path.join(directory, "target")
  await mkdir(target)
  const root = path.join(directory, "skills")
  await symlink(target, root)
  await expect(checkReappearedSources([root], root)).rejects.toThrow("plain directory")
  const other = path.join(directory, "other")
  await mkdir(other)
  await symlink(target, path.join(other, ".system"))
  await expect(checkReappearedSources([other], other)).rejects.toThrow("more than")
})
