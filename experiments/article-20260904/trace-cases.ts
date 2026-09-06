import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const source = "experiments/skill-state/results/20260904T195726Z/skill-state-paper/http-kv/events.jsonl"
const command = "python3 -m py_compile server.py"
const events = (await Bun.file(path.join(root, source)).text()).split("\n").filter(Boolean).map(JSON.parse)
const steps = events.filter((e) => e.type === "tool_use" && e.part?.state?.metadata?.skillState).map((e) => {
  const s = e.part.state
  const m = s.metadata.skillState
  return { revision: m.revision, name: m.action?.name, command: m.action?.input?.command,
    exit: s.metadata.exit, output: s.output, patch: m.patch }
})
const repeated = steps.filter((s) => s.command === command)
if (repeated.length !== 21 || repeated.some((s, i) => s.revision !== 22 + i || s.exit !== 0 || s.output !== "(no output)"))
  throw new Error("The proposed article example no longer matches its trace")
const modes = ["baseline", "skill-state-paper", "skill-state", "skill-state-v3"]
const outcomes = []
for (const mode of modes) {
  const summaryPath = `experiments/skill-state/results/20260904T195726Z/${mode}/http-kv/summary.json`
  const s = await Bun.file(path.join(root, summaryPath)).json()
  outcomes.push({ mode, source: summaryPath, checks: `${s.evaluation.passed}/${s.evaluation.total}`,
    calls: s.metrics.turns, input: s.metrics.input + s.metrics.cacheRead + s.metrics.cacheWrite,
    exit: s.exitCode, timedOut: s.timedOut, finishCalls: s.metrics.finishCalls })
}
const emptyFolder = "experiments/codex-skill-state/results/20260904T223606Z/skill-state-paper/http-kv"
const emptySummary = await Bun.file(path.join(root, emptyFolder, "summary.json")).json()
const emptyArchive = await Bun.file(path.join(root, emptyFolder, "workspace-manifest.json")).json()
const emptyCalls = []
for (const line of (await Bun.file(path.join(root, emptyFolder, "rollout.jsonl")).text()).split("\n")) {
  if (!line.trim()) continue
  const e = JSON.parse(line)
  if (e.type !== "response_item" || e.payload.type !== "function_call" || !e.payload.name.endsWith("skill_step")) continue
  const action = JSON.parse(e.payload.arguments).action
  emptyCalls.push({ name: action.name, command: String(action.input?.command ?? action.input?.cmd ?? "") })
}
if (emptyArchive.files.length || emptyArchive.skipped.length || emptySummary.evaluation.passed !== 0 ||
    !emptySummary.timedOut || emptySummary.metrics.samples !== 106 || emptyCalls.length !== 106)
  throw new Error("Empty-workspace article example changed")
const emptyWorkspace = {
  source: `${emptyFolder}/summary.json`, archive: `${emptyFolder}/workspace-manifest.json`,
  calls: emptyCalls.length, files: 0, checks: "0/9", timedOut: true,
  execCalls: emptyCalls.filter((c) => c.name === "exec_command").length,
  callsContainingFileInventory: emptyCalls.filter((c) => c.command.includes("rg --files")).length,
  lastCommands: emptyCalls.slice(-5).map((c) => c.command.slice(0, 200)),
  evaluatorError: emptySummary.evaluation.checks[0].detail,
  limits: "No files were present after the run; 0/9 is the harness score for failure to start, not nine independent implementation defects.",
}
await Bun.write(path.join(import.meta.dir, "trace-cases.json"), JSON.stringify({
  case: "Repeated silent successful compile in a valid Paper run",
  source, outcomes,
  sequence: repeated.map(({ revision, command, exit, output }) => ({ revision, command, exit, output })),
  nextSteps: steps.filter((s) => s.revision >= 43).map(({ revision, name, command, exit, output }) => ({
    revision, name, command: command?.slice(0, 100), exit, output: output?.slice(0, 150),
  })),
  limits: "The shell command repeats, not necessarily every parameter (timeout varies). This is an illustrative trajectory, not a controlled causal test. All four complete outcomes are retained.",
  emptyWorkspace,
}, null, 2) + "\n")
console.log(JSON.stringify({ verifiedRepeatedCommands: repeated.length, outcomes, emptyWorkspace }, null, 2))
