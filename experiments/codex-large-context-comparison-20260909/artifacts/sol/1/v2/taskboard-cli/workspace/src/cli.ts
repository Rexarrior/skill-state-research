import { dirname, basename, join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

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

const databaseFile = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!validIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase())) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !validDate(value.due)) return false;
  if (value.completedAt !== undefined && !validIsoTimestamp(value.completedAt)) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "nextId" && key !== "tasks")) return false;
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return false;
  if (!value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  return new Set(ids).size === ids.length && ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databaseFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    fail(`cannot read database: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("database contains invalid JSON");
  }
  if (!validateDatabase(parsed)) fail("database has an invalid structure");
  return parsed;
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databaseFile);
  const temporary = join(directory, `.${basename(databaseFile)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, databaseFile);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    fail(`cannot write database: ${(error as Error).message}`);
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseOptions(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (options.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
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
  if (!command) fail("missing command");

  if (command === "add") {
    const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title");
    if (title === undefined) fail("missing required flag: --title");
    if (title.trim() === "") fail("title must not be empty");
    const due = options.get("--due");
    if (due !== undefined && !validDate(due)) fail("due date must be a valid YYYY-MM-DD date");
    const tags = [...new Set((options.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title: title.trim(),
      status: "open",
      createdAt: new Date().toISOString(),
      tags,
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("status must be open or done");
    const tagOption = options.get("--tag");
    const tag = tagOption === undefined ? undefined : normalizeTag(tagOption);
    if (tagOption !== undefined && tag === "") fail("tag must not be empty");
    const overdue = options.get("--overdue");
    if (overdue !== undefined && !validDate(overdue)) fail("overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("stats does not accept arguments");
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    return {
      total: database.tasks.length,
      open,
      done: database.tasks.length - open,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
