import path from "node:path"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"

// Supplementary specification-aligned check, discovered after raw evaluator failures.
// Never changes source code, original workspaces, frozen evaluator or original scores.
const here = import.meta.dir, root = path.resolve(here, "../..")
const data = await Bun.file(path.join(here, "data.json")).json()
const output = path.join(here, "taskboard-delete-audit.json")
const outcomes: any[] = await Bun.file(output).exists() ? (await Bun.file(output).json()).outcomes : []
for (const row of data.rows.filter((r: any) => r.project === "taskboard-cli")) {
  if (outcomes.some((o) => o.source === row.source)) continue
  const original = path.join(root, path.dirname(row.source)), archived = path.join(original, "workspace")
  if (!await Bun.file(path.join(original, "workspace-manifest.json")).exists()) continue
  const directory = await mkdtemp(path.join(tmpdir(), "skill-state-delete-audit-"))
  const workspace = path.join(directory, "workspace")
  await mkdir(workspace)
  await cp(path.join(archived, "src"), path.join(workspace, "src"), { recursive: true, dereference: false })
  if (await Bun.file(path.join(archived, "package.json")).exists())
    await cp(path.join(archived, "package.json"), path.join(workspace, "package.json"))
  const invoke = async (...args: string[]) => {
    const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: workspace,
      env: { ...process.env, TASKBOARD_FILE: path.join(directory, "tasks.json") }, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      .finally(() => clearTimeout(timer))
    let json
    try { json = JSON.parse(stdout) } catch { json = undefined }
    return { exitCode, json, validJSON: json !== undefined, stderrPresent: !!stderr.trim() }
  }
  const checks: { name: string, passed: boolean }[] = []
  let deletedReply: unknown = null
  try {
    const first = await invoke("add", "--title", "First audit task")
    const second = await invoke("add", "--title", "Second audit task")
    const setup = first.exitCode === 0 && second.exitCode === 0 && Number.isInteger(first.json?.id) && Number.isInteger(second.json?.id) && first.json.id !== second.json.id
    checks.push({ name: "setup with two persistent tasks", passed: setup })
    if (setup) {
      const deleted = await invoke("delete", String(second.json.id))
      deletedReply = deleted.json ?? null
      checks.push({ name: "delete exits zero and prints one JSON value (no prescribed keys)", passed: deleted.exitCode === 0 && deleted.validJSON })
      const listed = await invoke("list")
      checks.push({ name: "deleted task absent and other task retained across processes", passed: listed.exitCode === 0 && Array.isArray(listed.json) && listed.json.length === 1 && listed.json[0].id === first.json.id })
      const missing = await invoke("delete", "999999")
      checks.push({ name: "missing id fails", passed: missing.exitCode !== 0 })
      const after = await invoke("list")
      checks.push({ name: "failed delete does not replace data", passed: after.exitCode === 0 && JSON.stringify(after.json) === JSON.stringify(listed.json) })
    }
  } catch {
    checks.push({ name: "supplementary check could execute", passed: false })
  }
  const summary = await Bun.file(path.join(root, row.source)).json()
  const rawCheck = summary.evaluation.checks.find((c: any) => c.name === "delete and missing ids")
  outcomes.push({ source: row.source, repetition: row.repetition, mode: row.mode, rawCheckPassed: rawCheck?.passed ?? null,
    supplementaryPassed: checks.length === 5 && checks.every((c) => c.passed), deletedReply, checks,
    workspace, evaluatedAt: new Date().toISOString() })
}
const result = { partial: data.missing > 0 || outcomes.length !== 20, discoveredAfterRunsStarted: true,
  scope: "Specification-aligned supplementary deletion check on isolated copies of archived projects. Does not replace frozen evaluator results or re-evaluate other task requirements. The original check requires reply.id, not prescribed by SPEC.md.", outcomes }
await Bun.write(output, JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify({ checked: outcomes.length, supplementaryPassed: outcomes.filter((o) => o.supplementaryPassed).length,
  rawFailuresPassingSupplement: outcomes.filter((o) => o.rawCheckPassed === false && o.supplementaryPassed).map(({ repetition, mode }) => ({ repetition, mode })) }))
