import path from "node:path"

// Numeric post-run audit only; no raw prompts, reasoning or tool output exported.
const here = import.meta.dir
const data = await Bun.file(path.join(here, "data.json")).json()
const rows = []
for (const row of data.rows) {
  const file = path.join(here, path.dirname(row.source), "rollout.jsonl")
  const raw = await Bun.file(file).text()
  const items = raw.trim().split("\n").map(line => JSON.parse(line))
  const calls = items.filter(item => item.type === "response_item" && item.payload.type === "function_call" && item.payload.name === "skill_step")
  const actions = calls.map(item => JSON.parse(item.payload.arguments).action)
  const outputs = items.filter(item => item.type === "response_item" && item.payload.type === "function_call_output" && item.payload.name === "skill_step")
  const transitions = outputs.map(item => JSON.parse(item.payload.output))
  if (transitions.some(item => item.protocol !== "skill.state/paper2")) throw new Error("Unexpected protocol")
  rows.push({ id: row.id, cohort: row.cohort, calls: calls.length,
    finishAttempts: actions.filter(action => action.name === "finish").length,
    acceptedFinish: row.acceptedFinish,
    statuses: transitions.reduce((counts: Record<string, number>, item) => {
      const key = item.observation?.status ?? "absent"
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
    inputPreviews: row.budget.inputPreviews, resultTruncations: row.budget.skillResultTruncations,
    maxStateBytes: row.budget.maxStateBytes,
    source: path.relative(here, file), sha256: new Bun.CryptoHasher("sha256").update(raw).digest("hex") })
}
const totals = ["sol", "astra"].map(cohort => {
  const sample = rows.filter(row => row.cohort === cohort)
  return { cohort, sessions: sample.length,
    finishAttempts: sample.reduce((n, row) => n + row.finishAttempts, 0),
    sessionsAttemptingFinish: sample.filter(row => row.finishAttempts > 0).length,
    acceptedFinishes: sample.filter(row => row.acceptedFinish).length,
    inputPreviews: sample.reduce((n, row) => n + row.inputPreviews, 0),
    resultTruncations: sample.reduce((n, row) => n + row.resultTruncations, 0),
    maxStateBytes: Math.max(...sample.map(row => row.maxStateBytes)),
    statuses: sample.reduce((counts: Record<string, number>, row) => {
      for (const [key, value] of Object.entries(row.statuses)) counts[key] = (counts[key] ?? 0) + Number(value)
      return counts
    }, {}) }
})
await Bun.write(path.join(here, "trajectory-audit.json"), JSON.stringify({ rows, totals,
  scope: "All 50 persisted main rollouts. Counts of submitted finish actions and stored transition statuses; not provider packet capture or causal attribution." }, null, 2) + "\n")
console.log(JSON.stringify(totals, null, 2))
