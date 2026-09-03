import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type Check = { name: string; passed: boolean; detail?: string }
type Evaluation = { project: string; passed: number; total: number; score: number; checks: Check[] }

const dec = new TextDecoder()

async function command(argv: string[], cwd: string, env: Record<string, string> = {}, timeoutMs = 20_000) {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  return { stdout, stderr, exitCode }
}

function json(text: string) {
  return JSON.parse(text.trim())
}

function equal(actual: unknown, expected: unknown) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      )
    }
    return value
  }
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function ok(value: unknown, message: string) {
  if (!value) throw new Error(message)
}

async function evaluate(project: string, workspace: string): Promise<Evaluation> {
  const checks: Check[] = []
  async function check(name: string, fn: () => unknown | Promise<unknown>) {
    try {
      await fn()
      checks.push({ name, passed: true })
    } catch (error) {
      checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  if (project === "taskboard-cli") await taskboard(workspace, check)
  else if (project === "csv-insights") await csvInsights(workspace, check)
  else if (project === "mini-template") await miniTemplate(workspace, check)
  else if (project === "http-kv") await httpKV(workspace, check)
  else if (project === "dependency-planner") await dependencyPlanner(workspace, check)
  else throw new Error(`unknown project: ${project}`)

  await check("README exists", async () => {
    const body = await readFile(path.join(workspace, "README.md"), "utf8")
    ok(body.trim().length >= 80, "README is missing or too short")
  })

  const passed = checks.filter((item) => item.passed).length
  return { project, passed, total: checks.length, score: passed / checks.length, checks }
}

type Checker = (name: string, fn: () => unknown | Promise<unknown>) => Promise<void>

async function taskboard(workspace: string, check: Checker) {
  const dir = await mkdtemp(path.join(tmpdir(), "taskboard-eval-"))
  const db = path.join(dir, "tasks.json")
  const run = (...args: string[]) => command(["bun", "run", "src/cli.ts", ...args], workspace, { TASKBOARD_FILE: db })

  await check("add, normalization, persistence", async () => {
    const first = await run("add", "--title", "Ship release", "--tags", "urgent, Backend,urgent", "--due", "2030-02-03")
    ok(first.exitCode === 0, first.stderr)
    const a = json(first.stdout)
    equal(
      { id: a.id, title: a.title, status: a.status, due: a.due },
      {
        id: 1,
        title: "Ship release",
        status: "open",
        due: "2030-02-03",
      },
    )
    equal(a.tags.map((tag: string) => tag.toLowerCase()).sort(), ["backend", "urgent"])
    ok(!Number.isNaN(Date.parse(a.createdAt)), "createdAt is not ISO-like")
    const second = await run("add", "--title", "Write docs", "--tags", "Docs")
    ok(second.exitCode === 0 && json(second.stdout).id === 2, second.stderr)
  })

  await check("combined list filters", async () => {
    const result = await run("list", "--status", "open", "--tag", "BACKEND")
    ok(result.exitCode === 0, result.stderr)
    equal(
      json(result.stdout).map((x: any) => x.id),
      [1],
    )
  })

  await check("done is idempotent", async () => {
    const first = await run("done", "1")
    const second = await run("done", "1")
    ok(first.exitCode === 0 && second.exitCode === 0, first.stderr + second.stderr)
    const a = json(first.stdout)
    const b = json(second.stdout)
    ok(a.status === "done" && b.status === "done", "task is not done")
    equal(a.completedAt, b.completedAt)
  })

  await check("delete and missing ids", async () => {
    const deleted = await run("delete", "2")
    ok(deleted.exitCode === 0 && json(deleted.stdout).id === 2, deleted.stderr)
    const missing = await run("delete", "999")
    ok(missing.exitCode !== 0, "missing id succeeded")
  })

  await check("overdue and stats", async () => {
    await run("add", "--title", "Old", "--due", "2000-01-01")
    const list = await run("list", "--overdue", "2020-01-01")
    equal(
      json(list.stdout).map((x: any) => x.title),
      ["Old"],
    )
    const stats = json((await run("stats")).stdout)
    equal(stats, { total: 2, open: 1, done: 1, overdue: 1 })
  })

  await check("invalid date does not mutate", async () => {
    const before = await readFile(db, "utf8")
    const result = await run("add", "--title", "Bad", "--due", "2025-02-30")
    ok(result.exitCode !== 0, "impossible date succeeded")
    equal(await readFile(db, "utf8"), before)
  })

  await check("malformed database is preserved", async () => {
    await writeFile(db, "{broken")
    const result = await run("list")
    ok(result.exitCode !== 0, "malformed database was accepted")
    equal(await readFile(db, "utf8"), "{broken")
  })
  await rm(dir, { recursive: true, force: true })
}

async function csvInsights(workspace: string, check: Checker) {
  const dir = await mkdtemp(path.join(tmpdir(), "csv-eval-"))
  const input = path.join(dir, "input.csv")
  await writeFile(
    input,
    'region,status,revenue,note\nNorth,paid,1.20,"hello, world"\nSouth,paid,2.30,"two\nlines"\nNorth,paid,2.80,x\nNorth,void,99,z\n',
  )
  const run = (...args: string[]) => command(["python3", "main.py", input, ...args], workspace)

  await check("RFC CSV parse and filters", async () => {
    const result = await run("--where", "status=paid", "--where", "region=South", "--output", "json")
    ok(result.exitCode === 0, result.stderr)
    equal(json(result.stdout), [{ region: "South", status: "paid", revenue: "2.30", note: "two\nlines" }])
  })

  await check("sum and average use decimal output", async () => {
    const result = await run(
      "--where",
      "status=paid",
      "--group-by",
      "region",
      "--sum",
      "revenue",
      "--avg",
      "revenue",
      "--output",
      "json",
    )
    ok(result.exitCode === 0, result.stderr)
    equal(json(result.stdout), [
      { region: "North", sum_revenue: "4", avg_revenue: "2" },
      { region: "South", sum_revenue: "2.3", avg_revenue: "2.3" },
    ])
  })

  await check("CSV output quoting", async () => {
    const result = await run("--where", "status=paid", "--where", "region=South", "--output", "csv")
    ok(result.exitCode === 0, result.stderr)
    ok(result.stdout.includes('"hello, world"') === false, "filter was ignored")
    ok(result.stdout.includes('"two\nlines"'), "embedded newline not quoted")
  })

  await check("unknown columns fail", async () => {
    const result = await run("--where", "missing=x")
    ok(result.exitCode !== 0 && /missing|column/i.test(result.stderr), "unknown column was accepted")
  })

  await check("invalid numeric cell identifies location", async () => {
    const bad = path.join(dir, "bad.csv")
    await writeFile(bad, "group,value\na,nope\n")
    const result = await command(["python3", "main.py", bad, "--group-by", "group", "--sum", "value"], workspace)
    ok(result.exitCode !== 0, "invalid decimal was accepted")
    ok(/value/i.test(result.stderr) && /2/.test(result.stderr), "error lacks column or row")
  })

  await check("ragged records fail", async () => {
    const bad = path.join(dir, "ragged.csv")
    await writeFile(bad, "a,b\n1\n")
    const result = await command(["python3", "main.py", bad], workspace)
    ok(result.exitCode !== 0, "ragged input was accepted")
  })

  await check("input is not modified", async () => {
    const before = await readFile(input, "utf8")
    await run("--output", "json")
    equal(await readFile(input, "utf8"), before)
  })
  await rm(dir, { recursive: true, force: true })
}

async function miniTemplate(workspace: string, check: Checker) {
  const dir = await mkdtemp(path.join(tmpdir(), "template-eval-"))
  const run = async (template: string, data: unknown) => {
    const templateFile = path.join(dir, "template.txt")
    const dataFile = path.join(dir, "data.json")
    await writeFile(templateFile, template)
    await writeFile(dataFile, JSON.stringify(data))
    return command(["bun", "run", "src/cli.ts", templateFile, dataFile], workspace)
  }

  await check("escaping, raw values, comments, missing", async () => {
    const result = await run("{{name}}|{{{name}}}|{{! no }}|{{missing}}", { name: `<x a="b">'&` })
    ok(result.exitCode === 0, result.stderr)
    ok(
      [
        '&lt;x a=&quot;b&quot;&gt;&#39;&amp;|<x a="b">\'&||',
        '&lt;x a=&quot;b&quot;&gt;&#x27;&amp;|<x a="b">\'&||',
        '&lt;x a=&quot;b&quot;&gt;&apos;&amp;|<x a="b">\'&||',
      ].includes(result.stdout),
      `unexpected escaping: ${result.stdout}`,
    )
  })

  await check("nested if and else", async () => {
    const result = await run("A{{#if user}}{{#if user.ok}}Y{{else}}N{{/if}}{{else}}X{{/if}}Z", {
      user: { ok: false },
    })
    equal(result.stdout, "ANZ")
  })

  await check("each context, root fallback and indices", async () => {
    const result = await run("{{#each rows}}[{{@index}}:{{this.name}}/{{title}}]{{else}}empty{{/each}}", {
      title: "T",
      rows: [{ name: "a" }, { name: "b" }],
    })
    ok(result.exitCode === 0, result.stderr)
    equal(result.stdout, "[0:a/T][1:b/T]")
  })

  await check("nested loops", async () => {
    const result = await run("{{#each rows}}{{#each this}}{{this}}{{else}}E{{/each}};{{/each}}", {
      rows: [[1, 2], []],
    })
    equal(result.stdout, "12;E;")
  })

  await check("specified truthiness", async () => {
    const result = await run("{{#if zero}}x{{else}}0{{/if}}{{#if empty}}x{{else}}e{{/if}}{{#if obj}}o{{/if}}", {
      zero: 0,
      empty: [],
      obj: {},
    })
    equal(result.stdout, "0eo")
  })

  await check("structural errors include line and column", async () => {
    const result = await run("first\n{{#if yes}}oops{{/each}}", { yes: true })
    ok(result.exitCode !== 0, "mismatched close succeeded")
    ok(/line|2/i.test(result.stderr) && /column|col/i.test(result.stderr), "location missing")
  })

  await check("objects are rejected as scalar", async () => {
    const result = await run("{{value}}", { value: { x: 1 } })
    ok(result.exitCode !== 0, "object interpolation succeeded")
  })
  await rm(dir, { recursive: true, force: true })
}

async function startServer(workspace: string, data: string) {
  const proc = Bun.spawn(["python3", "server.py", "--host", "127.0.0.1", "--port", "0", "--data", data], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.getReader()
  let buffered = ""
  const deadline = Date.now() + 8_000
  while (!buffered.includes("\n") && Date.now() < deadline) {
    const read = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("server did not announce port")), 8_000)),
    ])
    if (read.done) break
    buffered += dec.decode(read.value, { stream: true })
  }
  const match = /^LISTENING (\d+)\r?\n/.exec(buffered)
  if (!match) {
    proc.kill()
    throw new Error(`bad server banner: ${JSON.stringify(buffered)}`)
  }
  return { proc, base: `http://127.0.0.1:${match[1]}` }
}

