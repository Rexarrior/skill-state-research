import { rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  tags: string[];
  due?: string;
  createdAt: string;
  completedAt?: string;
}

interface Database {
  version: 1;
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function assertTask(value: unknown, index: number): asserts value is Task {
  if (!isPlainObject(value)) fail(`Malformed database: task ${index} is not an object`);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`Malformed database: task ${index} has unknown fields`);
  }
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) {
    fail(`Malformed database: task ${index} has an invalid id`);
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    fail(`Malformed database: task ${index} has an invalid title`);
  }
  if (value.status !== "open" && value.status !== "done") {
    fail(`Malformed database: task ${index} has an invalid status`);
  }
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
    fail(`Malformed database: task ${index} has invalid tags`);
  }
  if (new Set(value.tags).size !== value.tags.length) {
    fail(`Malformed database: task ${index} has duplicate tags`);
  }
  if (value.tags.some((tag) => tag === "" || tag !== tag.trim().toLowerCase())) {
    fail(`Malformed database: task ${index} has non-normalized tags`);
  }
  if (value.due !== undefined && !isDate(value.due)) {
    fail(`Malformed database: task ${index} has an invalid due date`);
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    fail(`Malformed database: task ${index} has an invalid createdAt`);
  }
  if (value.status === "done") {
    if (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt))) {
      fail(`Malformed database: task ${index} has an invalid completedAt`);
    }
  } else if (value.completedAt !== undefined) {
    fail(`Malformed database: open task ${index} has completedAt`);
  }
}

function validateDatabase(value: unknown): Database {
  if (!isPlainObject(value)) fail("Malformed database: root must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !["version", "nextId", "tasks"].includes(key))) {
    fail("Malformed database: unknown root fields");
  }
  if (value.version !== 1) fail("Malformed database: unsupported version");
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) {
    fail("Malformed database: invalid nextId");
  }
  if (!Array.isArray(value.tasks)) fail("Malformed database: tasks must be an array");
  value.tasks.forEach(assertTask);
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) fail("Malformed database: duplicate task ids");
  if (ids.some((id) => id >= (value.nextId as number))) {
    fail("Malformed database: nextId must exceed all task ids");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    const code = isPlainObject(error) ? error.code : undefined;
    if (code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("Malformed database: invalid JSON");
  }
  return validateDatabase(parsed);
}

async function saveDatabase(database: Database): Promise<void> {
  const temporary = `${databasePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporary, databasePath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseId(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) fail("ID must be a positive integer");
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`Unknown flag: ${flag ?? ""}`);
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`Task ${id} not found`);
  return task;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("Missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const rawTitle = flags.get("--title");
    if (rawTitle === undefined) fail("Missing required flag: --title");
    const title = rawTitle.trim();
    if (title === "") fail("Title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const tags = [...new Set((flags.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      tags,
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("Status must be open or done");
    }
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") fail("Tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const database = await loadDatabase();
    const task = findTask(database, parseId(rest[0]));
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const database = await loadDatabase();
    const id = parseId(rest[0]);
    findTask(database, id);
    database.tasks = database.tasks.filter((task) => task.id !== id);
    await saveDatabase(database);
    return { deleted: id };
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("Usage: stats");
    const database = await loadDatabase();
    const today = new Date();
    const localDate = [
      today.getFullYear().toString().padStart(4, "0"),
      (today.getMonth() + 1).toString().padStart(2, "0"),
      today.getDate().toString().padStart(2, "0"),
    ].join("-");
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter(
        (task) => task.status === "open" && task.due !== undefined && task.due < localDate,
      ).length,
    };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
