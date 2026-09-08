import path from "node:path"
import { homedir } from "node:os"
import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, rename } from "node:fs/promises"

type Entry = { original: string, saved: string, fingerprint: string, status: "planned" | "moved" | "restored", recreated?: string }
type Ledger = { version: 1, directory: string, createdAt: string, restoredAt?: string, entries: Entry[] }

export async function exists(file: string) {
  try { await lstat(file); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}

// Hash symlinks themselves, never traverse their targets or export skill contents.
export async function fingerprint(file: string): Promise<string> {
  const info = await lstat(file)
  const digest = new Bun.CryptoHasher("sha256")
  digest.update(String(info.mode) + "\0")
  if (info.isSymbolicLink()) digest.update("link\0" + await readlink(file))
  else if (info.isDirectory()) {
    for (const name of (await readdir(file)).sort())
      digest.update(name + "\0" + await fingerprint(path.join(file, name)) + "\0")
  } else if (info.isFile()) digest.update(new Uint8Array(await Bun.file(file).arrayBuffer()))
  else throw new Error("Unsupported entry in skill tree")
  return digest.digest("hex")
}

export async function discover(includeInstructions: boolean) {
  const home = homedir()
  const codex = path.join(home, ".codex")
  const targets = [path.join(codex, "skills"), path.join(home, ".agents/skills")]
  async function plugins(directory: string) {
    if (!await exists(directory)) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(directory, entry.name)
      if (entry.name === "skills") targets.push(file)
      else await plugins(file)
    }
  }
  await plugins(path.join(codex, "plugins/cache"))
  // Do not alter administrator-managed sources silently.
  if (await exists("/etc/codex/skills")) throw new Error("Administrator skills require separate review")
  if (includeInstructions) targets.push(path.join(codex, "AGENTS.md"), path.join(codex, "AGENTS.override.md"))
  const present = []
  for (const target of targets) if (await exists(target)) present.push(target)
  return present.sort()
}

async function save(ledger: Ledger) {
  const file = path.join(ledger.directory, "ledger.json")
  const temporary = path.join(ledger.directory, "ledger.next.json")
  await Bun.write(temporary, JSON.stringify(ledger, null, 2) + "\n")
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}

export async function suspend(targets: string[], backupParent: string) {
  if (!targets.length || new Set(targets).size !== targets.length) throw new Error("Empty or duplicated isolation targets")
  const resolved = targets.map(file => path.resolve(file))
  if (resolved.some((a, i) => resolved.some((b, j) => i !== j && a.startsWith(b + path.sep))))
    throw new Error("Nested isolation targets")
  for (const file of resolved) if (file === homedir() || file === "/" || path.basename(file) === ".codex")
    throw new Error("Refusing a broad isolation target")
  await mkdir(backupParent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(path.join(backupParent, "skill-state-hold-"))
  await chmod(directory, 0o700)
  const ledger: Ledger = { version: 1, directory, createdAt: new Date().toISOString(), entries: [] }
  for (const [index, original] of resolved.entries()) ledger.entries.push({ original,
    saved: path.join(directory, "saved-" + index), fingerprint: await fingerprint(original), status: "planned" })
  await save(ledger)
  try {
    for (const entry of ledger.entries) {
      // The write-ahead ledger also permits recovery between rename and the next save.
      await rename(entry.original, entry.saved)
      entry.status = "moved"
      await save(ledger)
    }
    return ledger
  } catch (error) {
    await restore(path.join(directory, "ledger.json"))
    throw error
  }
}

export async function assertSuspended(ledger: Ledger) {
  for (const entry of ledger.entries) if (await exists(entry.original))
    throw new Error("A suspended global source has reappeared; dispatch stopped")
}

export async function restore(file: string) {
  const ledger: Ledger = await Bun.file(file).json()
  if (ledger.version !== 1 || path.resolve(file) !== path.join(ledger.directory, "ledger.json"))
    throw new Error("Invalid restoration ledger")
  for (const entry of ledger.entries.toReversed()) {
    if (path.dirname(entry.saved) !== ledger.directory) throw new Error("Invalid backup path")
    if (!await exists(entry.saved)) {
      if (!await exists(entry.original) || await fingerprint(entry.original) !== entry.fingerprint)
        throw new Error("Neither verified backup nor verified original is available")
      entry.status = "restored"
      await save(ledger)
      continue
    }
    if (await fingerprint(entry.saved) !== entry.fingerprint) throw new Error("Backup fingerprint changed")
    if (await exists(entry.original)) {
      // Preserve directories recreated by another application; never overwrite or delete them.
      const recreated = path.join(ledger.directory, "recreated-" + crypto.randomUUID())
      await rename(entry.original, recreated)
      entry.recreated = recreated
      await save(ledger)
    }
    await rename(entry.saved, entry.original)
    if (await fingerprint(entry.original) !== entry.fingerprint) throw new Error("Restoration fingerprint mismatch")
    entry.status = "restored"
    await save(ledger)
  }
  ledger.restoredAt = new Date().toISOString()
  await save(ledger)
  return { restored: ledger.entries.length, preservedRecreated: ledger.entries.filter(entry => entry.recreated).length }
}

if (import.meta.main) {
  const [command, file] = process.argv.slice(2)
  if (command === "inspect") console.log(JSON.stringify({ targets: await discover(false) }, null, 2))
  else if (command === "restore" && file) console.log(JSON.stringify(await restore(path.resolve(file))))
  else throw new Error("Usage: bun isolation.ts inspect | restore ABSOLUTE_LEDGER_PATH")
}
