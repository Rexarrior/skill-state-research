#!/usr/bin/env bun

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
}

interface Database {
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function validateDate(value: string, flag: string): string {
  if (!isDate(value)) fail(`${flag} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "nextId" && key !== "tasks")) {
    return fail("malformed taskboard database");
  }
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) <= 0 || !Array.isArray(value.tasks)) {
    return fail("malformed taskboard database");
  }
  if (!value.tasks.every(validateTask)) fail("malformed taskboard database");
  const tasks = value.tasks as Task[];
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail("malformed taskboard database");
  }
  return { nextId: value.nextId as number, tasks };
}

async function readDatabase(): Promise<Database> {
  try {
    const text = await Bun.file(databasePath).text();
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof SyntaxError) fail("malformed taskboard database");
    if (isRecord(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    fail(`cannot read taskboard database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeDatabase(database: Database): Promise<void> {
  const slash = Math.max(databasePath.lastIndexOf("/"), databasePath.lastIndexOf("\\"));
  const directory = slash < 0 ? "." : databasePath.slice(0, slash) || "/";
  const base = slash < 0 ? databasePath : databasePath.slice(slash + 1);
  const temporaryPath = `${directory}/.${base}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { createPath: false });
    await Bun.file(temporaryPath).exists() || fail("failed to create temporary database file");
    const { rename } = await import("node:fs/promises");
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporaryPath);
    } catch {}
    fail(`cannot write taskboard database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOptions(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`unknown flag: ${flag ?? ""}`);
    if (result.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    result.set(flag, value);
  }
  return result;
}

function parseId(args: string[]): number {
  if (args.length !== 1 || !/^\d+$/.test(args[0])) fail("expected one positive integer task ID");
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id) || id <= 0) fail("expected one positive integer task ID");
  return id;
}

function normalizeTags(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const tags = raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title");
    if (title === undefined) fail("missing required flag: --title");
    if (title.trim() === "") fail("title must not be empty");
    const database = await readDatabase();
    const task: Task = {
      id: database.nextId,
      title: title.trim(),
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(options.get("--tags")),
    };
    const due = options.get("--due");
    if (due !== undefined) task.due = validateDate(due, "--due");
    database.nextId += 1;
    database.tasks.push(task);
    await writeDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tag = options.get("--tag")?.trim().toLowerCase();
    if (options.has("--tag") && !tag) fail("--tag must not be empty");
    const overdue = options.get("--overdue");
    if (overdue !== undefined) validateDate(overdue, "--overdue");
    const database = await readDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    const id = parseId(rest);
    const database = await readDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await writeDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    const id = parseId(rest);
    const database = await readDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0) fail(`task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await writeDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`unknown flag: ${rest[0]}`);
    const database = await readDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open");
    return {
      total: database.tasks.length,
      open: open.length,
      done: database.tasks.length - open.length,
      overdue: open.filter((task) => task.due !== undefined && task.due < today).length,
    };
  }

  fail(`unknown command: ${command}`);
}

try {
  const output = await run(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
