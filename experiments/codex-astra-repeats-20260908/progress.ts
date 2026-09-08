import path from "node:path"
import { homedir, tmpdir } from "node:os"
import { exists } from "./isolation"

const here = import.meta.dir
const run = await Bun.file(path.join(here, "run.json")).json()
const days = new Set<string>()
for (let date = new Date(run.startedAt); date.getTime() <= Date.now() + 86400000; date = new Date(date.getTime() + 86400000))
  days.add(date.toISOString().slice(0, 10).replaceAll("-", "/"))
const live = []
for (const day of days) {
  const directory = path.join(homedir(), ".codex/sessions", day)
  if (!await exists(directory)) continue
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
    let metadata
    try { metadata = JSON.parse(prefix.split("\n")[0]!) } catch { continue }
    if (metadata.type !== "session_meta" || typeof metadata.payload?.cwd !== "string" ||
        !metadata.payload.cwd.startsWith(path.join(tmpdir(), "codex-astra-one-shot") + path.sep)) continue
    const folder = metadata.payload.cwd.split(path.sep)
    const models = new Set<string>()
    let calls = 0, input = 0, initialSkills = false, initialHostProfile = false, modelStarted = false
    for (const line of (await Bun.file(file).text()).split("\n")) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue } // A live final line can be incomplete.
      if (event.type === "turn_context" && event.payload?.model) models.add(event.payload.model)
      if (event.type === "token_usage_record") { calls++; input += event.payload.usage.input_tokens }
      if (event.type !== "response_item") continue
      const item = event.payload
      if (item.type === "reasoning" || item.type === "function_call" || item.role === "assistant") modelStarted = true
      if (modelStarted || item.type !== "message") continue
      const content = (item.content ?? []).map((part: { text?: string }) => part.text ?? "").join("\n")
      initialSkills ||= /<skills_instructions>|### Available skills|### Skill roots/.test(content)
      initialHostProfile ||= /<!--\s*[\w-]+-core:start/.test(content)
    }
    live.push({ threadID: metadata.payload.id, suite: folder.at(-3), mode: folder.at(-2), project: folder.at(-1),
      models: [...models], calls, input, initialSkills, initialHostProfile })
  }
}
console.log(JSON.stringify({ status: run.status, isolation: run.isolation, planned: run.plannedCells, maxWorkers: run.maxWorkers,
  completed: run.cells.filter((cell: { status: string }) => cell.status === "complete").length,
  active: run.cells.filter((cell: { status: string }) => cell.status === "running"), live,
  scope: "Progress and recorded initial-context flags; no prompt text exported, partial response lines ignored." }, null, 2))
