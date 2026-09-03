import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { evaluate } from "../../skill-state/scripts/evaluate"

const experiment = path.resolve(import.meta.dir, "..")
const repository = path.resolve(experiment, "../..")
const fixtures = path.join(repository, "experiments/skill-state")
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

const model = process.env.CODEX_SKILL_STATE_MODEL?.trim() || "gpt-5.6-luna"
const observationWindow = readObservationWindow()
const maxConcurrency = readInteger("CODEX_SKILL_STATE_MAX_CONCURRENCY", 2, 1, 2)
const cellTimeoutMs = readInteger("CODEX_SKILL_STATE_TIMEOUT_MS", 15 * 60 * 1000, 30_000, 30 * 60 * 1000)
const stateBinary =
  process.env.CODEX_SKILL_STATE_BINARY?.trim() || path.join(repository, "codex/codex-rs/target/debug/codex")
const baselineBinary = process.env.CODEX_BASELINE_BINARY?.trim() || stateBinary
const baselineSource =
  process.env.CODEX_BASELINE_SOURCE?.trim() ||
  (baselineBinary === stateBinary ? "baseline runtime mode in the same research binary" : "separate baseline binary")
const oneShotInstruction = (
  await readFile(path.join(fixtures, "prompts/one-shot.txt"), "utf8")
).trim()

type Usage = {
  input: number
  cachedInput: number
  cacheWriteInput: number
  output: number
  reasoning: number
  total: number
  samples: number
}

type Metrics = Usage & {
  threadID?: string
  commandExecutions: number
  fileChanges: number
  errors: number
  stateCalls: number
  stateErrors: number
  stateComments: number
  finishCalls: number
  repeatedActions: number
  maxRepeatStreak: number
  maxStateBytes: number
  durationMs: number
}

type BinaryInfo = {
  path: string
  version: string
  sha256: string
}

function readObservationWindow() {
  return readInteger("CODEX_SKILL_STATE_OBSERVATION_WINDOW", 3, 1, 8)
}

function readInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function suiteID() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
}

function promptFor(specification: string) {
  return `${oneShotInstruction}\n\n<specification>\n${specification.trim()}\n</specification>`
}

async function runCommand(argv: string[], cwd: string, timeoutMs = 20_000) {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => proc.kill("SIGTERM"), timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timeout))
  return { stdout, stderr, exitCode }
}

async function binaryInfo(binary: string): Promise<BinaryInfo> {
  await stat(binary)
  const [version, digest, execHelp] = await Promise.all([
    runCommand([binary, "--version"], repository),
    runCommand(["shasum", "-a", "256", binary], repository, 60_000),
    runCommand([binary, "exec", "--help"], repository),
  ])
  if (version.exitCode !== 0) throw new Error(`cannot execute ${binary}: ${version.stderr}`)
  if (digest.exitCode !== 0) throw new Error(`cannot hash ${binary}: ${digest.stderr}`)
  if (execHelp.exitCode !== 0 || !execHelp.stdout.includes("--approve-for-me")) {
    throw new Error(`${binary} does not support the sandboxed --approve-for-me benchmark contract`)
  }
  return {
    path: path.resolve(binary),
    version: version.stdout.trim(),
    sha256: digest.stdout.trim().split(/\s+/)[0] ?? "",
  }
}

function blankMetrics(durationMs: number): Metrics {
  return {
    input: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    samples: 0,
    commandExecutions: 0,
    fileChanges: 0,
    errors: 0,
    stateCalls: 0,
    stateErrors: 0,
    stateComments: 0,
    finishCalls: 0,
    repeatedActions: 0,
    maxRepeatStreak: 0,
    maxStateBytes: 0,
    durationMs,
  }
}

function parseCLIEvents(raw: string, durationMs: number): Metrics {
  const metrics = blankMetrics(durationMs)
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") metrics.threadID = event.thread_id
    if (event.type === "item.completed") {
      if (event.item?.type === "command_execution") metrics.commandExecutions++
      if (event.item?.type === "file_change") metrics.fileChanges++
      if (event.item?.type === "error") metrics.errors++
    }
    if (event.type === "turn.completed" && event.usage) {
      metrics.input = event.usage.input_tokens ?? 0
      metrics.cachedInput = event.usage.cached_input_tokens ?? 0
      metrics.cacheWriteInput = event.usage.cache_write_input_tokens ?? 0
      metrics.output = event.usage.output_tokens ?? 0
      metrics.reasoning = event.usage.reasoning_output_tokens ?? 0
      metrics.total = metrics.input + metrics.output
    }
  }
  return metrics
}

