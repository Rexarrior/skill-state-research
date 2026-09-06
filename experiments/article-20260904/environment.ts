import path from "node:path"
import os from "node:os"

// Whitelisted version probes only: never enumerate environment variables or provider credentials.
const commands = {
  bun: ["bun", "--version"], node: ["node", "--version"], python: ["python3", "--version"],
  rustc: ["rustc", "--version"], cargo: ["cargo", "--version"], macOS: ["sw_vers", "-productVersion"],
}
const versions: Record<string, unknown> = {}
for (const [name, argv] of Object.entries(commands)) {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
    const [out, err, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    versions[name] = { version: (out || err).trim().slice(0, 500), exitCode }
  } catch { versions[name] = { unavailable: true } }
}
await Bun.write(path.join(import.meta.dir, "environment.json"), JSON.stringify({
  capturedAt: new Date().toISOString(), platform: os.platform(), arch: os.arch(), versions,
  note: "Host version probes during the campaign; not a container lockfile. Backend aliases and network latency are not pinned by these versions.",
}, null, 2) + "\n")
console.log(JSON.stringify(versions, null, 2))
