import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDatabase(value: unknown): asserts value is Database {
  if (!isObject(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed database");
  }
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!isObject(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !isTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !isDate(task.due)) ||
        (task.status === "done" ? !isTimestamp(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database");
    }
    ids.add(task.id as number);
  }
}

function load(file: string): Database {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(contents);
  } catch {
    fail("Malformed database: invalid JSON");
  }
  validateDatabase(data);
  return data;
}

function save(file: string, database: Database): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(database, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temporary, file);
  } finally {
    if (created) {
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function flags(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}

function requireDate(value: string | undefined, flag: string): void {
  if (value !== undefined && !isDate(value)) fail(`Invalid date for ${flag}: expected a real YYYY-MM-DD date`);
}

function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}

function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["add", "list", "done", "delete", "stats"].includes(command)) {
    fail(`Unknown command: ${command ?? "(missing)"}`);
  }
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const database = load(file);
  if (command === "add") {
    const options = flags(args, ["--title", "--tags", "--due"]);
    const title = options["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    requireDate(options["--due"], "--due");
    if (database.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
    const task: Task = {
      id: database.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((options["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
      ...(options["--due"] !== undefined ? { due: options["--due"] } : {}),
    };
    database.tasks.push(task);
    save(file, database);
    return task;
  }
  if (command === "list") {
    const options = flags(args, ["--status", "--tag", "--overdue"]);
    if (options["--status"] !== undefined && !["open", "done"].includes(options["--status"])) fail("Invalid status: expected open or done");
    requireDate(options["--overdue"], "--overdue");
    const tag = options["--tag"] === undefined ? undefined : normalizeTag(options["--tag"]);
    if (tag === "") fail("--tag must not be empty");
    return database.tasks.filter(task =>
      (options["--status"] === undefined || task.status === options["--status"]) &&
      (tag === undefined || task.tags.includes(tag)) &&
      (options["--overdue"] === undefined || overdue(task, options["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    if (args.length) fail(`Unexpected argument: ${args[0]}`);
    const today = localToday();
    return {
      total: database.tasks.length,
      open: database.tasks.filter(task => task.status === "open").length,
      done: database.tasks.filter(task => task.status === "done").length,
      overdue: database.tasks.filter(task => overdue(task, today)).length,
    };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail(`${command} requires one positive integer ID`);
  const task = database.tasks.find(task => task.id === Number(args[0]));
  if (!task) fail(`Task ${args[0]} not found`);
  if (command === "delete") {
    database.tasks = database.tasks.filter(item => item.id !== task.id);
  } else {
    if (task.status === "done") return task;
    task.status = "done";
    task.completedAt = new Date().toISOString();
  }
  save(file, database);
  return task;
}

try {
  console.log(JSON.stringify(main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
