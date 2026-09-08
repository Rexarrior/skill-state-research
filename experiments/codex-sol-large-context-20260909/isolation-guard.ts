import path from "node:path"
import { homedir } from "node:os"
import { lstat, readdir } from "node:fs/promises"
import { discover, exists } from "./isolation"

// This exception is valid only for the frozen runner's bundled.enabled=false setting.
// Its host loader skips hidden descendants and its host service removes System roots.
// It does NOT allow an active skill, a visible symlink to .system, or another hidden directory.
export async function checkReappearedSources(sources: string[], disabledSystemCacheParent: string) {
  let ignoredDisabledSystemCaches = 0
  for (const source of sources) {
    if (source !== disabledSystemCacheParent) throw new Error("An active global skill/instruction source has reappeared")
    const info = await lstat(source)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Recreated skills root is not a plain directory")
    const entries = await readdir(source, { withFileTypes: true })
    if (entries.some(entry => entry.name !== ".system" || !entry.isDirectory() || entry.isSymbolicLink()))
      throw new Error("Recreated skills root contains more than the disabled .system cache")
    ignoredDisabledSystemCaches++
  }
  return { ignoredDisabledSystemCaches }
}

export async function assertSkillIsolation(ledger: { entries: { original: string }[] }) {
  const sources = new Set(await discover(true))
  // Include an original root even if another process replaced it with a symlink or regular file.
  for (const entry of ledger.entries) if (await exists(entry.original)) sources.add(entry.original)
  return checkReappearedSources([...sources], path.join(homedir(), ".codex/skills"))
}
