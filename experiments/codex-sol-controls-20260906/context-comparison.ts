import path from "node:path"
import { realpath } from "node:fs/promises"

const here = import.meta.dir, root = path.resolve(here, "../..")
const data = await Bun.file(path.join(here, "combined-data.json")).json()
const cells = []
for (const row of data.rows) {
  const summary = await Bun.file(path.join(root, row.source)).json()
  const locations = [...new Set([summary.workspace, await realpath(summary.workspace)])].sort((a, b) => b.length - a.length)
  const messages = []
  for (const line of (await Bun.file(path.join(root, path.dirname(row.source), "rollout.jsonl")).text()).split("\n")) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type !== "response_item") continue
    const item = event.payload
    if (item.type === "reasoning" || item.type === "function_call" || item.role === "assistant") break
    if (item.type !== "message" || item.role !== "user") continue
    const text = (item.content ?? []).map((part: { text?: string }) => part.text ?? "").join("\n")
    if (text.includes("<nda context deleted, size :")) throw new Error("Context is redacted; preserve the original context comparison instead of recomputing it.")
    if (!/<!--\s*[\w-]+-core:start/.test(text)) continue
    const normalized = locations.reduce((text, location) => text.replaceAll(location, "<CELL_WORKSPACE>"), text)
      .replace(/<current_date>[^<]*<\/current_date>/g, "<current_date>DATE</current_date>")
    messages.push({ bytes: Buffer.byteLength(normalized), sha256: new Bun.CryptoHasher("sha256").update(normalized).digest("hex") })
  }
  cells.push({ source: row.source, mode: row.mode, phase: row.phase, messages })
}
const groups = ["native", "paper", "v2", "v3"].map(mode => {
  const selected = cells.filter(cell => cell.mode === mode)
  return { mode, cells: selected.length, missingProfile: selected.filter(cell => !cell.messages.length).length,
    hashes: [...new Set(selected.flatMap(cell => cell.messages.map(message => message.sha256)))] }
})
const hashes = [...new Set(groups.flatMap(group => group.hashes))]
await Bun.write(path.join(here, "context-comparison.json"), JSON.stringify({ partial: data.missing > 0, groups, distinctNormalizedProfileHashes: hashes.length, cells,
  scope: "Initial host-profile user messages only, not system/tool schemas or provider wire captures. Replaces exact per-cell workspace and realpath strings and current_date tag. No prompt text exported. Distinct hashes require review; equality only covers this normalized subset." }, null, 2) + "\n")
console.log(JSON.stringify({ cells: cells.length, distinctNormalizedProfileHashes: hashes.length, groups }))
