import path from "node:path"

const here = import.meta.dir, root = path.resolve(here, "../..")
const data = await Bun.file(path.join(here, "data.json")).json()
const rows: any[] = []
for (const row of data.rows) {
  const counts: Record<string, number> = {}
  let errors = 0, skipped = 0
  const file = path.join(root, path.dirname(row.source), "rollout.jsonl")
  for (const line of (await Bun.file(file).text()).split("\n")) {
    let event, observation
    try {
      event = JSON.parse(line)
      if (event.type !== "response_item" || event.payload?.type !== "function_call_output" || event.payload?.name !== "skill_step") continue
      observation = JSON.parse(event.payload.output).observation
    } catch { continue }
    if (!observation) continue
    for (const action of observation.actions ?? [observation]) {
      if (action.status === "skipped") skipped++
      if (action.status !== "error") continue
      errors++
      let result = action.result
      try { if (typeof result === "string") result = JSON.parse(result) } catch {}
      const output = typeof result === "object" && result !== null ? String(result.output ?? JSON.stringify(result)) : String(result ?? "")
      // Post-hoc, mutually exclusive output-marker buckets, not inferred root causes.
      const category = /not a git repository/i.test(output) ? "git-not-repository"
        : /PermissionDenied|permission denied|operation not permitted|sandbox.*(?:denied|reject)|denied.*sandbox/i.test(output) ? "permission-or-sandbox-marker"
        : /command not found|No such file or directory|Cannot find module|ModuleNotFoundError/i.test(output) ? "missing-command-file-or-module-marker"
        : "other"
      counts[category] = (counts[category] ?? 0) + 1
    }
  }
  rows.push({ source: row.source, repetition: row.repetition, mode: row.mode, project: row.project, errors, skipped, counts })
}
const groups = ["v2", "v3"].map(mode => {
  const selected = rows.filter(r => r.mode === mode), counts: Record<string, number> = {}
  for (const row of selected) for (const [key, value] of Object.entries(row.counts)) counts[key] = (counts[key] ?? 0) + Number(value)
  return { mode, cells: selected.length, errors: selected.reduce((n, r) => n + r.errors, 0), skipped: selected.reduce((n, r) => n + r.skipped, 0), counts }
})
const result = { partial: data.missing > 0, method: "Post-hoc exclusive keyword buckets over recorded error outputs: git, then permissions, then missing file/command/module, then other. Text may contain incidental matches. No command execution, no classification of successful actions, no claim that all nonzero exits are bugs (negative tests can be intentional).", groups, rows }
await Bun.write(path.join(here, "action-errors.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify({ partial: result.partial, groups }))
