// Campaign-local copy; this file does not modify the article dataset.
import path from "node:path"

// Fingerprint initial context without re-exporting personal instructions or host paths.
const root = path.resolve(import.meta.dir, "../..")
const data = await Bun.file(path.join(import.meta.dir, "data.json")).json()
const cells = []
for (const row of data.rows.filter((r: any) => r.runtime === "Codex")) {
  const file = path.join(root, path.dirname(row.source), "rollout.jsonl")
  const messages = []
  for (const line of (await Bun.file(file).text()).split("\n")) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type !== "response_item") continue
    const item = event.payload
    if (item.type === "reasoning" || item.type === "function_call" || item.role === "assistant") break
    if (item.type !== "message" || !["user", "developer", "system"].includes(item.role)) continue
    const text = (item.content ?? []).map((c: any) => c.text ?? "").join("\n")
    if (text.includes("<nda context deleted, size :")) throw new Error("Context is redacted; preserve the original context audit instead of recomputing it.")
    messages.push({ role: item.role, bytes: Buffer.byteLength(text),
      sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
      hostProfile: /<!--\s*[\w-]+-core:start/.test(text), pluginRecommendations: text.includes("<recommended_plugins>"),
      taskSpecification: text.includes("<specification>"),
    })
  }
  cells.push({ source: row.source, model: row.model, mode: row.mode, repetition: row.repetition,
    hostProfilePresent: messages.some((m) => m.hostProfile), messages })
}
const result = { partial: data.missing > 0, cells,
  hostProfileCells: cells.filter((c) => c.hostProfilePresent).length,
  scope: "Initial messages in local Codex rollouts, not production packet captures. Hashes include per-cell environment text, so differing hashes do not isolate a changed instruction. No personal instruction text is re-exported here.",
}
await Bun.write(path.join(import.meta.dir, "host-context-audit.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify({ partial: result.partial, cells: cells.length, hostProfileCells: result.hostProfileCells }))
