import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"

const here = import.meta.dir
const root = path.resolve(here, "../..")
const results = path.join(root, "experiments/codex-skill-state/results")
const runner = "experiments/codex-skill-state/scripts/run.ts"
const env = { ...process.env, CODEX_SKILL_STATE_MODEL: "gpt-5.6-sol",
  CODEX_SKILL_STATE_MAX_CONCURRENCY: "1", CODEX_SKILL_STATE_OBSERVATION_WINDOW: "3",
  CODEX_SKILL_STATE_TIMEOUT_MS: "900000" }
if (await Bun.file(path.join(here, "run.json")).exists()) throw new Error("Series already exists; inspect run.json, do not overwrite or retry automatically")
const previousManifest = await Bun.file(path.join(root, "experiments/codex-sol-repeats-20260906/source-manifest.json")).json()
const digest = async (file: string) => new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const source = previousManifest.source
for (const [file, hash] of Object.entries(source.files))
  if (await digest(path.join(root, file)) !== hash) throw new Error(`Source differs from the audited campaign: ${file}`)
const doctor = Bun.spawn(["bun", runner, "doctor"], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
const [doctorText, doctorError, doctorExit] = await Promise.all([new Response(doctor.stdout).text(), new Response(doctor.stderr).text(), doctor.exited])
if (doctorExit) { await Bun.write(path.join(here, "doctor-stderr.log"), doctorError); throw new Error("Doctor failed; details saved locally") }
const binaries = JSON.parse(doctorText).binaries
if (binaries["skill-state"].sha256 !== "24f20642b36e3341bf23994e873b96e0dd43f5c986549998c0688f22a1a2d8bc" ||
    binaries["skill-state-paper"].sha256 !== binaries["skill-state"].sha256 ||
    binaries.baseline.sha256 !== previousManifest.binaries.baseline.sha256 ||
    binaries.baseline.codeModeHostSha256 !== previousManifest.binaries.baseline.codeModeHostSha256)
  throw new Error("Unexpected Codex binary")
const previousRun = await Bun.file(path.join(root, "experiments/codex-sol-repeats-20260906/run.json")).json()
if (previousRun.status !== "complete") throw new Error("Previous series must be complete")
const protectedFiles: Record<string, string> = {}
for (const pattern of ["articles/**/*", "experiments/article-20260904/**/*", "experiments/codex-sol-repeats-20260906/**/*",
  ...previousRun.attempts.map((a: { suite: string }) => `experiments/codex-skill-state/results/${a.suite}/**/*`)]) {
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true }))
    protectedFiles[file] = await digest(path.join(root, file))
}
await Bun.write(path.join(here, "source-manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(),
  source, binaries, protectedFiles, protocolSha256: await digest(path.join(here, "PROTOCOL.md")),
  orchestrationSha256: await digest(path.join(here, "run.ts")) }, null, 2) + "\n")
await mkdir(path.join(here, "logs"), { recursive: true })
const attempts = Array.from({ length: 10 }, (_, i) => ({ repetition: i + 1,
  modes: i % 2 ? ["paper", "baseline"] : ["baseline", "paper"], status: "pending", suite: null as string | null,
  worker: null as number | null, startedAt: null as string | null, endedAt: null as string | null,
  exitCode: null as number | null }))
const state = { startedAt: new Date().toISOString(), endedAt: null as string | null, status: "running",
  plannedCells: 100, maxWorkers: 5, pid: process.pid, attempts }
let saveQueue = Promise.resolve()
const save = () => saveQueue = saveQueue.then(async () => { await Bun.write(path.join(here, "run.json"), JSON.stringify(state, null, 2) + "\n") })
await save()
let next = 0, stopped = false, startQueue = Promise.resolve()
const active = new Set<ReturnType<typeof Bun.spawn>>()
async function launch(a: typeof attempts[number]) {
  let release!: () => void
  const previous = startQueue
  startQueue = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    if (stopped) throw new Error("Dispatch stopped")
    const before = new Set(await readdir(results))
    const child = Bun.spawn(["bun", runner, "all", ...a.modes], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    active.add(child)
    const completion = (async () => {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      await Bun.write(path.join(here, `logs/attempt-${a.repetition}.stdout.log`), out)
      await Bun.write(path.join(here, `logs/attempt-${a.repetition}.stderr.log`), err)
      return { out, code }
    })()
    const deadline = Date.now() + 180_000
    while (!a.suite) {
      const created = (await readdir(results)).filter((name) => /^\d{8}T\d{6}Z$/.test(name) && !before.has(name))
      if (created.length > 1) throw new Error("Ambiguous suite discovery; unrelated runner may be active")
      if (created.length === 1) { a.suite = created[0]; await save(); break }
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("Runner did not create a uniquely identified suite")
      await Bun.sleep(250)
    }
    // The legacy suite identifier has second precision. Serialize discovery and leave a safe second gap.
    await Bun.sleep(1200)
    return { child, completion }
  } finally { release() }
}
async function worker(id: number) {
  while (!stopped) {
    const a = attempts[next++]
    if (!a) return
    a.worker = id; a.status = "running"; a.startedAt = new Date().toISOString(); await save()
    try {
      const { child, completion } = await launch(a)
      console.log(JSON.stringify({ event: "started", repetition: a.repetition, worker: id, suite: a.suite, modes: a.modes }))
      const result = await completion
      active.delete(child)
      a.exitCode = result.code
      if (result.code !== 0) throw new Error("Runner failed; model outcomes are in any completed summaries")
      const final = JSON.parse(result.out)
      if (final.suite !== a.suite) throw new Error("Suite discovery mismatch")
      a.status = "complete"
    } catch (error) {
      a.status = "runner-error"; stopped = true
      console.log(JSON.stringify({ event: "runner-error", repetition: a.repetition, message: String(error) }))
    }
    a.endedAt = new Date().toISOString(); await save()
    console.log(JSON.stringify({ event: "finished", repetition: a.repetition, suite: a.suite, status: a.status }))
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  stopped = true; state.status = "interrupted"
  for (const child of active) child.kill("SIGTERM")
  void save()
})
await Promise.all(Array.from({ length: 5 }, (_, i) => worker(i + 1)))
state.status = attempts.every((a) => a.status === "complete") ? "complete" : "needs-attention"
state.endedAt = new Date().toISOString(); await save()
console.log(JSON.stringify({ status: state.status, attempts: attempts.filter((a) => a.status === "complete").length }))
if (state.status !== "complete") process.exitCode = 1

