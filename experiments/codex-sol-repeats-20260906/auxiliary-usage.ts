// Campaign-local copy of ../article-20260904/auxiliary-usage.ts; outputs stay in this separate series.
import path from "node:path"
import { homedir } from "node:os"

// Only usage records of descendants of declared benchmark threads are retained.
// No auxiliary prompts, reasoning or unrelated session content is exported.
const root = path.resolve(import.meta.dir, "../..")
const data = await Bun.file(path.join(import.meta.dir, "data.json")).json()
const cells = []
const owners = new Map<string, string>()
const days = new Set<string>()
for (const row of data.rows.filter((r: any) => r.runtime === "Codex")) {
  const s = await Bun.file(path.join(root, row.source)).json()
  if (!s.metrics.threadID) throw new Error(`Missing main thread: ${row.source}`)
  owners.set(s.metrics.threadID, s.metrics.threadID)
  days.add(path.dirname(s.rolloutPath))
  cells.push({ source: row.source, threadID: s.metrics.threadID, mainInput: row.input, mainOutput: row.output })
}
async function firstLine(file: string) {
  const reader = Bun.file(file).stream().getReader()
  const decoder = new TextDecoder()
  let prefix = ""
  try {
    while (prefix.length < 1024 * 1024) {
      const { done, value } = await reader.read()
      if (done) break
      prefix += decoder.decode(value, { stream: true })
      const end = prefix.indexOf("\n")
      if (end >= 0) return prefix.slice(0, end)
    }
    return prefix
  } finally { await reader.cancel() }
}
const metadata = []
for (const day of days) {
  if (!day.startsWith(path.join(homedir(), ".codex", "sessions") + path.sep))
    throw new Error(`Unexpected session directory: ${day}`)
  for await (const file of new Bun.Glob("*.jsonl").scan({ cwd: day, absolute: true })) {
    let first
    try { first = JSON.parse(await firstLine(file)) } catch { continue }
    if (first.type !== "session_meta" || !first.payload?.parent_thread_id) continue
    metadata.push({ file, id: first.payload.id, parent: first.payload.parent_thread_id, source: first.payload.source })
  }
}
let grew = true
while (grew) {
  grew = false
  for (const m of metadata) if (!owners.has(m.id) && owners.has(m.parent)) {
    owners.set(m.id, owners.get(m.parent)!)
    grew = true
  }
}
const descendants = []
for (const m of metadata.filter((m) => owners.has(m.id))) {
  const records = []
  const models = new Set<string>()
  for (const line of (await Bun.file(m.file).text()).split("\n")) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === "turn_context" && typeof e.payload?.model === "string") models.add(e.payload.model)
    if (e.type === "token_usage_record") records.push(e.payload)
  }
  const latest = records.at(-1)?.thread_token_usage
  descendants.push({ threadID: m.id, parent: m.parent, root: owners.get(m.id), kind: m.source, models: [...models],
    callsWithUsage: records.length, usage: latest ?? null, records })
}
const outcomes = cells.map((cell) => {
  const children = descendants.filter((d) => d.root === cell.threadID)
  const sum = (key: string) => children.reduce((n, d) => n + (d.usage?.[key] ?? 0), 0)
  return { ...cell, auxiliaryThreads: children.length,
    auxiliaryInput: sum("input_tokens"), auxiliaryCachedInput: sum("cached_input_tokens"), auxiliaryOutput: sum("output_tokens"),
    observedCombinedInput: cell.mainInput + sum("input_tokens"), observedCombinedOutput: cell.mainOutput + sum("output_tokens") }
})
await Bun.write(path.join(import.meta.dir, "auxiliary-usage.json"), JSON.stringify({
  partial: data.missing > 0, scope: "Codex descendants linked by parent_thread_id; recorded completed-response usage only, not billed usage or an estimate of interrupted calls", outcomes, descendants,
}, null, 2) + "\n")
let report = `# Codex auxiliary usage\n\nStatus: ${data.missing ? "partial" : "complete"}. Main-loop counters are kept separate from linked descendants.\n\n`
report += "These are observed completed-response tokens, not billed costs. Descendants may use a different model; their model IDs and parent links are retained in [the underlying records](./auxiliary-usage.json). No prompts or reasoning are exported by this collector. Zero means no recorded descendant usage found, not a guarantee that an interrupted request was free.\n\n"
report += "| Model | Rep | Mode | Cells | Main input | Auxiliary input | Observed combined input | Auxiliary output |\n|---|---:|---|---:|---:|---:|---:|---:|\n"
const n = (value: number) => value.toLocaleString("en-US")
for (const group of data.groups.filter((g: any) => g.runtime === "Codex")) {
  const sources = new Set(data.rows.filter((r: any) => r.runtime === "Codex" && r.model === group.model && r.mode === group.mode && r.repetition === group.repetition).map((r: any) => r.source))
  const selected = outcomes.filter((o) => sources.has(o.source))
  const input = selected.reduce((s, o) => s + o.auxiliaryInput, 0)
  const output = selected.reduce((s, o) => s + o.auxiliaryOutput, 0)
  report += `| ${group.model} | ${group.repetition} | ${group.mode} | ${selected.length} | ${n(group.input)} | ${n(input)} | ${n(group.input + input)} | ${n(output)} |\n`
}
await Bun.write(path.join(import.meta.dir, "AUXILIARY-USAGE.md"), report)
console.log(JSON.stringify({ cells: outcomes.length, auxiliaryThreads: descendants.length,
  auxiliaryInput: outcomes.reduce((n, o) => n + o.auxiliaryInput, 0) }))
