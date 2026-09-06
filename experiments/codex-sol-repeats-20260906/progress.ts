import path from "node:path"
import { homedir, tmpdir } from "node:os"

// Read-only progress for the exact next unfinished cell in each declared suite.
// Unrelated sessions are inspected only for their first metadata line; no prompt/command text is printed.
const here = import.meta.dir, root = path.resolve(here, "../..")
const run = await Bun.file(path.join(here, "run.json")).json()
const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
const folders: Record<string, string> = { v2: "skill-state", v3: "skill-state-v3" }
const pending = []
for (const a of run.attempts.filter((a: any) => a.status === "running" && a.suite)) {
  const ordered = projects.flatMap((project, i) => [...a.modes.slice(i % 2), ...a.modes.slice(0, i % 2)].map((mode) => ({ project, mode })))
  for (const c of ordered) {
    const summary = path.join(root, "experiments/codex-skill-state/results", a.suite, folders[c.mode], c.project, "summary.json")
    if (await Bun.file(summary).exists()) continue
    pending.push({ repetition: a.repetition, suite: a.suite, worker: a.worker, ...c,
      workspace: path.join(tmpdir(), "codex-skill-state-one-shot", a.suite, folders[c.mode], c.project) })
    break
  }
}
const days = new Set<string>()
for (let t = Date.parse(run.startedAt); t <= Date.now() + 86400000; t += 86400000)
  days.add(new Date(t).toISOString().slice(0, 10).replaceAll("-", "/"))
const sessionRoot = path.join(process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"), "sessions")
const snapshots: any[] = []
for (const day of days) for await (const file of new Bun.Glob(`${day}/*.jsonl`).scan({ cwd: sessionRoot, absolute: true })) {
  const reader = Bun.file(file).stream().getReader(), decoder = new TextDecoder()
  let prefix = ""
  try {
    while (prefix.length < 1024 * 1024 && !prefix.includes("\n")) {
      const { done, value } = await reader.read()
      if (done) break
      prefix += decoder.decode(value, { stream: true })
    }
  } finally { await reader.cancel() }
  let meta
  try { meta = JSON.parse(prefix.split("\n")[0]) } catch { continue }
  if (meta.type !== "session_meta" || meta.payload?.parent_thread_id) continue
  const cell = pending.find((p) => path.resolve(p.workspace) === path.resolve(meta.payload.cwd ?? "/"))
  if (!cell) continue
  let calls = 0, input = 0, lastEventAt = meta.timestamp, lastEventType = meta.type, startedAt = meta.timestamp
  for (const line of (await Bun.file(file).text()).split("\n")) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.timestamp) lastEventAt = e.timestamp
    lastEventType = e.type
    if (e.type === "token_usage_record") { calls++; input += e.payload.usage.input_tokens }
  }
  snapshots.push({ repetition: cell.repetition, project: cell.project, mode: cell.mode, worker: cell.worker,
    threadID: meta.payload.id, startedAt, minutes: +(Math.max(0, Date.now() - Date.parse(startedAt)) / 60000).toFixed(1),
    calls, input, lastEventType, lastEventAgeSeconds: Math.round((Date.now() - Date.parse(lastEventAt)) / 1000) })
}
const result = { capturedAt: new Date().toISOString(), status: run.status, active: snapshots,
  pendingWithoutMatchedSession: pending.filter((p) => !snapshots.some((s) => s.repetition === p.repetition)).map(({ workspace, ...p }) => p) }
await Bun.write(path.join(here, "progress.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