function parseRollout(raw: string, metrics: Metrics) {
  let previousAction: string | undefined
  let repeatStreak = 0
  let latestUsage: any

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === "token_usage_record") {
      metrics.samples++
      latestUsage = event.payload?.thread_token_usage ?? event.payload?.usage
    }
    const item = event.type === "response_item" ? event.payload : undefined
    if (item?.type !== "function_call_output" || item.name !== "skill_step") continue
    metrics.stateCalls++
    let transition: any
    try {
      transition = JSON.parse(typeof item.output === "string" ? item.output : "")
    } catch {
      metrics.stateErrors++
      continue
    }
    const observation = transition.observation
    if (observation?.status === "error") metrics.stateErrors++
    if (typeof observation?.comment === "string" && observation.comment.trim()) metrics.stateComments++
    if (observation?.action === "finish") metrics.finishCalls++
    metrics.maxStateBytes = Math.max(metrics.maxStateBytes, Buffer.byteLength(JSON.stringify(transition.state ?? {})))
    if (typeof observation?.action === "string") {
      const action = JSON.stringify({ name: observation.action, input: observation.input })
      if (action === previousAction) {
        metrics.repeatedActions++
        repeatStreak++
      } else {
        previousAction = action
        repeatStreak = 1
      }
      metrics.maxRepeatStreak = Math.max(metrics.maxRepeatStreak, repeatStreak)
    }
  }

  if (latestUsage) {
    metrics.input = latestUsage.input_tokens ?? metrics.input
    metrics.cachedInput = latestUsage.cached_input_tokens ?? metrics.cachedInput
    metrics.cacheWriteInput = latestUsage.cache_write_input_tokens ?? metrics.cacheWriteInput
    metrics.output = latestUsage.output_tokens ?? metrics.output
    metrics.reasoning = latestUsage.reasoning_output_tokens ?? metrics.reasoning
    metrics.total = latestUsage.total_tokens ?? metrics.input + metrics.output
  }
}

