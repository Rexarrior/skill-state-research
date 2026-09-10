import path from "node:path"
import { openSync, closeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { spawn } from "node:child_process"

const here = import.meta.dir
if (await Bun.file(path.join(here, "launch.json")).exists() || await Bun.file(path.join(here, "run.json")).exists())
  throw new Error("Campaign already launched; inspect existing state instead")
const directory = path.join(here, ".private")
await mkdir(directory, { recursive: true, mode: 0o700 })
const output = openSync(path.join(directory, "runner.stdout.log"), "wx", 0o600)
const errors = openSync(path.join(directory, "runner.stderr.log"), "wx", 0o600)
const child = spawn(process.execPath, [path.join(here, "run.ts"), "--with-global-instructions"], {
  cwd: path.resolve(here, "../.."), detached: true, stdio: ["ignore", output, errors],
})
closeSync(output)
closeSync(errors)
await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
await Bun.write(path.join(here, "launch.json"), JSON.stringify({ launchedAt: new Date().toISOString(), pid: child.pid,
  plannedCells: 50, maxWorkers: 5, mode: "paper2" }, null, 2) + "\n")
child.unref()
console.log(JSON.stringify({ pid: child.pid, plannedCells: 50, maxWorkers: 5 }))
