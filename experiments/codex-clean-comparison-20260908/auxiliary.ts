import path from "node:path"
import { homedir } from "node:os"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const data = await Bun.file(path.join(here, "data.json")).json()
const output = path.join(here, "auxiliary-usage.json")
if (await Bun.file(output).exists()) throw new Error("Auxiliary snapshot already captured")
const owners = new Map<string, string>(data.rows.map((row: { threadID: string }) => [row.threadID, row.threadID]))
const days = new Set<string>()
for (const row of data.rows) {
  const summary = await Bun.file(path.join(root, row.source)).json()
  const directory = path.dirname(summary.rolloutPath)
  if (!directory.startsWith(path.join(homedir(), ".codex/sessions") + path.sep)) throw new Error("Unexpected session directory")
  days.add(directory)
}
const metadata: { file: string, id: string, parent: string }[] = []
for (const directory of days) {
  for await (const file of new Bun.Glob("*.jsonl").scan({ cwd: directory, absolute: true })) {
    const reader = Bun.file(file).stream().getReader()
    const decoder = new TextDecoder()
    let prefix = ""
    try {
      while (!prefix.includes("\n") && prefix.length < 1024 * 1024) {
        const chunk = await reader.read()
        if (chunk.done) break
        prefix += decoder.decode(chunk.value, { stream: true })
      }
    } finally { await reader.cancel() }
    let first
    try { first = JSON.parse(prefix.split("\n")[0]!) } catch { continue }
    if (first.type === "session_meta" && first.payload?.parent_thread_id)
      metadata.push({ file, id: first.payload.id, parent: first.payload.parent_thread_id })
  }
}
let changed = true
while (changed) {
  changed = false
  for (const row of metadata) if (!owners.has(row.id) && owners.has(row.parent)) {
    owners.set(row.id, owners.get(row.parent)!)
    changed = true
  }
}
const descendants = []
for (const child of metadata.filter(row => owners.has(row.id))) {
  const usage = []
  const models = new Set<string>()
  for (const line of (await Bun.file(child.file).text()).split("\n").filter(Boolean)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === "turn_context" && event.payload?.model) models.add(event.payload.model)
    if (event.type !== "token_usage_record") continue
    const u = event.payload.usage
    usage.push({ input: u.input_tokens, cachedInput: u.cached_input_tokens ?? 0, output: u.output_tokens })
  }
  descendants.push({ threadID: child.id, parent: child.parent, root: owners.get(child.id), models: [...models], usage })
}
const outcomes = data.rows.map((row: { id: string, threadID: string }) => {
  const children = descendants.filter(child => child.root === row.threadID)
  const usage = children.flatMap(child => child.usage)
  return { id: row.id, auxiliaryThreads: children.length, calls: usage.length,
    input: usage.reduce((sum, u) => sum + u.input, 0), cachedInput: usage.reduce((sum, u) => sum + u.cachedInput, 0),
    output: usage.reduce((sum, u) => sum + u.output, 0) }
})
await Bun.write(output, JSON.stringify({ capturedAt: new Date().toISOString(), outcomes, descendants,
  scope: "Recorded usage of descendants linked by parent_thread_id, no prompts or reasoning exported. Not billed cost; interrupted calls may have no usage record." }, null, 2) + "\n")
console.log(JSON.stringify({ mainSessions: outcomes.length, descendants: descendants.length }))
