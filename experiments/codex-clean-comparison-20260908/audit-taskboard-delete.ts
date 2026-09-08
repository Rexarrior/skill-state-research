import path from "node:path"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"

// Same specification-aligned check as the prior Sol series, on ALL 40 new CLI artifacts.
const here = import.meta.dir
const data = await Bun.file(path.join(here, "data.json")).json()
const output = path.join(here, "taskboard-delete-audit.json")
if (await Bun.file(output).exists()) throw new Error("Audit already recorded")
const outcomes = []
for (const row of data.rows.filter((row: { project: string }) => row.project === "taskboard-cli")) {
  const archived = path.resolve(here, row.archive)
  if (!archived.startsWith(path.join(here, "artifacts") + path.sep)) throw new Error("Unexpected archive")
  const directory = await mkdtemp(path.join(tmpdir(), "skill-state-clean-delete-audit-"))
  const workspace = path.join(directory, "workspace")
  await mkdir(workspace)
  const checks: { name: string, passed: boolean }[] = []
  if (await Bun.file(path.join(archived, "src/cli.ts")).exists()) {
    await cp(path.join(archived, "src"), path.join(workspace, "src"), { recursive: true, dereference: false })
    if (await Bun.file(path.join(archived, "package.json")).exists())
      await cp(path.join(archived, "package.json"), path.join(workspace, "package.json"))
    const invoke = async (...args: string[]) => {
      const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: workspace,
        env: { PATH: process.env.PATH, TASKBOARD_FILE: path.join(directory, "tasks.json") }, stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
      const [stdout, , exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]).finally(() => clearTimeout(timer))
      let json
      try { json = JSON.parse(stdout) } catch { json = undefined }
      return { exitCode, json, validJSON: json !== undefined }
    }
    try {
      const first = await invoke("add", "--title", "First audit task")
      const second = await invoke("add", "--title", "Second audit task")
      const setup = first.exitCode === 0 && second.exitCode === 0 && Number.isInteger(first.json?.id) &&
        Number.isInteger(second.json?.id) && first.json.id !== second.json.id
      checks.push({ name: "setup with two persistent tasks", passed: setup })
      if (setup) {
        const deleted = await invoke("delete", String(second.json.id))
        checks.push({ name: "delete exits zero and prints one JSON value (no prescribed keys)", passed: deleted.exitCode === 0 && deleted.validJSON })
        const listed = await invoke("list")
        checks.push({ name: "deleted task absent and other task retained across processes", passed: listed.exitCode === 0 &&
          Array.isArray(listed.json) && listed.json.length === 1 && listed.json[0].id === first.json.id })
        const missing = await invoke("delete", "999999")
        checks.push({ name: "missing id fails", passed: missing.exitCode !== 0 })
        const after = await invoke("list")
        checks.push({ name: "failed delete does not replace data", passed: after.exitCode === 0 && JSON.stringify(after.json) === JSON.stringify(listed.json) })
      }
    } catch { checks.push({ name: "supplementary check could execute", passed: false }) }
  } else checks.push({ name: "CLI entrypoint exists", passed: false })
  outcomes.push({ id: row.id, cohort: row.cohort, repetition: row.repetition, mode: row.mode,
    rawCheckPassed: row.checks.find((check: { name: string }) => check.name === "delete and missing ids")?.passed ?? null,
    supplementaryPassed: checks.length === 5 && checks.every(check => check.passed), checks,
    evaluatedAt: new Date().toISOString() })
}
if (outcomes.length !== 40) throw new Error("Expected all 40 CLI artifacts")
await Bun.write(output, JSON.stringify({ declaredBeforeCampaigns: true, outcomes,
  scope: "Isolated copies of all 40 archived CLI projects. No model calls, source fixes or original score replacement. Other task requirements not re-evaluated." }, null, 2) + "\n")
console.log(JSON.stringify({ checked: outcomes.length, passed: outcomes.filter(row => row.supplementaryPassed).length,
  changed: outcomes.filter(row => row.rawCheckPassed !== row.supplementaryPassed).map(row => row.id) }))
