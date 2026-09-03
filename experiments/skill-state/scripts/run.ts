import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { evaluate } from "./evaluate"

const experiment = path.resolve(import.meta.dir, "..")
const repository = path.resolve(experiment, "../..")
const opencode = path.join(repository, "opencode/packages/opencode")
const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"] as const
const modes = ["baseline", "skill-state"] as const
const runnableModes = [...modes, "skill-state-paper"] as const
const modeNames = ["baseline", "paper", "v2"] as const
const expectedChecks: Record<Project, number> = {
  "taskboard-cli": 8,
  "csv-insights": 8,
  "mini-template": 8,
  "http-kv": 9,
  "dependency-planner": 7,
}
const model = process.env.OPENCODE_SKILL_STATE_MODEL?.trim() || "openrouter-yandex-team/z-ai/glm-5.2"
const observationWindow = (() => {
  const raw = process.env.OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW?.trim()
  if (!raw) return 3
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error("OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW must be an integer from 1 to 8")
  }
  return value
})()
const prompt = (await readFile(path.join(experiment, "prompts/one-shot.txt"), "utf8")).trim()
const cellTimeoutMs = 15 * 60 * 1000

type Project = (typeof projects)[number]
type Mode = (typeof runnableModes)[number]
type ModeName = (typeof modeNames)[number]

function parseMode(value: string): Mode {
  if (value === "baseline") return "baseline"
  if (value === "paper" || value === "skill-state-paper") return "skill-state-paper"
  if (value === "v2" || value === "skill-state") return "skill-state"
  throw new Error(`unknown mode ${JSON.stringify(value)}; expected ${modeNames.join("|")}`)
}

function runtimeMode(mode: Mode): ModeName {
  if (mode === "skill-state-paper") return "paper"
  if (mode === "skill-state") return "v2"
  return "baseline"
}

function modeLabel(mode: Mode) {
  return runtimeMode(mode) === "v2" ? "V2" : runtimeMode(mode)[0]!.toUpperCase() + runtimeMode(mode).slice(1)
}

type Metrics = {
  sessionID?: string
  turns: number
  toolCalls: number
  stateCalls: number
  stateErrors: number
  stateComments: number
  finishCalls: number
  repeatedActions: number
  maxRepeatStreak: number
  maxStateBytes: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  durationMs: number
}

function suiteID() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
}

function config() {
  return JSON.stringify({
    permission: {
      "*": "allow",
      external_directory: "deny",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      question: "deny",
    },
    tools: { webfetch: false, websearch: false, task: false },
    agent: {
      build: { steps: 80, temperature: 0 },
      general: { steps: 80, temperature: 0 },
    },
  })
}

function parseEvents(raw: string, durationMs: number): Metrics {
  const result: Metrics = {
    turns: 0,
    toolCalls: 0,
    stateCalls: 0,
    stateErrors: 0,
    stateComments: 0,
    finishCalls: 0,
    repeatedActions: 0,
    maxRepeatStreak: 0,
    maxStateBytes: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    durationMs,
  }
  let previousAction: string | undefined
  let repeatStreak = 0
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event.sessionID === "string") result.sessionID = event.sessionID
    if (event.type === "step_finish") {
      result.turns++
      result.input += event.part?.tokens?.input ?? 0
      result.output += event.part?.tokens?.output ?? 0
      result.reasoning += event.part?.tokens?.reasoning ?? 0
      result.cacheRead += event.part?.tokens?.cache?.read ?? 0
      result.cacheWrite += event.part?.tokens?.cache?.write ?? 0
      result.cost += event.part?.cost ?? 0
    }
    if (event.type === "tool_use") {
      result.toolCalls++
      if (event.part?.tool === "skill_step") {
        result.stateCalls++
        if (event.part?.state?.status === "error") result.stateErrors++
        const metadata = event.part?.state?.metadata?.skillState
        result.maxStateBytes = Math.max(result.maxStateBytes, metadata?.stateBytes ?? 0)
        if (typeof metadata?.comment === "string") result.stateComments++
        if (metadata?.actionStatus === "finish") result.finishCalls++
        if (metadata?.action && typeof metadata.action.name === "string") {
          const action = JSON.stringify(metadata.action)
          if (action === previousAction) {
            result.repeatedActions++
            repeatStreak++
          } else {
            previousAction = action
            repeatStreak = 1
          }
          result.maxRepeatStreak = Math.max(result.maxRepeatStreak, repeatStreak)
        }
      }
    }
  }
  return result
}

