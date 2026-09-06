import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const data = await Bun.file(path.join(import.meta.dir, "data.json")).json()
const issues = []
const missingTotals = []
let openCodeSteps = 0, comparedOpenCodeTotals = 0, codexUsageRecords = 0
for (const row of data.rows) {
  const file = path.join(root, path.dirname(row.source), row.runtime === "OpenCode" ? "events.jsonl" : "rollout.jsonl")
  const sums = { input: 0, output: 0 }
  for (const line of (await Bun.file(file).text()).split("\n")) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (row.runtime === "OpenCode" && event.type === "step_finish") {
      openCodeSteps++
      const t = event.part.tokens
      const input = t.input + t.cache.read + t.cache.write
      const output = t.output + t.reasoning
      sums.input += input
      sums.output += output
      if (typeof t.total === "number") {
        comparedOpenCodeTotals++
        if (input + output !== t.total) issues.push({ source: row.source, issue: "OpenCode components disagree with raw SDK total", input, output, total: t.total })
      } else missingTotals.push({ source: row.source, reason: event.part.reason, input, output })
    }
    if (row.runtime === "Codex" && event.type === "token_usage_record") {
      codexUsageRecords++
      sums.input += event.payload.usage.input_tokens
      sums.output += event.payload.usage.output_tokens
    }
  }
  if (sums.input !== row.input || sums.output !== row.output)
    issues.push({ source: row.source, issue: "Independent event sum disagrees with campaign row", sums, rowInput: row.input, rowOutput: row.output })
}
const result = { partial: data.missing > 0, openCodeSteps, comparedOpenCodeTotals, codexUsageRecords, missingTotals, issues,
  scope: "OpenCode step_finish events and Codex completed-response usage records are the recorded turn/sample counters. They are not a count of all HTTP attempts/retries or auxiliary calls. Missing SDK totals are listed, not invented." }
await Bun.write(path.join(import.meta.dir, "usage-audit.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
if (issues.length) process.exitCode = 1