async function locateRollout(threadID: string) {
  const sessions = path.join(process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"), "sessions")
  for (let attempt = 0; attempt < 10; attempt++) {
    const found = await runCommand(["find", sessions, "-type", "f", "-name", `*${threadID}*`], repository, 30_000)
    const candidate = found.stdout
      .split("\n")
      .map((item) => item.trim())
      .find(Boolean)
    if (candidate) return candidate
    await Bun.sleep(200)
  }
}

function codexArgs(binary: string, workspace: string, prompt: string) {
  return [
    binary,
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--disable",
    "skill_search",
    "-c",
    "skills.include_instructions=false",
    "-c",
    "skills.bundled.enabled=false",
    "-c",
    'model_reasoning_effort="medium"',
    "--approve-for-me",
    "-m",
    model,
    "-C",
    workspace,
    prompt,
  ]
}

async function runCell(project: Project, mode: Mode, suite: string, binaries: Record<Mode, BinaryInfo>) {
  const workspace = path.join(tmpdir(), "codex-skill-state-one-shot", suite, mode, project)
  const resultDir = path.join(experiment, "results", suite, mode, project)
  const specification = await readFile(path.join(fixtures, "projects", project, "SPEC.md"), "utf8")
  const prompt = promptFor(specification)
  await mkdir(workspace, { recursive: true })
  await mkdir(resultDir, { recursive: true })

  console.error(`[${project}/${mode}] starting`)
  const started = performance.now()
  const proc = Bun.spawn(codexArgs(binaries[mode].path, workspace, prompt), {
    cwd: repository,
    env: {
      ...process.env,
      CODEX_SKILL_STATE_MODE: runtimeMode(mode),
      CODEX_SKILL_STATE_OBSERVATION_WINDOW: String(observationWindow),
      NO_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let hardKill: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill("SIGTERM")
    hardKill = setTimeout(() => proc.kill("SIGKILL"), 10_000)
  }, cellTimeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timeout)
  if (hardKill) clearTimeout(hardKill)

  const metrics = parseCLIEvents(stdout, Math.round(performance.now() - started))
  await writeFile(path.join(resultDir, "events.jsonl"), stdout)
  await writeFile(path.join(resultDir, "stderr.log"), stderr)

  let rolloutPath: string | undefined
  if (metrics.threadID) {
    rolloutPath = await locateRollout(metrics.threadID)
    if (rolloutPath) {
      const rollout = await readFile(rolloutPath, "utf8")
      parseRollout(rollout, metrics)
      await copyFile(rolloutPath, path.join(resultDir, "rollout.jsonl"))
    }
  }

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
    oneShot: true,
    binary: binaries[mode],
    exitCode,
    timedOut,
    cellTimeoutMs,
    workspace,
    rolloutPath,
    metrics,
    evaluation,
  }
  await writeFile(path.join(resultDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
  console.error(
    `[${project}/${mode}] done exit=${exitCode} timeout=${timedOut} score=${evaluation.passed}/${evaluation.total} samples=${metrics.samples} input=${metrics.input}`,
  )
  return summary
}

async function mapLimited<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

function number(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

async function report(
  suite: string,
  summaries: Awaited<ReturnType<typeof runCell>>[],
  binaries: Record<Mode, BinaryInfo>,
  baselineSuite?: string,
) {
  const selectedModes = runnableModes.filter((mode) => summaries.some((item) => item.mode === mode))
  const compared = projects.filter((project) =>
    selectedModes.every((mode) => summaries.some((item) => item.project === project && item.mode === mode)),
  )
  const byMode = (mode: Mode) => summaries.filter((item) => item.mode === mode)
  const metric = (mode: Mode, field: keyof Metrics) =>
    byMode(mode).reduce((sum, item) => sum + Number(item.metrics[field] ?? 0), 0)
  const maximum = (mode: Mode, field: keyof Metrics) =>
    Math.max(0, ...byMode(mode).map((item) => Number(item.metrics[field] ?? 0)))
  const score = (mode: Mode) => byMode(mode).reduce((sum, item) => sum + item.evaluation.passed, 0)
  const possible = (mode: Mode) => byMode(mode).reduce((sum, item) => sum + item.evaluation.total, 0)
  const headers = selectedModes.flatMap((mode) => [
    `${modeLabel(mode)} score`,
    `${modeLabel(mode)} input`,
    "Samples",
    "Exit",
  ])
  const rows = compared.map((project) => {
    const cells = selectedModes.flatMap((mode) => {
      const item = summaries.find((summary) => summary.project === project && summary.mode === mode)!
      return [
        `${item.evaluation.passed}/${item.evaluation.total}`,
        number(item.metrics.input),
        String(item.metrics.samples),
        item.timedOut ? "timeout" : String(item.exitCode),
      ]
    })
    return `| ${project} | ${cells.join(" | ")} |`
  })
  const totals = selectedModes.flatMap((mode) => [
    `${score(mode)}/${possible(mode)}`,
    number(metric(mode, "input")),
    number(metric(mode, "samples")),
    "—",
  ])
  const aggregateMetrics: [string, keyof Metrics, "total" | "maximum"][] = [
    ["Input tokens", "input", "total"],
    ["Cached input tokens", "cachedInput", "total"],
    ["Output tokens", "output", "total"],
    ["Reasoning tokens", "reasoning", "total"],
    ["Provider samples", "samples", "total"],
    ["Command executions", "commandExecutions", "total"],
    ["File-change events", "fileChanges", "total"],
    ["CLI error events", "errors", "total"],
    ["State transitions", "stateCalls", "total"],
    ["State transition errors", "stateErrors", "total"],
    ["State comments", "stateComments", "total"],
    ["Finish transitions", "finishCalls", "total"],
    ["Consecutive repeated actions", "repeatedActions", "total"],
    ["Maximum repeat streak", "maxRepeatStreak", "maximum"],
    ["Maximum state bytes", "maxStateBytes", "maximum"],
  ]
  const aggregateRows = aggregateMetrics.map(([label, field, aggregation]) => {
    const values = selectedModes.map((mode) =>
      number(aggregation === "maximum" ? maximum(mode, field) : metric(mode, field)),
    )
    return `| ${label} | ${values.join(" | ")} |`
  })
  const baselineInput = selectedModes.includes("baseline") ? metric("baseline", "input") : 0
  const comparisonRows = selectedModes
    .filter((mode) => mode !== "baseline")
    .map((mode) => {
      const change = baselineInput === 0 ? 0 : 1 - metric(mode, "input") / baselineInput
      return `| ${modeLabel(mode)} | ${number(metric(mode, "input"))} | ${percent(change)} |`
    })
  const provenance = selectedModes
    .map(
      (mode) =>
        `- ${modeLabel(mode)}: \`${binaries[mode].version}\` at \`${binaries[mode].path}\`, SHA-256 \`${binaries[mode].sha256}\`.`,
    )
    .join("\n")

  const body = `# Codex CLI one-shot multimode results

Suite: \`${suite}\`

Model: \`${model}\` (reasoning effort: \`medium\`)

Selected modes: ${selectedModes.map((mode) => `\`${runtimeMode(mode)}\``).join(", ")}

Design: one independent one-shot run per project and mode; black-box evaluation; at most ${maxConcurrency} concurrent
CLI processes; ${number(cellTimeoutMs / 60_000)} minute timeout per cell. Skills, skill search, and user config were
disabled in every mode. All runs use \`--approve-for-me\`: model commands remain in the \`workspace-write\` sandbox while
the CLI's automatic reviewer handles safe edits. Every run starts in an empty temporary workspace. Baseline retains
the native transcript and Code Mode; state modes force direct tools to preserve one-patch/one-action atomicity.
${baselineSuite ? `\nBaseline cells were reused without rerunning from suite \`${baselineSuite}\`; state cells belong to this suite.\n` : ""}

| Project | ${headers.join(" | ")} |
|---|${headers.map(() => "---:").join("|")}|
${rows.join("\n")}
| **Total** | ${totals.map((value) => `**${value}**`).join(" | ")} |

¹ Codex's provider-reported \`input_tokens\`; \`cached_input_tokens\` is a subset and is not added again.

## Input-token change from baseline

| Mode | Input tokens | Reduction |
|---|---:|---:|
${comparisonRows.join("\n") || "| — | — | — |"}

## Aggregate counters

| Metric | ${selectedModes.map(modeLabel).join(" | ")} |
|---|${selectedModes.map(() => "---:").join("|")}|
${aggregateRows.join("\n")}

## Binary provenance

${provenance}

Baseline source: ${baselineSource}.

The prompt, model, reasoning effort, sandbox, fixtures, evaluator, and concurrency are held constant. Binary hashes and
source provenance are recorded so a suite can be rejected if the baseline is not the intended pristine revision.

## Interpretation guardrails

- This is an exploratory \`n=1\` run per cell; model variance can dominate small differences.
- Short code-generation tasks test quality and crossover overhead, not the paper's asymptotic long-horizon claim.
- A token reduction is useful only at comparable evaluator quality. Timeouts and non-zero exits must be treated as failed
  cells, not token savings.
- Each cell contains \`events.jsonl\`, \`stderr.log\`, \`summary.json\`, and, when persistence succeeds, the raw
  \`rollout.jsonl\` with auditable state transitions.

Generated workspace paths are recorded in each cell summary. State workspaces for this suite are under
\`${path.join(tmpdir(), "codex-skill-state-one-shot", suite)}\`.
`
  await writeFile(path.join(experiment, "results", suite, "report.md"), body)
}

async function inspectBinaries(): Promise<Record<Mode, BinaryInfo>> {
  return {
    baseline: await binaryInfo(baselineBinary),
    "skill-state": await binaryInfo(stateBinary),
    "skill-state-paper": await binaryInfo(stateBinary),
  }
}

async function doctor() {
  const binaries = await inspectBinaries()
  for (const project of projects) await readFile(path.join(fixtures, "projects", project, "SPEC.md"), "utf8")
  const probe = await import("../../skill-state/scripts/evaluate")
  if (typeof probe.evaluate !== "function") throw new Error("evaluator import failed")
  console.log(
    JSON.stringify(
      {
        ok: true,
        model,
        observationWindow,
        maxConcurrency,
        cellTimeoutMs,
        projects,
        binaries,
      },
      null,
      2,
    ),
  )
}

async function loadSummaries(suite: string) {
  const summaries = []
  for (const project of projects) {
    for (const mode of runnableModes) {
      try {
        summaries.push(
          JSON.parse(await readFile(path.join(experiment, "results", suite, mode, project, "summary.json"), "utf8")),
        )
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
    }
  }
  return summaries
}

const [action = "doctor", ...args] = process.argv.slice(2)
if (action === "doctor") {
  await doctor()
} else if (action === "all") {
  const selectedModes = args.length ? args.map(parseMode) : [...modes]
  if (new Set(selectedModes).size !== selectedModes.length) throw new Error("modes must be unique")
  const binaries = await inspectBinaries()
  const suite = suiteID()
  const cells: [Project, Mode][] = projects.flatMap((project, index) => {
    const offset = index % selectedModes.length
    return [...selectedModes.slice(offset), ...selectedModes.slice(0, offset)].map(
      (mode) => [project, mode] as [Project, Mode],
    )
  })
  const summaries = await mapLimited(cells, maxConcurrency, ([project, mode]) =>
    runCell(project, mode, suite, binaries),
  )
  await report(suite, summaries, binaries)
  console.log(JSON.stringify({ suite, report: path.join(experiment, "results", suite, "report.md") }, null, 2))
} else if (action === "state-all") {
  const [baselineSuite] = args
  if (!baselineSuite) throw new Error("usage: bun run.ts state-all BASELINE_SUITE")
  const binaries = await inspectBinaries()
  const baseline = (await loadSummaries(baselineSuite)).filter((item) => item.mode === "baseline")
  if (baseline.length !== projects.length) {
    throw new Error(`baseline suite ${baselineSuite} has ${baseline.length}/${projects.length} baseline cells`)
  }
  const suite = suiteID()
  const state = await mapLimited(
    projects.map((project) => [project, "skill-state"] as [Project, Mode]),
    maxConcurrency,
    ([project, mode]) => runCell(project, mode, suite, binaries),
  )
  await report(suite, [...baseline, ...state], binaries, baselineSuite)
  console.log(JSON.stringify({ suite, report: path.join(experiment, "results", suite, "report.md") }, null, 2))
} else if (action === "pair") {
  const [project, requestedMode = "v2"] = args
  if (!projects.includes(project as Project)) {
    throw new Error(`usage: bun run.ts pair <${projects.join("|")}> [paper|v2]`)
  }
  const selectedMode = parseMode(requestedMode)
  if (selectedMode === "baseline") throw new Error("pair comparison mode must be paper or v2")
  const binaries = await inspectBinaries()
  const suite = suiteID()
  const summaries = await mapLimited(
    ["baseline", selectedMode].map((mode) => [project as Project, mode] as [Project, Mode]),
    maxConcurrency,
    ([project, mode]) => runCell(project, mode, suite, binaries),
  )
  await report(suite, summaries, binaries)
  console.log(JSON.stringify({ suite, report: path.join(experiment, "results", suite, "report.md") }, null, 2))
} else if (action === "one") {
  const [project, requestedMode] = args
  if (!projects.includes(project as Project) || !requestedMode) {
    throw new Error(`usage: bun run.ts one <${projects.join("|")}> <${modeNames.join("|")}>`)
  }
  const binaries = await inspectBinaries()
  const suite = suiteID()
  const summary = await runCell(project as Project, parseMode(requestedMode), suite, binaries)
  console.log(JSON.stringify(summary, null, 2))
} else if (action === "report") {
  const [targetSuite] = args
  if (!targetSuite) throw new Error("usage: bun run.ts report SUITE")
  const binaries = await inspectBinaries()
  const summaries = await loadSummaries(targetSuite)
  if (!summaries.length) throw new Error(`suite has no summaries: ${targetSuite}`)
  await report(targetSuite, summaries, binaries)
  console.log(
    JSON.stringify({ suite: targetSuite, report: path.join(experiment, "results", targetSuite, "report.md") }, null, 2),
  )
} else {
  throw new Error(
    "usage: bun run.ts doctor|all [MODES...]|state-all BASELINE_SUITE|pair PROJECT [paper|v2]|one PROJECT MODE|report SUITE",
  )
}