async function runCell(project: Project, mode: Mode, suite: string) {
  const workspace = path.join(tmpdir(), "opencode-skill-state-one-shot", suite, mode, project)
  const resultDir = path.join(experiment, "results", suite, mode, project)
  const specification = path.join(experiment, "projects", project, "SPEC.md")
  await mkdir(workspace, { recursive: true })
  await mkdir(resultDir, { recursive: true })

  console.error(`[${project}/${mode}] starting`)
  const start = performance.now()
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--conditions=browser",
      "./src/index.ts",
      "run",
      prompt,
      "--format",
      "json",
      "--model",
      model,
      "--file",
      specification,
      "--agent",
      "build",
      "--dir",
      workspace,
      "--title",
      `skill-state-ab-${suite}-${mode}-${project}`,
      "--auto",
    ],
    {
      cwd: opencode,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: config(),
        OPENCODE_SKILL_STATE_MODE: runtimeMode(mode),
        OPENCODE_EXPERIMENTAL_SKILL_STATE_OBSERVATION_WINDOW: String(observationWindow),
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill("SIGTERM")
  }, cellTimeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timeout)
  const durationMs = Math.round(performance.now() - start)
  const metrics = parseEvents(stdout, durationMs)
  await writeFile(path.join(resultDir, "events.jsonl"), stdout)
  await writeFile(path.join(resultDir, "stderr.log"), stderr)

  let evaluation
  try {
    evaluation = await evaluate(project, workspace)
  } catch (error) {
    evaluation = {
      project,
      passed: 0,
      total: expectedChecks[project],
      score: 0,
      checks: [{ name: "evaluator completed", passed: false, detail: String(error) }],
    }
  }
  const summary = {
    suite,
    project,
    mode,
    model,
    observationWindow: mode === "skill-state" ? observationWindow : undefined,
    protocolMode: runtimeMode(mode),
    prompt,
    exitCode,
    timedOut,
    cellTimeoutMs,
    workspace,
    metrics,
    evaluation,
  }
  await writeFile(path.join(resultDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
  console.error(
    `[${project}/${mode}] done exit=${exitCode} score=${evaluation.passed}/${evaluation.total} turns=${metrics.turns} input=${metrics.input} cacheRead=${metrics.cacheRead}`,
  )
  return summary
}

function number(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

async function report(suite: string, summaries: Awaited<ReturnType<typeof runCell>>[]) {
  const selectedModes = runnableModes.filter((mode) => summaries.some((item) => item.mode === mode))
  const comparedProjects = projects.filter((project) =>
    selectedModes.every((mode) => summaries.some((item) => item.project === project && item.mode === mode)),
  )
  const total = (mode: Mode, field: keyof Metrics) =>
    summaries.filter((item) => item.mode === mode).reduce((sum, item) => sum + Number(item.metrics[field] ?? 0), 0)
  const maximum = (mode: Mode, field: keyof Metrics) =>
    Math.max(0, ...summaries.filter((item) => item.mode === mode).map((item) => Number(item.metrics[field] ?? 0)))
  const score = (mode: Mode) =>
    summaries.filter((item) => item.mode === mode).reduce((sum, item) => sum + item.evaluation.passed, 0)
  const possible = (mode: Mode) =>
    summaries.filter((item) => item.mode === mode).reduce((sum, item) => sum + item.evaluation.total, 0)
  const promptTokens = (mode: Mode) => total(mode, "input") + total(mode, "cacheRead")
  const headers = selectedModes.flatMap((mode) => [`${modeLabel(mode)} score`, `${modeLabel(mode)} prompt`, "Turns"])
  const rows = comparedProjects.map((project) => {
    const cells = selectedModes.flatMap((mode) => {
      const item = summaries.find((summary) => summary.project === project && summary.mode === mode)!
      return [
        `${item.evaluation.passed}/${item.evaluation.total}`,
        number(item.metrics.input + item.metrics.cacheRead),
        String(item.metrics.turns),
      ]
    })
    return `| ${project} | ${cells.join(" | ")} |`
  })
  const totals = selectedModes.flatMap((mode) => [
    `${score(mode)}/${possible(mode)}`,
    number(promptTokens(mode)),
    number(total(mode, "turns")),
  ])
  const aggregateMetrics: [string, keyof Metrics, "total" | "maximum"][] = [
    ["Input", "input", "total"],
    ["Cache read", "cacheRead", "total"],
    ["Cache write", "cacheWrite", "total"],
    ["Output", "output", "total"],
    ["Reasoning", "reasoning", "total"],
    ["Tool calls", "toolCalls", "total"],
    ["SKILL.state calls", "stateCalls", "total"],
    ["State-tool errors", "stateErrors", "total"],
    ["State comments", "stateComments", "total"],
    ["Finish calls", "finishCalls", "total"],
    ["Consecutive repeated actions", "repeatedActions", "total"],
    ["Maximum repeat streak", "maxRepeatStreak", "maximum"],
    ["Maximum state bytes", "maxStateBytes", "maximum"],
    ["Provider-reported cost", "cost", "total"],
  ]
  const aggregateRows = aggregateMetrics.map(([label, field, aggregation]) => {
    const values = selectedModes.map((mode) =>
      number(aggregation === "maximum" ? maximum(mode, field) : total(mode, field)),
    )
    return `| ${label} | ${values.join(" | ")} |`
  })
  const baselinePrompt = selectedModes.includes("baseline") ? promptTokens("baseline") : 0
  const comparisonRows = selectedModes
    .filter((mode) => mode !== "baseline")
    .map((mode) => {
      const change = baselinePrompt === 0 ? 0 : 1 - promptTokens(mode) / baselinePrompt
      return `| ${modeLabel(mode)} | ${number(promptTokens(mode))} | ${percent(change)} |`
    })

  const body = `# One-shot multimode results

Suite: \`${suite}\`

Model: \`${model}\`

Selected modes: ${selectedModes.map((mode) => `\`${runtimeMode(mode)}\``).join(", ")}

Design: one independent run per project and mode; one user prompt per run; sequential execution.

| Project | ${headers.join(" | ")} |
|---|${headers.map(() => "---:").join("|")}|
${rows.join("\n")}
| **Total** | ${totals.map((value) => `**${value}**`).join(" | ")} |

¹ Prompt tokens are provider-reported \`input + cache.read\`. Raw counters are retained in each cell's \`summary.json\`.

## Prompt-token change from baseline

| Mode | Prompt tokens | Reduction |
|---|---:|---:|
${comparisonRows.join("\n") || "| — | — | — |"}

## Aggregate counters

| Metric | ${selectedModes.map(modeLabel).join(" | ")} |
|---|${selectedModes.map(() => "---:").join("|")}|
${aggregateRows.join("\n")}

## Interpretation guardrails

- This is an exploratory \`n=1\` run per cell. Model variance can easily dominate small differences.
- The two implementations share the same OpenCode checkout, model, agent settings, prompt, permissions, and externally
  materialized specification. The experimental cells switch only the core prompt/action runtime.
- Quality is measured by black-box evaluators that were outside the model-visible run directory.
- A token reduction is useful only when evaluator quality is comparable; inspect failed checks before drawing a conclusion.

Raw events, stderr, summaries, and the generated workspaces are recorded under \`experiments/skill-state/results/${suite}/\`
and the workspace paths named in each summary.
`
  await writeFile(path.join(experiment, "results", suite, "report.md"), body)
}

