import path from "node:path"
import { homedir } from "node:os"
import { mkdir, rename } from "node:fs/promises"
import { spawn } from "node:child_process"
import { assertSuspended, discover, exists, restore, suspend } from "./isolation"
import { loadArtifactIntegrity } from "../../scripts/artifact-integrity"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const privateDir = path.join(here, ".private")
const runner = path.join(here, "runner.ts")
const settings = { CODEX_SKILL_STATE_MODEL: "gpt-6-astra", CODEX_SKILL_STATE_MAX_CONCURRENCY: "1",
  CODEX_SKILL_STATE_OBSERVATION_WINDOW: "3", CODEX_SKILL_STATE_TIMEOUT_MS: "900000" }
const env = { ...process.env, ...settings }
const includeInstructions = process.argv.includes("--with-global-instructions")
if (process.argv.slice(2).some(arg => arg !== "--with-global-instructions")) throw new Error("Unexpected option")
if (process.env.CODEX_HOME?.trim() && path.resolve(process.env.CODEX_HOME.trim()) !== path.join(homedir(), ".codex"))
  throw new Error("A nonstandard Codex home requires an explicit discovery review")
if (await exists(path.join(here, "run.json"))) throw new Error("Existing campaign: inspect, never overwrite or retry automatically")
if (!includeInstructions && (await exists(path.join(homedir(), ".codex/AGENTS.md")) ||
    await exists(path.join(homedir(), ".codex/AGENTS.override.md"))))
  throw new Error("Global instructions require user approval for temporary isolation before this cohort can start")

const hash = async (file: string) => new Bun.CryptoHasher("sha256")
  .update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const historical = await Bun.file(path.join(root, "experiments/codex-sol-repeats-20260906/source-manifest.json")).json()
const integrity = await loadArtifactIntegrity(root)
const files: Record<string, string> = {}
for (const [file, expected] of Object.entries(historical.source.files)) {
  await integrity.verify(file, expected as string)
  files[file] = await hash(path.join(root, file))
}
for (const file of ["runner.ts", "run.ts", "isolation.ts", "PROTOCOL.md"])
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
const mainHash = "24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc"
const companionHash = "b5ce3a2a9d1c65389c5fb32fa2b734251b644929d039cf4867683d39a90b9630"
if (Object.values(info.binaries).some(binary => (binary as { sha256: string }).sha256 !== mainHash) ||
    info.binaries.baseline.codeModeHostSha256 !== companionHash) throw new Error("Unexpected benchmark executable")
await Bun.write(path.join(here, "source-manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(),
  files, executableSha256: mainHash, codeModeHostSha256: companionHash, settings,
  globalInstructionIsolationAuthorized: includeInstructions,
  historicalReference: "../codex-sol-repeats-20260906/source-manifest.json",
  note: "Current cleaned-source hashes, independently checked against the reviewed redaction snapshot; historical binary unchanged." }, null, 2) + "\n")

const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
const modes = ["baseline", "paper", "v2", "v3"]
const cells = Array.from({ length: 5 }, (_, repeat) => {
  const order = [...projects.slice(repeat), ...projects.slice(0, repeat)]
  return order.flatMap((project, position) => {
    const offset = (repeat + position) % 4
    return [...modes.slice(offset), ...modes.slice(0, offset)].map(mode => ({
      repetition: repeat + 1, project, mode, status: "pending", source: null as string | null,
      startedAt: null as string | null, endedAt: null as string | null,
    }))
  })
}).flat()
const state = { model: "gpt-6-astra", status: "preparing", plannedCells: 100, maxWorkers: 1,
  startedAt: new Date().toISOString(), endedAt: null as string | null,
  isolation: "pending", stopReason: null as string | null, cells }
async function save() {
  const next = path.join(here, "run.next.json")
  await Bun.write(next, JSON.stringify(state, null, 2) + "\n")
  await rename(next, path.join(here, "run.json"))
}
await save()
let interrupted = false
let active: ReturnType<typeof spawn> | undefined
let ledger: Awaited<ReturnType<typeof suspend>> | undefined
let killTimer: ReturnType<typeof setTimeout> | undefined
function stopGroup() {
  if (!active?.pid) return
  const pid = active.pid
  try { process.kill(-pid, "SIGTERM") } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
  if (!killTimer) killTimer = setTimeout(() => {
    if (active?.pid !== pid) return
    try { process.kill(-pid, "SIGKILL") } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }, 10000)
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {
  interrupted = true
  stopGroup()
})

try {
  ledger = await suspend(await discover(includeInstructions), path.join(homedir(), ".codex"))
  await Bun.write(path.join(privateDir, "isolation.json"), JSON.stringify({ ledger: path.join(ledger.directory, "ledger.json") }, null, 2))
  state.isolation = "suspended"
  state.status = "running"
  await save()
  console.log(JSON.stringify({ event: "isolated", roots: ledger.entries.length, planned: cells.length }))
  for (const cell of cells) {
    if (interrupted) throw new Error("Interrupted by signal")
    await assertSuspended(ledger)
    cell.status = "running"
    cell.startedAt = new Date().toISOString()
    await save()
    console.log(JSON.stringify({ event: "start", repetition: cell.repetition, project: cell.project, mode: cell.mode }))
    active = spawn("bun", [runner, "one", cell.project, cell.mode], { cwd: root, env, detached: true,
      stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    active.stdout!.on("data", chunk => stdout.push(Buffer.from(chunk)))
    active.stderr!.on("data", chunk => stderr.push(Buffer.from(chunk)))
    const outerTimeout = setTimeout(() => { interrupted = true; stopGroup() }, 1020000)
    const code = await new Promise<number | null>((resolve, reject) => {
      active!.once("error", reject)
      active!.once("close", code => resolve(code))
    }).finally(() => {
      clearTimeout(outerTimeout)
      if (killTimer) clearTimeout(killTimer)
      killTimer = undefined
    })
    active = undefined
    const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString()
    const label = `${cell.repetition}-${cell.project}-${cell.mode}`
    await Bun.write(path.join(privateDir, label + ".stdout.log"), out)
    await Bun.write(path.join(privateDir, label + ".stderr.log"), err)
    cell.endedAt = new Date().toISOString()
    if (code !== 0) { cell.status = "runner-error"; throw new Error("Runner process failed; inspect private diagnostics") }
    const summary = JSON.parse(out)
    const source = `.private/results/${summary.suite}/${summary.mode}/${summary.project}/summary.json`
    if (summary.model !== "gpt-6-astra" || summary.project !== cell.project) throw new Error("Unexpected outcome identity")
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
    await assertSuspended(ledger)
    await Bun.sleep(1200)
  }
  for (const [file, expected] of Object.entries(files)) if (await hash(path.join(root, file)) !== expected)
    throw new Error("Frozen source changed during campaign")
  state.status = "complete"
} catch (error) {
  state.status = interrupted ? "interrupted" : "needs-attention"
  state.stopReason = error instanceof Error ? error.message : "Unexpected orchestration error"
  stopGroup()
  console.log(JSON.stringify({ event: "stopped", reason: state.stopReason }))
} finally {
  state.endedAt = new Date().toISOString()
  if (ledger) {
    const receipt = await restore(path.join(ledger.directory, "ledger.json"))
    state.isolation = "restored"
    await Bun.write(path.join(here, "restoration.json"), JSON.stringify({ at: new Date().toISOString(), ...receipt }, null, 2) + "\n")
    console.log(JSON.stringify({ event: "restored", ...receipt }))
  }
  await save()
}
if (state.status !== "complete") process.exitCode = 1
