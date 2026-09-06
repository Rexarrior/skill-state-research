import { dirname, basename, join } from "node:path";
import { rename, unlink } from "node:fs/promises";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  tags: string[];
  createdAt: string;
  due?: string;
  completedAt?: string;
}

interface Database {
  version: 1;
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function assertExactKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) fail(`Malformed database: unexpected ${label} field '${unexpected}'`);
}

function validateTask(value: unknown, index: number): Task {
  if (!isRecord(value)) fail(`Malformed database: task ${index} is not an object`);
  assertExactKeys(value, ["id", "title", "status", "tags", "createdAt", "due", "completedAt"], `task ${index}`);

  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) fail(`Malformed database: invalid task id at index ${index}`);
  if (typeof value.title !== "string" || value.title.trim() === "") fail(`Malformed database: invalid title for task ${value.id}`);
  if (value.status !== "open" && value.status !== "done") fail(`Malformed database: invalid status for task ${value.id}`);
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase()) || new Set(value.tags).size !== value.tags.length) {
    fail(`Malformed database: invalid tags for task ${value.id}`);
  }
  if (!isIsoTimestamp(value.createdAt)) fail(`Malformed database: invalid createdAt for task ${value.id}`);
  if (value.due !== undefined && !isDate(value.due)) fail(`Malformed database: invalid due date for task ${value.id}`);
  if (value.status === "done") {
    if (!isIsoTimestamp(value.completedAt)) fail(`Malformed database: done task ${value.id} has no valid completedAt`);
  } else if (value.completedAt !== undefined) {
    fail(`Malformed database: open task ${value.id} has completedAt`);
  }

  return value as unknown as Task;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    fail(`Cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("Malformed database: invalid JSON");
  }
  if (!isRecord(value)) fail("Malformed database: root must be an object");
  assertExactKeys(value, ["version", "nextId", "tasks"], "database");
  if (value.version !== 1) fail("Malformed database: unsupported version");
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) fail("Malformed database: invalid nextId");
  if (!Array.isArray(value.tasks)) fail("Malformed database: tasks must be an array");

  const tasks = value.tasks.map(validateTask);
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) fail("Malformed database: duplicate task ids");
  const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
  if ((value.nextId as number) <= maxId) fail("Malformed database: nextId does not exceed existing ids");

  return { version: 1, nextId: value.nextId as number, tasks };
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    fail(`Cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeTags(input: string): string[] {
  const tags = input.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`Unexpected argument '${flag ?? ""}'`);
    if (!allowed.has(flag)) fail(`Unknown flag '${flag}'`);
    if (flags.has(flag)) fail(`Flag '${flag}' was provided more than once`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for '${flag}'`);
    flags.set(flag, value);
  }
  return flags;
}

function requireId(args: string[], command: string): number {
  if (args.length !== 1) fail(`Usage: ${command} ID`);
  if (!/^[1-9]\d*$/.test(args[0])) fail(`Invalid task id '${args[0]}'`);
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id)) fail(`Invalid task id '${args[0]}'`);
  return id;
}

async function execute(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("Missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title");
    if (title === undefined) fail("Missing required flag '--title'");
    if (title.trim() === "") fail("Title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail(`Invalid due date '${due}'`);

    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title: title.trim(),
      status: "open",
      tags: normalizeTags(flags.get("--tags") ?? ""),
      createdAt: new Date().toISOString(),
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail(`Invalid status '${status}'`);
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail(`Invalid overdue date '${overdue}'`);
    const tag = flags.has("--tag") ? flags.get("--tag")!.trim().toLowerCase() : undefined;
    if (tag === "") fail("Tag must not be empty");

    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const id = requireId(rest, "done");
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`Task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    const id = requireId(rest, "delete");
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    if (rest.length > 0) fail(`Unknown flag or argument '${rest[0]}'`);
    const database = await loadDatabase();
    const today = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const open = database.tasks.filter((task) => task.status === "open").length;
    return {
      total: database.tasks.length,
      open,
      done: database.tasks.length - open,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`Unknown command '${command}'`);
}

try {
  const result = await execute(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