async function stopServer(proc: Bun.Subprocess) {
  proc.kill("SIGTERM")
  await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
  if (proc.exitCode === null) proc.kill("SIGKILL")
}

async function request(base: string, route: string, init?: RequestInit) {
  const response = await fetch(base + route, init)
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined }
}

async function httpKV(workspace: string, check: Checker) {
  const dir = await mkdtemp(path.join(tmpdir(), "http-kv-eval-"))
  const data = path.join(dir, "db.json")
  let server = await startServer(workspace, data)
  try {
    await check("health and JSON headers", async () => {
      const result = await request(server.base, "/health")
      equal({ status: result.status, body: result.body }, { status: 200, body: { status: "ok" } })
      ok(result.headers.get("content-type")?.includes("application/json"), "wrong content type")
    })

    await check("create, replace and URL-decoded key", async () => {
      const created = await request(server.base, "/v1/kv/hello%20world", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: { n: 1 } }),
      })
      const replaced = await request(server.base, "/v1/kv/hello%20world", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: [1, 2] }),
      })
      const fetched = await request(server.base, "/v1/kv/hello%20world")
      equal([created.status, replaced.status, fetched.status], [201, 200, 200])
      equal(fetched.body, { key: "hello world", value: [1, 2] })
    })

    await check("sorted live keys", async () => {
      for (const key of ["z", "a"]) {
        await request(server.base, `/v1/kv/${key}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: key }),
        })
      }
      equal((await request(server.base, "/v1/keys")).body, { keys: ["a", "hello world", "z"] })
    })

    await check("TTL expires", async () => {
      await request(server.base, "/v1/kv/short", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 1, ttl_seconds: 0.08 }),
      })
      await Bun.sleep(140)
      equal((await request(server.base, "/v1/kv/short")).status, 404)
      ok(!(await request(server.base, "/v1/keys")).body.keys.includes("short"), "expired key was listed")
    })

    await check("bad requests are JSON 4xx", async () => {
      const badJSON = await request(server.base, "/v1/kv/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      })
      const badTTL = await request(server.base, "/v1/kv/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 1, ttl_seconds: 0 }),
      })
      ok(badJSON.status >= 400 && badJSON.status < 500 && typeof badJSON.body === "object", "bad JSON response")
      ok(badTTL.status >= 400 && badTTL.status < 500, "bad TTL accepted")
    })

    await check("delete status codes", async () => {
      equal((await request(server.base, "/v1/kv/z", { method: "DELETE" })).status, 204)
      equal((await request(server.base, "/v1/kv/z", { method: "DELETE" })).status, 404)
    })

    await check("persistence across restart", async () => {
      await stopServer(server.proc)
      server = await startServer(workspace, data)
      equal((await request(server.base, "/v1/kv/hello%20world")).body, { key: "hello world", value: [1, 2] })
      equal((await request(server.base, "/v1/kv/short")).status, 404)
    })

    await check("unknown route and unsupported method", async () => {
      const route = await request(server.base, "/missing")
      const method = await request(server.base, "/health", { method: "POST" })
      ok(route.status === 404 && method.status === 405, `statuses ${route.status}/${method.status}`)
    })
  } finally {
    await stopServer(server.proc)
    await rm(dir, { recursive: true, force: true })
  }
}

async function dependencyPlanner(workspace: string, check: Checker) {
  const dir = await mkdtemp(path.join(tmpdir(), "planner-eval-"))
  const run = async (value: unknown) => {
    const file = path.join(dir, "tasks.json")
    await writeFile(file, JSON.stringify(value))
    return command(["bun", "run", "src/cli.ts", "plan", file], workspace)
  }

  await check("deterministic order and parallel layers", async () => {
    const result = await run({
      tasks: [
        { id: "deploy", duration: 1, dependsOn: ["test", "package"] },
        { id: "test", duration: 4, dependsOn: ["build"] },
        { id: "lint", duration: 2 },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "package", duration: 2, dependsOn: ["build"] },
      ],
    })
    ok(result.exitCode === 0, result.stderr)
    const value = json(result.stdout)
    equal(value.order, ["lint", "build", "package", "test", "deploy"])
    equal(value.layers, [["lint"], ["build"], ["package", "test"], ["deploy"]])
    equal(value.earliest, {
      build: { start: 2, finish: 5 },
      deploy: { start: 9, finish: 10 },
      lint: { start: 0, finish: 2 },
      package: { start: 5, finish: 7 },
      test: { start: 5, finish: 9 },
    })
    equal(value.totalDuration, 10)
    equal(value.criticalPath, ["lint", "build", "test", "deploy"])
  })

  await check("lexicographic critical-path tie break", async () => {
    const result = await run({
      tasks: [
        { id: "z", duration: 2 },
        { id: "a", duration: 2 },
        { id: "end", duration: 1, dependsOn: ["z", "a"] },
      ],
    })
    equal(json(result.stdout).criticalPath, ["a", "end"])
  })

  await check("empty graph", async () => {
    equal(json((await run({ tasks: [] })).stdout), {
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    })
  })

  await check("concrete deterministic cycle", async () => {
    const result = await run({
      tasks: [
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    })
    ok(result.exitCode !== 0, "cycle succeeded")
    ok(/a\s*->\s*b\s*->\s*a/.test(result.stderr), `unexpected cycle: ${result.stderr}`)
  })

  await check("unknown dependency fails", async () => {
    const result = await run({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })
    ok(result.exitCode !== 0 && /missing/.test(result.stderr), "unknown dependency accepted")
  })

  await check("duplicate dependencies and invalid duration fail", async () => {
    const duplicate = await run({
      tasks: [
        { id: "a", duration: 1, dependsOn: ["b", "b"] },
        { id: "b", duration: 1 },
      ],
    })
    const duration = await run({ tasks: [{ id: "a", duration: -1 }] })
    ok(duplicate.exitCode !== 0 && duration.exitCode !== 0, "invalid schema accepted")
  })
  await rm(dir, { recursive: true, force: true })
}

if (import.meta.main) {
  const [project, workspace] = process.argv.slice(2)
  if (!project || !workspace) {
    console.error("usage: bun evaluate.ts PROJECT WORKSPACE")
    process.exit(2)
  }
  const result = await evaluate(project, path.resolve(workspace))
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.passed === result.total ? 0 : 1)
}

export { evaluate }
