import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

type Task = {
  id: number;
  title: string;
  status: "open" | "done";
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
};
type Database = { version: 1; nextId: number; tasks: Task[] };

function fail(message: string): never { throw new Error(message); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function normalizeTag(tag: string): string { return tag.trim().toLowerCase(); }
function validateDatabase(value: unknown): Database {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !validTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !validTimestamp(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database");
    }
    ids.add(task.id as number);
  }
  return value as Database;
}
function load(path: string): Database {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("Malformed database: invalid JSON"); }
  return validateDatabase(value);
}
function save(path: string, database: Database): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(database, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temporary, path);
  } finally {
    if (created) {
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
function options(args: string[], allowed: string[]): Record<string, string> {
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
  if (value !== undefined && !validDate(value)) fail(`Invalid date for ${flag}: expected YYYY-MM-DD`);
}
function localToday(): string {
  const date = new Date();
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}
function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}
function main(args: string[]): unknown {
  const [command, ...rest] = args;
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const path = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const database = load(path);
  if (command === "add") {
    const flags = options(rest, ["--title", "--tags", "--due"]);
    const title = flags["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    requireDate(flags["--due"], "--due");
    if (database.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID capacity exhausted");
    const task: Task = {
      id: database.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((flags["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
      ...(flags["--due"] !== undefined ? { due: flags["--due"] } : {}),
    };
    database.tasks.push(task);
    save(path, database);
    return task;
  }
  if (command === "list") {
    const flags = options(rest, ["--status", "--tag", "--overdue"]);
    if (flags["--status"] !== undefined && !["open", "done"].includes(flags["--status"])) fail("Invalid status: expected open or done");
    requireDate(flags["--overdue"], "--overdue");
    const tag = flags["--tag"] === undefined ? undefined : normalizeTag(flags["--tag"]);
    if (tag === "") fail("Tag must not be empty");
    return database.tasks.filter(task =>
      (flags["--status"] === undefined || task.status === flags["--status"]) &&
      (tag === undefined || task.tags.includes(tag)) &&
      (flags["--overdue"] === undefined || overdue(task, flags["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    options(rest, []);
    const today = localToday();
    return {
      total: database.tasks.length,
      open: database.tasks.filter(task => task.status === "open").length,
      done: database.tasks.filter(task => task.status === "done").length,
      overdue: database.tasks.filter(task => overdue(task, today)).length,
    };
  }
  if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0]))) fail(`${command} requires one positive integer ID`);
  const task = database.tasks.find(task => task.id === Number(rest[0]));
  if (!task) fail(`Task ${rest[0]} not found`);
  if (command === "done") {
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      save(path, database);
    }
  } else {
    database.tasks = database.tasks.filter(candidate => candidate.id !== task.id);
    save(path, database);
  }
  return task;
}

try {
  console.log(JSON.stringify(main(process.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
