import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { evaluate } from "./evaluate"

const experiment = path.resolve(import.meta.dir, "..")
const repository = path.resolve(experiment, "../..")
const opencode = path.join(repository, "opencode/packages/opencode")
const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"] as const
const modes = ["baseline", "skill-state"] as const
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
type Mode = (typeof modes)[number]

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
        OPENCODE_EXPERIMENTAL_SKILL_STATE: mode === "skill-state" ? "true" : "false",
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
    observationWindow,
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
  const rows: string[] = []
  const comparedProjects = projects.filter((project) =>
    modes.every((mode) => summaries.some((item) => item.project === project && item.mode === mode)),
  )
  for (const project of comparedProjects) {
    const base = summaries.find((item) => item.project === project && item.mode === "baseline")!
    const skill = summaries.find((item) => item.project === project && item.mode === "skill-state")!
    const basePrompt = base.metrics.input + base.metrics.cacheRead
    const skillPrompt = skill.metrics.input + skill.metrics.cacheRead
    const savings = basePrompt === 0 ? 0 : 1 - skillPrompt / basePrompt
    rows.push(
      `| ${project} | ${base.evaluation.passed}/${base.evaluation.total} | ${skill.evaluation.passed}/${skill.evaluation.total} | ${number(basePrompt)} | ${number(skillPrompt)} | ${percent(savings)} | ${base.metrics.turns}/${skill.metrics.turns} | ${number(base.metrics.durationMs / 1000)}/${number(skill.metrics.durationMs / 1000)} |`,
    )
  }

  const total = (mode: Mode, field: keyof Metrics) =>
    summaries.filter((item) => item.mode === mode).reduce((sum, item) => sum + Number(item.metrics[field] ?? 0), 0)
  const maximum = (mode: Mode, field: keyof Metrics) =>
    Math.max(0, ...summaries.filter((item) => item.mode === mode).map((item) => Number(item.metrics[field] ?? 0)))
  const score = (mode: Mode) =>
    summaries.filter((item) => item.mode === mode).reduce((sum, item) => sum + item.evaluation.passed, 0)
  const possible = (mode: Mode) =>
    summaries.filter((item) => item.mode === mode).reduce((sum, item) => sum + item.evaluation.total, 0)
  const basePrompt = total("baseline", "input") + total("baseline", "cacheRead")
  const skillPrompt = total("skill-state", "input") + total("skill-state", "cacheRead")
  const savings = basePrompt === 0 ? 0 : 1 - skillPrompt / basePrompt

  const body = `# One-shot A/B results

Suite: \`${suite}\`

Model: \`${model}\`

Observation window: \`k=${observationWindow}\`

Design: one independent run per project and mode; one user prompt per run; sequential execution.

| Project | Baseline score | SKILL.state score | Baseline prompt tokens¹ | SKILL.state prompt tokens¹ | Savings | Turns B/S | Seconds B/S |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows.join("\n")}
| **Total** | **${score("baseline")}/${possible("baseline")}** | **${score("skill-state")}/${possible("skill-state")}** | **${number(basePrompt)}** | **${number(skillPrompt)}** | **${percent(savings)}** | **${total("baseline", "turns")}/${total("skill-state", "turns")}** | **${number(total("baseline", "durationMs") / 1000)}/${number(total("skill-state", "durationMs") / 1000)}** |

¹ Prompt tokens are provider-reported \`input + cache.read\`. Raw counters are retained in each cell's \`summary.json\`.

## Aggregate counters

| Metric | Baseline | SKILL.state |
|---|---:|---:|
| Input | ${number(total("baseline", "input"))} | ${number(total("skill-state", "input"))} |
| Cache read | ${number(total("baseline", "cacheRead"))} | ${number(total("skill-state", "cacheRead"))} |
| Cache write | ${number(total("baseline", "cacheWrite"))} | ${number(total("skill-state", "cacheWrite"))} |
| Output | ${number(total("baseline", "output"))} | ${number(total("skill-state", "output"))} |
| Reasoning | ${number(total("baseline", "reasoning"))} | ${number(total("skill-state", "reasoning"))} |
| Tool calls | ${number(total("baseline", "toolCalls"))} | ${number(total("skill-state", "toolCalls"))} |
| SKILL.state calls | 0 | ${number(total("skill-state", "stateCalls"))} |
| State-tool errors | 0 | ${number(total("skill-state", "stateErrors"))} |
| State comments | 0 | ${number(total("skill-state", "stateComments"))} |
| Finish calls | 0 | ${number(total("skill-state", "finishCalls"))} |
| Consecutive repeated actions | 0 | ${number(total("skill-state", "repeatedActions"))} |
| Maximum repeat streak | 0 | ${number(maximum("skill-state", "maxRepeatStreak"))} |
| Maximum state bytes | 0 | ${number(maximum("skill-state", "maxStateBytes"))} |
| Provider-reported cost | ${number(total("baseline", "cost"))} | ${number(total("skill-state", "cost"))} |

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

const [action = "doctor", arg1, arg2] = process.argv.slice(2)
if (action === "doctor") {
  await doctor()
} else if (action === "one") {
  if (!projects.includes(arg1 as Project) || !modes.includes(arg2 as Mode)) {
    throw new Error(`usage: bun run.ts one <${projects.join("|")}> <${modes.join("|")}>`)
  }
  const suite = suiteID()
  const summary = await runCell(arg1 as Project, arg2 as Mode, suite)
  console.log(JSON.stringify(summary, null, 2))
} else if (action === "all") {
  const suite = suiteID()
  const order: [Project, Mode][] = projects.flatMap((project, index) =>
    index % 2 === 0
      ? [
          [project, "baseline"],
          [project, "skill-state"],
        ]
      : [
          [project, "skill-state"],
          [project, "baseline"],
        ],
  )
  const summaries = []
  for (const [project, mode] of order) summaries.push(await runCell(project, mode, suite))
  await report(suite, summaries)
  console.log(JSON.stringify({ suite, report: path.join(experiment, "results", suite, "report.md") }, null, 2))
} else if (action === "pair") {
  if (!projects.includes(arg1 as Project)) {
    throw new Error(`usage: bun run.ts pair <${projects.join("|")}>`)
  }
  const suite = suiteID()
  const summaries = [
    await runCell(arg1 as Project, "baseline", suite),
    await runCell(arg1 as Project, "skill-state", suite),
  ]
  await report(suite, summaries)
  console.log(JSON.stringify({ suite, report: path.join(experiment, "results", suite, "report.md") }, null, 2))
} else if (action === "report") {
  if (!arg1) throw new Error("usage: bun run.ts report SUITE")
  const summaries = []
  for (const project of projects) {
    for (const mode of modes) {
      const file = path.join(experiment, "results", arg1, mode, project, "summary.json")
      try {
        summaries.push(JSON.parse(await readFile(file, "utf8")))
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
    }
  }
  if (!summaries.length) throw new Error(`suite has no summaries: ${arg1}`)
  await report(arg1, summaries)
  console.log(JSON.stringify({ suite: arg1, report: path.join(experiment, "results", arg1, "report.md") }, null, 2))
} else {
  throw new Error("usage: bun run.ts doctor|all|pair PROJECT|one PROJECT MODE|report SUITE")
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
