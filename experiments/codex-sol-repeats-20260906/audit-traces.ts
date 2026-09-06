// Campaign-local copy of ../article-20260904/audit-traces.ts; outputs stay in this separate series.
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const data = await Bun.file(path.join(import.meta.dir, "data.json")).json()
const findings = []
const excerpts = []
let batches = 0
let rejectedBatches = 0
let failures = 0
let skipped = 0
let parsedShellResults = 0
let unparsedShellResults = 0
for (const row of data.rows) {
  if (row.mode === "native") continue
  const folder = path.dirname(path.join(root, row.source))
  const file = path.join(folder, row.runtime === "Codex" ? "rollout.jsonl" : "events.jsonl")
  if (!await Bun.file(file).exists()) {
    findings.push({ source: row.source, issue: "missing audit log" })
    continue
  }
  const steps = []
  for (const line of (await Bun.file(file).text()).split("\n")) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    let observation
    let state
    if (row.runtime === "Codex") {
      if (event.type !== "response_item" || event.payload?.type !== "function_call_output" || event.payload?.name !== "skill_step") continue
      let transition
      try { transition = JSON.parse(event.payload.output) } catch { continue }
      observation = transition.observation
      state = transition.state
    } else {
      if (event.type !== "tool_use" || event.part?.tool !== "skill_step") continue
      const meta = event.part?.state?.metadata?.skillState
      if (!meta) continue
      state = meta.state
      observation = { revision: meta.revision, status: meta.actionStatus, comment: meta.comment,
        actions: meta.actionResults, action: meta.action?.name, input: meta.action?.input,
        result: event.part?.state?.output }
      const exit = event.part?.state?.metadata?.exit
      if (typeof exit === "number" && exit !== 0 && meta.actionStatus === "completed")
        findings.push({ source: row.source, revision: meta.revision, issue: "nonzero shell exit reported completed", exit })
    }
    if (!observation) continue
    const actions = observation.actions ?? [{ action: observation.action, input: observation.input, result: observation.result, status: observation.status }]
    if (row.runtime === "Codex") for (const action of actions) {
      if (!["exec_command", "write_stdin"].includes(action.action ?? action.name) || action.status === "skipped") continue
      let result
      try { result = typeof action.result === "string" ? JSON.parse(action.result) : action.result }
      catch { unparsedShellResults++; continue }
      if (!result || typeof result !== "object") { unparsedShellResults++; continue }
      parsedShellResults++
      if (typeof result.exit_code === "number" && result.exit_code !== 0 && action.status !== "error")
        findings.push({ source: row.source, revision: observation.revision, issue: "nonzero shell exit reported success", exit: result.exit_code })
    }
    if (observation.actions) {
      if (actions.length) batches++
      else rejectedBatches++
      let failed = false
      for (const action of actions) {
        if (failed && action.status !== "skipped") findings.push({ source: row.source, revision: observation.revision, issue: "action after failure was not skipped" })
        if (action.status === "error") { failed = true; failures++ }
        if (action.status === "skipped") skipped++
      }
    }
    steps.push({ revision: observation.revision, status: observation.status,
      stateBytes: Buffer.byteLength(JSON.stringify(state ?? {})),
      comment: observation.comment,
      actions: actions.map((a: any) => ({ name: a.action ?? a.name, status: a.status,
        command: typeof a.input?.cmd === "string" ? a.input.cmd.slice(0, 180) : typeof a.input?.command === "string" ? a.input.command.slice(0, 180) : undefined,
        resultPreview: String(a.result ?? "").slice(0, 120),
      })),
    })
  }
  if (row.runtime === "Codex" && row.repetition === 0 && ["mini-template", "taskboard-cli"].includes(row.project))
    excerpts.push({ source: row.source, model: row.model, mode: row.mode, project: row.project, steps })
}
const coverage = { parsedShellResults, unparsedShellResults,
  note: "Non-JSON shell results (including truncated results and textual errors) cannot be exit-checked here. Batch stop ordering is checked from recorded statuses, not independently re-executed." }
await Bun.write(path.join(import.meta.dir, "trace-audit.json"), JSON.stringify({ partial: data.missing > 0, batches, rejectedBatches, failures, skipped, coverage, findings, excerpts }, null, 2) + "\n")
console.log(JSON.stringify({ partial: data.missing > 0, batches, rejectedBatches, failures, skipped, coverage, findings }, null, 2))
