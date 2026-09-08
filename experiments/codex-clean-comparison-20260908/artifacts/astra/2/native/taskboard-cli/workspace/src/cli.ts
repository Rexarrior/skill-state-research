import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type Task = {
  id: number;
  title: string;
  status: "open" | "done";
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
};
type Database = { nextId: number; tasks: Task[] };

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isISO(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDatabase(value: unknown): Database {
  const invalid = () => fail("Malformed task database");
  if (!record(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return invalid();
  if (Object.keys(value).some(key => !["nextId", "tasks"].includes(key))) return invalid();
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 || (task.id as number) >= (value.nextId as number)) return invalid();
    if (ids.has(task.id as number)) return invalid();
    ids.add(task.id as number);
    if (typeof task.title !== "string" || !task.title.trim() || !isISO(task.createdAt)) return invalid();
    if (task.status !== "open" && task.status !== "done") return invalid();
    if (!Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) || new Set(task.tags).size !== task.tags.length) return invalid();
    if ("due" in task && !isDate(task.due)) return invalid();
    if (task.status === "done" ? !isISO(task.completedAt) : "completedAt" in task) return invalid();
    if (Object.keys(task).some(key => !["id", "title", "status", "createdAt", "tags", "due", "completedAt"].includes(key))) return invalid();
  }
  return value as Database;
}

async function load(file: string): Promise<Database> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return fail("Malformed task database: invalid JSON");
  }
  return validateDatabase(value);
}

async function save(file: string, database: Database): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.${basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(database, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function flags(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!allowed.includes(name)) fail(`Unknown flag or argument: ${name}`);
    if (name in result) fail(`Duplicate flag: ${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${name}`);
    result[name] = value;
  }
  return result;
}

function today(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function main(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  let options: Record<string, string> = {};
  let id: number | undefined;
  if (command === "add") {
    options = flags(rest, ["--title", "--tags", "--due"]);
    if (!options["--title"]?.trim()) fail("A non-empty --title is required");
    if ("--due" in options && !isDate(options["--due"])) fail("Invalid --due date; expected YYYY-MM-DD");
  } else if (command === "list") {
    options = flags(rest, ["--status", "--tag", "--overdue"]);
    if ("--status" in options && !["open", "done"].includes(options["--status"])) fail("Invalid --status; expected open or done");
    if ("--overdue" in options && !isDate(options["--overdue"])) fail("Invalid --overdue date; expected YYYY-MM-DD");
    if ("--tag" in options && !normalizeTag(options["--tag"])) fail("A non-empty --tag is required");
  } else if (command === "stats") {
    if (rest.length) fail("stats takes no arguments");
  } else {
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0]))) fail(`${command} requires one positive integer ID`);
    id = Number(rest[0]);
  }

  const configured = process.env.TASKBOARD_FILE;
  if (configured === "") fail("TASKBOARD_FILE must not be empty");
  const file = resolve(configured ?? ".taskboard.json");
  const database = await load(file);
  if (command === "add") {
    if (database.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
    const task: Task = {
      id: database.nextId++,
      title: options["--title"].trim(),
      status: "open",
      createdAt: new Date().toISOString(),
      tags: [...new Set((options["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
      ...(options["--due"] !== undefined ? { due: options["--due"] } : {}),
    };
    database.tasks.push(task);
    await save(file, database);
    return task;
  }
  if (command === "list") {
    return database.tasks.filter(task =>
      (!("--status" in options) || task.status === options["--status"]) &&
      (!("--tag" in options) || task.tags.includes(normalizeTag(options["--tag"]))) &&
      (!("--overdue" in options) || (task.status === "open" && task.due !== undefined && task.due < options["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    const date = today();
    return {
      total: database.tasks.length,
      open: database.tasks.filter(task => task.status === "open").length,
      done: database.tasks.filter(task => task.status === "done").length,
      overdue: database.tasks.filter(task => task.status === "open" && task.due !== undefined && task.due < date).length,
    };
  }
  const task = database.tasks.find(task => task.id === id);
  if (!task) fail(`Task ${id} does not exist`);
  if (command === "done") {
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await save(file, database);
    }
  } else {
    database.tasks = database.tasks.filter(task => task.id !== id);
    await save(file, database);
  }
  return task;
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log("null");
  process.exitCode = 1;
}
