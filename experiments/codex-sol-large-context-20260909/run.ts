// Large-context Sol cohort; corrected isolation and worker draining reuse the clean Astra continuation.
import path from "node:path"
import { homedir } from "node:os"
import { mkdir, rename } from "node:fs/promises"
import { spawn } from "node:child_process"
import { discover, exists, restore, suspend } from "./isolation"
import { assertSkillIsolation } from "./isolation-guard"
import { schedule } from "./schedule"
import { loadArtifactIntegrity } from "../../scripts/artifact-integrity"
import { runPool } from "./pool"
import { auditContext } from "./audit-context"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const privateDir = path.join(here, ".private")
const runner = path.join(here, "runner.ts")
const maxWorkers = 5
const settings = { CODEX_SKILL_STATE_MODEL: "gpt-5.6-sol", CODEX_SKILL_STATE_MAX_CONCURRENCY: "1",
  CODEX_SKILL_STATE_OBSERVATION_WINDOW: "3", CODEX_SKILL_STATE_TIMEOUT_MS: "900000" }
const env = { ...process.env, ...settings }
const includeInstructions = process.argv.includes("--with-global-instructions")
if (process.argv.slice(2).some(arg => arg !== "--with-global-instructions")) throw new Error("Unexpected option")
if (process.env.CODEX_HOME?.trim() && path.resolve(process.env.CODEX_HOME.trim()) !== path.join(homedir(), ".codex"))
  throw new Error("A nonstandard Codex home requires an explicit discovery review")
if (!includeInstructions) throw new Error("Explicit global-instruction isolation acknowledgement required")
if (await exists(path.join(here, "run.json")) || await exists(path.join(here, "source-manifest.json")))
  throw new Error("Existing campaign: inspect, never overwrite or retry automatically")
const reference = "experiments/codex-astra-large-context-20260908"
const referenceRun = await Bun.file(path.join(root, reference, "run.json")).json()
if (referenceRun.model !== "gpt-6-astra" || referenceRun.status !== "complete" ||
    referenceRun.isolation !== "restored" || referenceRun.cells.length !== 100 ||
    referenceRun.cells.some((cell: { status: string }) => cell.status !== "complete"))
  throw new Error("The reference Astra campaign must be complete with global sources restored")
const cells = schedule()
const preflight = await Bun.file(path.join(here, "preflight.json")).json()
if (preflight.coreTests.passed !== 18 || preflight.coreTests.failed !== 0 ||
    preflight.cliTests.passed !== 7 || preflight.cliTests.failed !== 0 ||
    preflight.orchestratorTests.passed !== 13 || preflight.orchestratorTests.failed !== 0 ||
    preflight.format.exitCode !== 0 || !preflight.patch.reverseApplyCheck)
  throw new Error("Local preflight is not ready")
const keys = cells.map(cell => `${cell.repetition}/${cell.project}/${cell.mode}`)
if (JSON.stringify(keys) !== JSON.stringify(referenceRun.cells.map(
  (cell: { repetition: number, project: string, mode: string }) => `${cell.repetition}/${cell.project}/${cell.mode}`)))
  throw new Error("Schedule differs from the reference cohort")
const state = { model: settings.CODEX_SKILL_STATE_MODEL, status: "preparing", plannedCells: cells.length, maxWorkers,
  startedAt: new Date().toISOString(), endedAt: null as string | null,
  isolation: "pending", stopReason: null as string | null, cells }

const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const historical = await Bun.file(path.join(root, "experiments/codex-sol-repeats-20260906/source-manifest.json")).json()
const integrity = await loadArtifactIntegrity(root)
const files: Record<string, string> = {}
for (const [file, expected] of Object.entries(historical.source.files)) {
  await integrity.verify(file, expected as string)
  files[file] = await hash(path.join(root, file))
}
// Freeze the completed large-context Astra cohort and the clean Sol comparison separately.
const cleanSol = "experiments/codex-sol-clean-20260908"
const cleanRun = await Bun.file(path.join(root, cleanSol, "run.json")).json()
if (cleanRun.model !== "gpt-5.6-sol" || cleanRun.status !== "complete" ||
    cleanRun.isolation !== "restored" || cleanRun.cells.length !== 100 ||
    cleanRun.cells.some((cell: { status: string }) => cell.status !== "complete"))
  throw new Error("Clean Sol reference is not complete and restored")
