import path from "node:path"
import { lstat, mkdir, readdir, copyFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"

// Post-run export only. Never copy prompts, reasoning, tool output or host paths into public logs.
const here = import.meta.dir
const root = path.resolve(here, "../..")
if (await Bun.file(path.join(here, "data.json")).exists()) throw new Error("Snapshot already captured")
const cohorts = [
  { name: "sol", model: "gpt-5.6-sol", directory: "codex-sol-clean-20260908", workspace: "codex-sol-clean-one-shot" },
  { name: "astra", model: "gpt-6-astra", directory: "codex-astra-repeats-20260908", workspace: "codex-astra-one-shot" },
]
const modes: Record<string, string> = { baseline: "native", paper: "paper", v2: "v2", v3: "v3" }
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const sourceHashes: Record<string, string> = {}
const rows = []
const records = []
const contextAudits = []
const archives = []
const runs = []
const threads = new Set<string>()
const omit = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache", ".pytest_cache"])
for (const cohort of cohorts) {
  const directory = path.join(root, "experiments", cohort.directory)
  const run = await Bun.file(path.join(directory, "run.json")).json()
  if (run.status !== "complete" || run.isolation !== "restored" || run.cells.length !== 100 ||
      run.cells.some((cell: { status: string }) => cell.status !== "complete")) throw new Error("Incomplete cohort")
  const manifest = await Bun.file(path.join(directory, "source-manifest.json")).json()
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (await hash(path.join(root, file)) !== expected) throw new Error("Frozen source differs: " + file)
    sourceHashes[file] = expected as string
  }
  for (const name of ["run.json", "source-manifest.json", "PROTOCOL.md",
    ...(cohort.name === "sol" ? ["restoration.json", "isolation-watch.json"] :
      ["restoration.json", "restoration-resume-1.json", "isolation-watch-resume-1.json", "resume-1-manifest.json", "RESUME-1.md"])]) {
    const file = path.join(directory, name)
    sourceHashes[path.relative(root, file)] = await hash(file)
  }
  runs.push({ cohort: cohort.name, model: cohort.model, startedAt: run.startedAt, endedAt: run.endedAt,
    maxWorkers: run.maxWorkers, continuations: run.continuations ?? [], planned: run.plannedCells })
  for (const cell of run.cells) {
    const source = path.join(directory, cell.source)
    if (!source.startsWith(path.join(directory, ".private/results") + path.sep)) throw new Error("Unexpected source")
    const summary = await Bun.file(source).json()
    if (summary.model !== cohort.model || summary.project !== cell.project ||
        summary.protocolMode !== cell.mode || summary.binary.sha256 !== manifest.executableSha256 ||
        summary.cellTimeoutMs !== 900000) throw new Error("Outcome identity mismatch")
    if (threads.has(summary.metrics.threadID)) throw new Error("Duplicated main thread")
    threads.add(summary.metrics.threadID)
    const id = `${cohort.name}/${cell.repetition}/${modes[cell.mode]}/${cell.project}`
    const parent = path.dirname(source)
    for (const name of ["summary.json", "events.jsonl", "stderr.log", "rollout.jsonl", "initial-context-audit.json"])
      sourceHashes[path.relative(root, path.join(parent, name))] = await hash(path.join(parent, name))
    const events = (await Bun.file(path.join(parent, "events.jsonl")).text()).split("\n").filter(Boolean).map(line => JSON.parse(line))
    const initial = await Bun.file(path.join(parent, "initial-context-audit.json")).json()
    if (!initial.initial.length || initial.initial.some((item: { skills: boolean, hostProfile: boolean }) => item.skills || item.hostProfile))
      throw new Error("Initial context audit failed")
    contextAudits.push({ id, ...initial })
    const observedModels = new Set<string>()
    const usage = []
    let finish = false
    for (const line of (await Bun.file(path.join(parent, "rollout.jsonl")).text()).split("\n").filter(Boolean)) {
      const event = JSON.parse(line)
      if (event.type === "turn_context" && event.payload?.model) observedModels.add(event.payload.model)
      if (event.type === "token_usage_record") {
        const u = event.payload.usage
        usage.push({ input: u.input_tokens, cachedInput: u.cached_input_tokens ?? 0,
          output: u.output_tokens, reasoning: u.reasoning_output_tokens ?? 0 })
      }
      if (event.type !== "response_item" || event.payload?.type !== "function_call_output" || event.payload.name !== "skill_step") continue
      let transition
      try { transition = JSON.parse(event.payload.output) } catch { continue }
      const observation = transition.observation
      const actions = observation?.actions ?? [{ action: observation?.action, status: observation?.status }]
      finish ||= observation?.status === "success" && actions.some((action: { action: string, status: string }) =>
        action.action === "finish" && action.status === "success")
    }
    const sum = (key: keyof typeof usage[number]) => usage.reduce((n, u) => n + u[key], 0)
    if (observedModels.size !== 1 || !observedModels.has(cohort.model) || !usage.length ||
        sum("input") !== summary.metrics.input || sum("output") !== summary.metrics.output ||
        sum("cachedInput") !== summary.metrics.cachedInput || usage.length !== summary.metrics.samples)
      throw new Error("Model/usage reconciliation failed: " + id)
    const protocolFinished = cell.mode === "baseline" ? events.some(event => event.type === "turn.completed") : finish
    const completed = summary.exitCode === 0 && !summary.timedOut
    const checks = summary.evaluation.checks.map((check: { name: string, passed: boolean }) => ({ name: check.name, passed: check.passed }))
    const artifactPass = summary.evaluation.passed === summary.evaluation.total
    rows.push({ id, cohort: cohort.name, model: cohort.model, repetition: cell.repetition, project: cell.project,
      mode: modes[cell.mode], threadID: summary.metrics.threadID, source: path.relative(root, source),
      startedAt: cell.startedAt, endedAt: cell.endedAt, worker: cell.worker,
      input: sum("input"), cachedInput: sum("cachedInput"), output: sum("output"), reasoning: sum("reasoning"),
      calls: usage.length, durationMs: summary.metrics.durationMs, exitCode: summary.exitCode,
      timedOut: summary.timedOut, completed, protocolFinished, passed: summary.evaluation.passed,
      total: summary.evaluation.total, checks, artifactPass, rawSuccess: artifactPass && completed && protocolFinished,
      acceptedFinish: finish, archive: `artifacts/${id}/workspace` })
    records.push({ id, usage })

    // Preserve generated projects without following links, exporting caches or reading auth files.
    const workspace = await realpath(summary.workspace)
    const expected = await realpath(path.join(tmpdir(), cohort.workspace, summary.suite, summary.mode, cell.project))
    if (workspace !== expected) throw new Error("Unexpected workspace")
    const files: { path: string, bytes: number, sha256: string }[] = []
    const skipped: { path: string, reason: string }[] = []
    let bytes = 0
    async function visit(relative = "") {
      for (const name of (await readdir(path.join(workspace, relative))).sort()) {
        const item = path.join(relative, name)
        const source = path.join(workspace, item)
        const stat = await lstat(source)
        if (stat.isSymbolicLink()) { skipped.push({ path: item, reason: "symlink not followed" }); continue }
        if (stat.isDirectory()) {
          if (omit.has(name)) { skipped.push({ path: item, reason: "dependencies/cache/VCS" }); continue }
          await visit(item)
          continue
        }
        if (!stat.isFile() || name === ".env" || name.startsWith(".env.") || /^(credentials|auth)\.json$/.test(name)) {
          skipped.push({ path: item, reason: "non-regular or potential secret-bearing file" }); continue
        }
        if (stat.size > 5 * 1024 * 1024 || bytes + stat.size > 20 * 1024 * 1024) throw new Error("Archive size limit")
        const content = await Bun.file(source).text()
        if (/yandex-team\.|\.stefania|<skills_instructions>|### Available skills|\/Users\/|\/home\/|ghp_[A-Za-z0-9]{20}|sk-proj-[A-Za-z0-9]{20}/i.test(content))
          throw new Error("Archive requires privacy review: " + id + "/" + item)
        const destination = path.join(here, "artifacts", id, "workspace", item)
        await mkdir(path.dirname(destination), { recursive: true })
        await copyFile(source, destination)
        files.push({ path: item, bytes: stat.size, sha256: await hash(source) })
        if (await hash(destination) !== files.at(-1)!.sha256) throw new Error("Archive copy mismatch")
        bytes += stat.size
      }
    }
    await visit()
    archives.push({ id, files, skipped })
  }
}
await Bun.write(path.join(here, "data.json"), JSON.stringify({ capturedAt: new Date().toISOString(), runs, rows,
  scope: "200 distinct main sessions, numeric metadata and original check booleans. No prompts, reasoning, tool outputs or host paths exported. Original scores unchanged." }, null, 2) + "\n")
await Bun.write(path.join(here, "usage-records.json"), JSON.stringify({ records }, null, 2) + "\n")
await Bun.write(path.join(here, "initial-context-audit.json"), JSON.stringify({ audits: contextAudits }, null, 2) + "\n")
await Bun.write(path.join(here, "archive-manifest.json"), JSON.stringify({ archives,
  scope: "Post-evaluator workspace snapshot. Symlinks, dependencies, caches and possible credential files excluded; no generated code executed by capture." }, null, 2) + "\n")
await Bun.write(path.join(here, "source-hashes.json"), JSON.stringify({ files: sourceHashes,
  scope: "Fingerprints only. Entries under .private identify local raw evidence, not files published by this export." }, null, 2) + "\n")
console.log(JSON.stringify({ sessions: rows.length, archived: archives.length, audited: contextAudits.length,
  tokensReconciled: rows.length, rawSourcesFingerprinted: Object.keys(sourceHashes).length }))
