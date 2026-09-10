// Large-context Sol cohort; corrected isolation and worker draining reuse the clean Astra continuation.
import path from "node:path"
import { homedir } from "node:os"
import { mkdir, rename } from "node:fs/promises"
import { spawn } from "node:child_process"
import { discover, exists, restore, suspend } from "../codex-sol-large-context-20260909/isolation"
import { assertSkillIsolation } from "../codex-sol-large-context-20260909/isolation-guard"
import { schedule } from "./schedule"
import { runPool } from "../codex-sol-large-context-20260909/pool"
import { auditContext } from "../codex-sol-large-context-20260909/audit-context"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const privateDir = path.join(here, ".private")
const runner = path.join(here, "runner.ts")
const maxWorkers = 5
const settings = { CODEX_SKILL_STATE_MAX_CONCURRENCY: "1",
  CODEX_SKILL_STATE_OBSERVATION_WINDOW: "1", CODEX_SKILL_STATE_TIMEOUT_MS: "900000" }
const env = { ...process.env, ...settings }
const includeInstructions = process.argv.includes("--with-global-instructions")
if (process.argv.slice(2).some(arg => arg !== "--with-global-instructions")) throw new Error("Unexpected option")
if (process.env.CODEX_HOME?.trim() && path.resolve(process.env.CODEX_HOME.trim()) !== path.join(homedir(), ".codex"))
  throw new Error("A nonstandard Codex home requires an explicit discovery review")
if (!includeInstructions) throw new Error("Explicit global-instruction isolation acknowledgement required")
if (await exists(path.join(here, "run.json")) || await exists(path.join(here, "source-manifest.json")))
  throw new Error("Existing campaign: inspect, never overwrite or retry automatically")
const cells = schedule()
const preflight = await Bun.file(path.join(here, "preflight.json")).json()
if (preflight.status !== "passed-with-documented-host-limitation" ||
    preflight.coreTests.failed !== 0 || preflight.coreTests.passed < 20 ||
    preflight.cliTests.failed !== 0 || preflight.cliTests.passed < 8 ||
    preflight.orchestratorTests.failed !== 0 || preflight.orchestratorTests.passed < 12 ||
    preflight.format.exitCode !== 0 || preflight.clippy.exitCode !== 0)
  throw new Error("Local preflight is not ready")
const state = { models: ["gpt-5.6-sol", "gpt-6-astra"], mode: "paper2",
  status: "preparing", plannedCells: cells.length, maxWorkers,
  startedAt: new Date().toISOString(), endedAt: null as string | null,
  isolation: "pending", stopReason: null as string | null, cells }
const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const build = await Bun.file(path.join(here, "build-manifest.json")).json()
const mainHash = build.executableSha256
const files: Record<string, string> = {}
for (const [file, expected] of Object.entries(build.files)) {
  if (await hash(path.join(here, file)) !== expected) throw new Error("Experimental build source changed")
  files[path.relative(root, path.join(here, file))] = expected as string
}
for (const name of ["runner.ts", "run.ts", "schedule.ts", "PROTOCOL.md", "build-manifest.json",
  "kernel.patch", "capture-build.ts", "contract.test.ts", "launch.ts", "preflight.json"])
  files[path.relative(root, path.join(here, name))] = await hash(path.join(here, name))
for (const name of ["isolation.ts", "isolation-guard.ts", "pool.ts", "audit-context.ts"])
  files["experiments/codex-sol-large-context-20260909/" + name] =
    await hash(path.join(root, "experiments/codex-sol-large-context-20260909", name))
for (const name of ["scripts/evaluate.ts", "prompts/one-shot.txt",
  ...["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"].map(p => "projects/" + p + "/SPEC.md")])
  files["experiments/skill-state/" + name] = await hash(path.join(root, "experiments/skill-state", name))