for (const cohort of [reference, cleanSol]) {
  const manifest = await Bun.file(path.join(root, cohort, "source-manifest.json")).json()
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (await hash(path.join(root, file)) !== expected) throw new Error("Reference campaign source changed")
    files[file] = expected as string
  }
  for (const name of ["run.json", "source-manifest.json", "restoration.json", "isolation-watch.json"])
    files[path.join(cohort, name)] = await hash(path.join(root, cohort, name))
}
for (const file of ["runner.ts", "run.ts", "schedule.ts", "isolation-guard.ts", "pool.ts", "isolation.ts", "PROTOCOL.md",
  "contract.test.ts", "isolation.test.ts", "isolation-guard.test.ts", "pool.test.ts",
  "audit-context.ts", "audit-context.test.ts", "preflight.json"])
  files[path.relative(root, path.join(here, file))] = await hash(path.join(here, file))
const doctor = Bun.spawn(["bun", runner, "doctor"], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
const [doctorText, doctorError, doctorExit] = await Promise.all([
  new Response(doctor.stdout).text(), new Response(doctor.stderr).text(), doctor.exited])
await mkdir(privateDir, { recursive: true, mode: 0o700 })
if (doctorExit) {
  await Bun.write(path.join(privateDir, "doctor.stderr.log"), doctorError)
  throw new Error("Doctor failed; private diagnostic saved")
}
const info = JSON.parse(doctorText)
const build = await Bun.file(path.join(root, reference, "build-manifest.json")).json()
for (const [file, expected] of Object.entries(build.files)) {
  if (await hash(path.join(root, reference, file)) !== expected) throw new Error("Experimental build source changed")
  files[path.join(reference, file)] = expected as string
}
for (const file of ["build-manifest.json", "kernel.patch", "capture-build.ts"])
  files[path.join(reference, file)] = await hash(path.join(root, reference, file))
const mainHash = "6c573e7f919cce1968def7ec067afbcdf3f2b4a76c7811178ac5715ac84997ee"
if (build.executableSha256 !== mainHash) throw new Error("Unexpected large-context build record")
const companionHash = "b5ce3a2a9d1c65389c5fb32fa2b734251b644929d039cf4867683d39a90b9630"
if (Object.values(info.binaries).some(binary => (binary as { sha256: string }).sha256 !== mainHash) ||
    info.binaries.baseline.codeModeHostSha256 !== companionHash) throw new Error("Unexpected benchmark executable")
await Bun.write(path.join(here, "source-manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(),
  files, executableSha256: mainHash, codeModeHostSha256: companionHash, settings,
  maxWorkers, globalInstructionIsolationAuthorized: includeInstructions, schedule: keys,
  referenceCampaign: reference, cleanSolReference: cleanSol,
  historicalReference: "experiments/codex-sol-repeats-20260906/source-manifest.json",
  note: "New 100-cell Sol cohort on the identical completed Astra large-context executable. Four limits remain 2 MiB with preserved transition JSON. Only the model changes; fresh workspaces and outcomes. Historical results unchanged." }, null, 2) + "\n")

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
    console.log(JSON.stringify({ event: "start", repetition: cell.repetition, project: cell.project, mode: cell.mode }))
    const child = spawn("bun", [runner, "one", cell.project, cell.mode], { cwd: root, env, detached: true,
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
    const label = `${cell.repetition}-${cell.project}-${cell.mode}`
    await Bun.write(path.join(privateDir, label + ".stdout.log"), out)
    await Bun.write(path.join(privateDir, label + ".stderr.log"), err)
    cell.endedAt = new Date().toISOString()
    if (code !== 0) { cell.status = "runner-error"; throw new Error("Runner process failed; inspect private diagnostics") }
    const summary = JSON.parse(out)
    const source = `.private/results/${summary.suite}/${summary.mode}/${summary.project}/summary.json`
    if (summary.model !== settings.CODEX_SKILL_STATE_MODEL || summary.project !== cell.project ||
        summary.binary.sha256 !== mainHash || summary.mode !== ({ baseline: "baseline", paper: "skill-state-paper", v2: "skill-state", v3: "skill-state-v3" }[cell.mode])) throw new Error("Unexpected outcome identity")
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
    if (contextAudit.models.length !== 1 || contextAudit.models[0] !== settings.CODEX_SKILL_STATE_MODEL)
      throw new Error("Unexpected actual model in rollout")
    if (contextAudit.calls !== summary.metrics.samples || contextAudit.input !== summary.metrics.input ||
        contextAudit.output !== summary.metrics.output)
      throw new Error("Per-call usage does not reconcile with summary")
    if (contextAudit.malformedTransitions) throw new Error("Malformed persisted state transition; no further dispatch")
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
    console.log(JSON.stringify({ event: "done", repetition: cell.repetition, project: cell.project, mode: cell.mode,
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
