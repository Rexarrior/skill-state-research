import path from "node:path"

const here = import.meta.dir, root = path.resolve(here, "../..")
const data = await Bun.file(path.join(here, "combined-data.json")).json()
const rows = []
for (const row of data.rows.filter((row: { mode: string }) => row.mode !== "native")) {
  let results = 0, clipped = 0, steps = 0, clippedSteps = 0, skipped = 0
  for (const line of (await Bun.file(path.join(root, path.dirname(row.source), "rollout.jsonl")).text()).split("\n")) {
    let event, observation
    try {
      event = JSON.parse(line)
      if (event.type !== "response_item" || event.payload?.type !== "function_call_output" || event.payload?.name !== "skill_step") continue
      observation = JSON.parse(event.payload.output).observation
    } catch { continue }
    if (!observation) continue
    steps++
    const before = clipped
    for (const action of observation.actions ?? [observation]) {
      if (action.status === "skipped") { skipped++; continue }
      if (typeof action.result !== "string") continue
      results++
      if (action.result.endsWith("\n…[truncated by SKILL.state]")) clipped++
    }
    if (clipped > before) clippedSteps++
  }
  rows.push({ source: row.source, mode: row.mode, repetition: row.repetition, project: row.project, results, clipped, steps, clippedSteps, skipped })
}
const groups = ["paper", "v2", "v3"].map(mode => {
  const cells = rows.filter(row => row.mode === mode)
  return { mode, cells: cells.length, results: cells.reduce((n, row) => n + row.results, 0), clipped: cells.reduce((n, row) => n + row.clipped, 0),
    steps: cells.reduce((n, row) => n + row.steps, 0), clippedSteps: cells.reduce((n, row) => n + row.clippedSteps, 0) }
})
await Bun.write(path.join(here, "truncation-audit.json"), JSON.stringify({ partial: data.missing > 0, groups, rows,
  method: "Post-hoc exact SKILL.state suffix marker count in recorded results, excluding skipped actions, including finish/errors. Counts generated observations, not repeated exposures in provider requests. Native/Code Mode truncation is not covered. No result text exported and no causal attribution." }, null, 2) + "\n")
console.log(JSON.stringify({ partial: data.missing > 0, groups }))
