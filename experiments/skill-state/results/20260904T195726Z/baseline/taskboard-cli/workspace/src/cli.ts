import { rename, unlink } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";

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
  version: 1;
  nextId: number;
  tasks: Task[];
}

const file = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function validateTask(value: unknown): value is Task {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.status === "done") return isIsoTimestamp(value.completedAt);
  return value.completedAt === undefined;
}

function validateDatabase(value: unknown): value is Database {
  if (!isObject(value)) return false;
  if (Object.keys(value).some((key) => !["version", "nextId", "tasks"].includes(key))) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  return new Set(ids).size === ids.length && ids.every((id) => id < (value.nextId as number));
}

async function readDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(`Malformed database: ${file}`);
  }
  if (!validateDatabase(value)) fail(`Malformed database: ${file}`);
  return value;
}

async function writeDatabase(database: Database): Promise<void> {
  const temporary = resolve(
    dirname(file),
    `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function parseOptions(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`Unknown flag: ${flag ?? ""}`);
    if (options.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined) fail(`Missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail("ID must be a positive integer");
  return id;
}

function requireTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`Task ${id} not found`);
  return task;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;

  if (command === "add") {
    const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const due = options.get("--due");
    if (due !== undefined && !isDate(due)) fail("--due must be a valid YYYY-MM-DD date");
    const tags = [...new Set((options.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
    const database = await readDatabase();
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags,
      ...(due === undefined ? {} : { due }),
    };
    database.tasks.push(task);
    await writeDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("--status must be open or done");
    }
    const tag = options.has("--tag") ? normalizeTag(options.get("--tag")!) : undefined;
    if (tag === "") fail("--tag must not be empty");
    const overdue = options.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("--overdue must be a valid YYYY-MM-DD date");
    const database = await readDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const database = await readDatabase();
    const task = requireTask(database, parseId(rest[0]));
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await writeDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const database = await readDatabase();
    const task = requireTask(database, parseId(rest[0]));
    database.tasks = database.tasks.filter((candidate) => candidate.id !== task.id);
    await writeDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("Usage: stats");
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

  fail(command === undefined ? "Missing command" : `Unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