const doctor = Bun.spawn(["bun", runner, "doctor"], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
const [doctorText, doctorError, doctorExit] = await Promise.all([
  new Response(doctor.stdout).text(), new Response(doctor.stderr).text(), doctor.exited])
await mkdir(privateDir, { recursive: true, mode: 0o700 })
if (doctorExit) {
  await Bun.write(path.join(privateDir, "doctor.stderr.log"), doctorError)
  throw new Error("Doctor failed; private diagnostic saved")
}
const info = JSON.parse(doctorText)
for (const name of ["codex", "codex-code-mode-host"])
  files[path.relative(root, path.join(here, ".private/source/codex/codex-rs/target/debug", name))] =
    await hash(path.join(here, ".private/source/codex/codex-rs/target/debug", name))
if (Object.values(info.binaries).some(binary => (binary as { sha256: string }).sha256 !== mainHash) ||
    info.binaries.baseline.codeModeHostSha256 !== build.codeModeHostSha256)
  throw new Error("Unexpected benchmark executable")
await Bun.write(path.join(here, "source-manifest.json"), JSON.stringify({
  capturedAt: new Date().toISOString(), files, executableSha256: mainHash,
  codeModeHostSha256: build.codeModeHostSha256, settings, maxWorkers,
  globalInstructionIsolationAuthorized: includeInstructions,
  schedule: cells.map(c => c.model + "/" + c.repetition + "/" + c.project + "/" + c.mode),
  reference: "experiments/codex-large-context-comparison-20260909",
  note: "50 new Paper2 sessions, five repeats of five tasks per model. Historical controls are separate cohorts, not contemporaneous randomized controls."
}, null, 2) + "\n")

let saveQueue = Promise.resolve()
function save() {
  const snapshot = JSON.stringify(state, null, 2) + "\n"
  saveQueue = saveQueue.then(async () => {
    const next = path.join(here, "run.next.json")
    await Bun.write(next, snapshot)
    await rename(next, path.join(here, "run.json"))
  })
  return saveQueue
}
await save()
let interrupted = false
const active = new Set<ReturnType<typeof spawn>>()
let ledger: Awaited<ReturnType<typeof suspend>> | undefined
let watchTimer: ReturnType<typeof setInterval> | undefined
let watchTask: Promise<void> | undefined
let guardFailure: string | undefined
const guardStats = { checks: 0, cacheOnlyChecks: 0, unsafeChecks: 0 }
const killTimers = new Map<ReturnType<typeof spawn>, ReturnType<typeof setTimeout>>()
function stopGroup(child: ReturnType<typeof spawn>) {
  if (!child.pid) return
  const pid = child.pid
  try { process.kill(-pid, "SIGTERM") } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
  if (!killTimers.has(child)) killTimers.set(child, setTimeout(() => {
    if (!active.has(child)) return
    try { process.kill(-pid, "SIGKILL") } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }, 10000))
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {
  interrupted = true
  for (const child of active) stopGroup(child)
})

try {
  ledger = await suspend(await discover(includeInstructions), path.join(homedir(), ".codex"))
  await Bun.write(path.join(privateDir, "isolation.json"), JSON.stringify({ ledger: path.join(ledger.directory, "ledger.json") }, null, 2))
  state.isolation = "suspended"
  state.status = "running"
  await save()
  console.log(JSON.stringify({ event: "isolated", roots: ledger.entries.length, planned: cells.length }))
  watchTimer = setInterval(() => {
    if (watchTask) return
    watchTask = assertSkillIsolation(ledger!).then(result => {
      guardStats.checks++
      if (result.ignoredDisabledSystemCaches) {
        guardStats.cacheOnlyChecks++
        if (guardStats.cacheOnlyChecks === 1) console.log(JSON.stringify({ event: "disabled-system-cache-ignored" }))
      }
    }).catch(error => {
      guardStats.unsafeChecks++
      guardFailure = error instanceof Error ? error.message : "Isolation guard failed"
      interrupted = true
      for (const child of active) stopGroup(child)
    }).finally(() => { watchTask = undefined })
  }, 2000)
  await runPool(cells, maxWorkers, async (cell, worker) => {
    if (interrupted) throw new Error("Interrupted by signal")
    await assertSkillIsolation(ledger!)
    cell.worker = worker
    cell.status = "running"
    cell.startedAt = new Date().toISOString()
    await save()
    if (interrupted) throw new Error("Interrupted before spawn")
    await assertSkillIsolation(ledger!)
    console.log(JSON.stringify({ event: "start", model: cell.model, repetition: cell.repetition, project: cell.project, mode: cell.mode }))
    const child = spawn("bun", [runner, "one", cell.project, cell.mode], { cwd: root, env: { ...env, CODEX_SKILL_STATE_MODEL: cell.model }, detached: true,
      stdio: ["ignore", "pipe", "pipe"] })
    active.add(child)
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    child.stdout!.on("data", chunk => stdout.push(Buffer.from(chunk)))
    child.stderr!.on("data", chunk => stderr.push(Buffer.from(chunk)))
    const outerTimeout = setTimeout(() => { interrupted = true; for (const item of active) stopGroup(item) }, 1020000)
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", code => resolve(code))
    }).finally(() => {
      clearTimeout(outerTimeout)
      if (killTimers.has(child)) clearTimeout(killTimers.get(child))
      killTimers.delete(child)
      active.delete(child)
    })
    const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString()
    const label = `${cell.model}-${cell.repetition}-${cell.project}-${cell.mode}`
    await Bun.write(path.join(privateDir, label + ".stdout.log"), out)
    await Bun.write(path.join(privateDir, label + ".stderr.log"), err)
    cell.endedAt = new Date().toISOString()
    if (code !== 0) { cell.status = "runner-error"; throw new Error("Runner process failed; inspect private diagnostics") }
    const summary = JSON.parse(out)
    const source = `.private/results/${summary.suite}/${summary.mode}/${summary.project}/summary.json`
    if (summary.model !== cell.model || summary.project !== cell.project ||
        summary.binary.sha256 !== mainHash || summary.mode !== "skill-state-paper2") throw new Error("Unexpected outcome identity")
    cell.source = source
    cell.status = "complete"
    await save()
    const directory = path.dirname(path.join(here, source))
    const events = await Bun.file(path.join(directory, "events.jsonl")).text()
    const eventRows = events.split("\n").filter(Boolean).map(line => JSON.parse(line))
    const errors = eventRows.filter(event => event.type === "error" || event.type === "turn.failed" || event.item?.type === "error")
    // Only classify error objects, not model-authored task text or generated code.
    const infrastructure = errors.some(event => /rate.?limit|usage.?limit|quota|unauthori[sz]ed|authentication|model.{0,50}(not found|not supported|does not exist)|429|401/i.test(JSON.stringify(event)))
    const rolloutFile = path.join(directory, "rollout.jsonl")
    if (!await Bun.file(rolloutFile).exists()) throw new Error("Missing rollout; dispatch stopped")
    const contextAudit = auditContext(await Bun.file(rolloutFile).text())
    await Bun.write(path.join(directory, "context-budget-audit.json"), JSON.stringify(contextAudit, null, 2) + "\n")
    if (contextAudit.models.length !== 1 || contextAudit.models[0] !== cell.model)
      throw new Error("Unexpected actual model in rollout")
    if (contextAudit.calls !== summary.metrics.samples || contextAudit.input !== summary.metrics.input ||
        contextAudit.output !== summary.metrics.output)
      throw new Error("Per-call usage does not reconcile with summary")
    if (contextAudit.malformedTransitions) throw new Error("Malformed persisted state transition; no further dispatch")
    const transitionRows = (await Bun.file(rolloutFile).text()).split("\n").filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => row.type === "response_item" &&
        row.payload?.type === "function_call_output" && row.payload?.name === "skill_step")
      .map(row => JSON.parse(row.payload.output))
    if (!transitionRows.length || transitionRows.some(row => row.protocol !== "skill.state/paper2" ||
      Array.isArray(row.observation?.actions) || row.observation?.comment != null))
      throw new Error("Paper2 protocol identity/observation mismatch")
    await Bun.write(path.join(directory, "protocol-audit.json"), JSON.stringify({
      protocol: "skill.state/paper2", transitions: transitionRows.length,
      acceptedFinish: transitionRows.some(row => typeof row.final_message === "string" &&
        row.state?.status === "done" && row.observation?.action === "finish" && row.observation?.status === "success"),
      scope: "Persisted transition identity and accepted finish; not a provider packet capture."
    }, null, 2) + "\n")
    const initial: { role: string, bytes: number, sha256: string, skills: boolean, hostProfile: boolean }[] = []
    for (const line of (await Bun.file(rolloutFile).text()).split("\n").filter(Boolean)) {
      const event = JSON.parse(line)
      if (event.type !== "response_item") continue
      const item = event.payload
      if (item.type === "reasoning" || item.type === "function_call" || item.role === "assistant") break
      if (item.type !== "message") continue
      const text = (item.content ?? []).map((part: { text?: string }) => part.text ?? "").join("\n")
      initial.push({ role: item.role, bytes: Buffer.byteLength(text),
        sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
        skills: /<skills_instructions>|### Available skills|### Skill roots/.test(text),
        hostProfile: /<!--\s*[\w-]+-core:start/.test(text) })
    }
    await Bun.write(path.join(directory, "initial-context-audit.json"), JSON.stringify({ initial,
      scope: "Recorded initial messages; fingerprints only, not a packet capture." }, null, 2) + "\n")
    console.log(JSON.stringify({ event: "done", model: cell.model, repetition: cell.repetition, project: cell.project, mode: cell.mode,
      score: `${summary.evaluation.passed}/${summary.evaluation.total}`, calls: summary.metrics.samples,
      input: summary.metrics.input, timeout: summary.timedOut, completed: cells.filter(c => c.status === "complete").length }))
    if (infrastructure) throw new Error("Provider infrastructure/model/limit error; no further dispatch")
    if (!summary.metrics.samples) throw new Error("No recorded model usage; no further dispatch")
    if (initial.some(item => item.skills || item.hostProfile)) throw new Error("Host context remains in rollout; no further dispatch")
    await assertSkillIsolation(ledger!)
  }, () => interrupted)
  if (guardFailure) throw new Error(guardFailure)
  if (interrupted) throw new Error("Interrupted by signal or orchestration timeout")
  if (cells.some(cell => cell.status !== "complete")) throw new Error("Campaign did not finish all planned cells")
  for (const [file, expected] of Object.entries(files)) if (await hash(path.join(root, file)) !== expected)
    throw new Error("Frozen source changed during campaign")
  state.status = "complete"
} catch (error) {
  state.status = interrupted ? "interrupted" : "needs-attention"
  state.stopReason = error instanceof Error ? error.message : "Unexpected orchestration error"
  for (const child of active) stopGroup(child)
  console.log(JSON.stringify({ event: "stopped", reason: state.stopReason }))
} finally {
  if (watchTimer) clearInterval(watchTimer)
  await watchTask
  state.endedAt = new Date().toISOString()
  for (const cell of cells) if (cell.status === "running") {
    cell.status = "interrupted"
    cell.endedAt = state.endedAt
  }
  await Bun.write(path.join(here, "isolation-watch.json"), JSON.stringify({ at: state.endedAt, ...guardStats, guardFailure: guardFailure ?? null }, null, 2) + "\n")
  if (ledger) {
    const receipt = await restore(path.join(ledger.directory, "ledger.json"))
    state.isolation = "restored"
    await Bun.write(path.join(here, "restoration.json"), JSON.stringify({ at: new Date().toISOString(), ...receipt }, null, 2) + "\n")
    console.log(JSON.stringify({ event: "restored", ...receipt }))
  }
  await save()
}
if (state.status !== "complete") process.exitCode = 1
