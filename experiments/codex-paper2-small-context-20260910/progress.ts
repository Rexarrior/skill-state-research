import path from "node:path"

const here = import.meta.dir
const continuation = Bun.file(path.join(here, "run-resume-1.json"))
const file = await continuation.exists() ? continuation : Bun.file(path.join(here, "run.json"))
if (!await file.exists()) {
  console.log(JSON.stringify({ status: "not-started" }))
  process.exit(0)
}
const run = await file.json()
const groups = []
for (const model of run.models) {
  const cells = run.cells.filter((c: { model: string }) => c.model === model)
  const summaries = await Promise.all(cells.filter((c: { status: string }) => c.status === "complete")
    .map(async (c: { source: string }) => {
      const summary = await Bun.file(path.join(here, c.source)).json()
      const audit = Bun.file(path.join(here, path.dirname(c.source), "protocol-audit.json"))
      return { ...summary, acceptedFinish: await audit.exists() ? (await audit.json()).acceptedFinish : false }
    }))
  groups.push({ model, planned: cells.length, complete: summaries.length,
    running: cells.filter((c: { status: string }) => c.status === "running").length,
    input: summaries.reduce((sum, s) => sum + s.metrics.input, 0),
    calls: summaries.reduce((sum, s) => sum + s.metrics.samples, 0),
    timeouts: summaries.filter(s => s.timedOut).length,
    artifactPasses: summaries.filter(s => s.evaluation.passed === s.evaluation.total).length,
    fullSuccess: summaries.filter(s => s.evaluation.passed === s.evaluation.total &&
      !s.timedOut && s.exitCode === 0 && s.acceptedFinish).length })
}
console.log(JSON.stringify({ status: run.status, isolation: run.isolation, stopReason: run.stopReason,
  continuation: run.continuation ?? 0, priorInterruptedAttempts: run.priorInterruptedAttempts ?? 0,
  startedAt: run.startedAt, endedAt: run.endedAt, groups,
  note: "Preliminary raw evaluator scores plus accepted finish; final report must audit taskboard delete separately." }, null, 2))