async function doctor() {
  for (const project of projects) await readFile(path.join(experiment, "projects", project, "SPEC.md"), "utf8")
  await readFile(path.join(opencode, "src/session/skill-state.ts"), "utf8")
  const probe = await import("./evaluate")
  if (typeof probe.evaluate !== "function") throw new Error("evaluator import failed")
  console.log(JSON.stringify({ ok: true, model, observationWindow, projects, prompt, runtime: "core" }, null, 2))
}

const [action = "doctor", ...args] = process.argv.slice(2)
if (action === "doctor") {
  await doctor()
} else if (action === "one") {
  const [project, requestedMode] = args
  if (!projects.includes(project as Project) || !requestedMode) {
    throw new Error(`usage: bun run.ts one <${projects.join("|")}> <${modeNames.join("|")}>`)
  }
  const suite = suiteID()
  const summary = await runCell(project as Project, parseMode(requestedMode), suite)
  console.log(JSON.stringify(summary, null, 2))
} else if (action === "all") {
  const selectedModes = args.length ? args.map(parseMode) : [...modes]
  if (new Set(selectedModes).size !== selectedModes.length) throw new Error("modes must be unique")
  const suite = suiteID()
  const order: [Project, Mode][] = projects.flatMap((project, index) => {
    const offset = index % selectedModes.length
    return [...selectedModes.slice(offset), ...selectedModes.slice(0, offset)].map(
      (mode) => [project, mode] as [Project, Mode],
    )
  })
  const summaries = []
  for (const [project, mode] of order) summaries.push(await runCell(project, mode, suite))
  await report(suite, summaries)
  console.log(JSON.stringify({ suite, report: path.join(experiment, "results", suite, "report.md") }, null, 2))
} else if (action === "pair") {
  const [project, requestedMode = "v2"] = args
  if (!projects.includes(project as Project)) {
    throw new Error(`usage: bun run.ts pair <${projects.join("|")}> [paper|v2]`)
  }
  const selectedMode = parseMode(requestedMode)
  if (selectedMode === "baseline") throw new Error("pair comparison mode must be paper or v2")
  const suite = suiteID()
  const summaries = [
    await runCell(project as Project, "baseline", suite),
    await runCell(project as Project, selectedMode, suite),
  ]
  await report(suite, summaries)
  console.log(JSON.stringify({ suite, report: path.join(experiment, "results", suite, "report.md") }, null, 2))
} else if (action === "report") {
  const [targetSuite] = args
  if (!targetSuite) throw new Error("usage: bun run.ts report SUITE")
  const summaries = []
  for (const project of projects) {
    for (const mode of runnableModes) {
      const file = path.join(experiment, "results", targetSuite, mode, project, "summary.json")
      try {
        summaries.push(JSON.parse(await readFile(file, "utf8")))
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
    }
  }
  if (!summaries.length) throw new Error(`suite has no summaries: ${targetSuite}`)
  await report(targetSuite, summaries)
  console.log(
    JSON.stringify({ suite: targetSuite, report: path.join(experiment, "results", targetSuite, "report.md") }, null, 2),
  )
} else {
  throw new Error("usage: bun run.ts doctor|all [MODES...]|pair PROJECT [paper|v2]|one PROJECT MODE|report SUITE")
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
