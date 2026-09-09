import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
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
type Database = { version: 1; nextId: number; tasks: Task[] };
const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
const fail = (message: string): never => { throw new Error(message); };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const normalizeTag = (tag: string) => tag.trim().toLowerCase();
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
function load(): Database {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let db: unknown;
  try { db = JSON.parse(text); } catch { return fail("Malformed database: invalid JSON"); }
  if (!record(db) || db.version !== 1 || !Number.isSafeInteger(db.nextId) ||
      (db.nextId as number) < 1 || !Array.isArray(db.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of db.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (db.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || task.title.trim() === "" ||
        !["open", "done"].includes(task.status as string) || !validTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !validTimestamp(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database: invalid task");
    }
    ids.add(task.id as number);
  }
  return db as Database;
}
function save(db: Database): void {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temporary, file);
  } finally {
    if (created) {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Duplicate flag: ${flag}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = args[i + 1];
  }
  return result;
}
function dateOption(value: string | undefined, flag: string): void {
  if (value !== undefined && !validDate(value)) fail(`Invalid date for ${flag}: expected YYYY-MM-DD`);
}
function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
const overdue = (task: Task, date: string) => task.status === "open" && task.due !== undefined && task.due < date;
function main(args: string[]): unknown {
  const [command, ...rest] = args;
  if (command === "add") {
    const opts = options(rest, ["--title", "--tags", "--due"]);
    const title = opts["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    dateOption(opts["--due"], "--due");
    const db = load();
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID capacity exhausted");
    const task: Task = { id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))] };
    if (opts["--due"] !== undefined) task.due = opts["--due"];
    db.tasks.push(task);
    save(db);
    return task;
  }
  if (command === "list") {
    const opts = options(rest, ["--status", "--tag", "--overdue"]);
    if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"])) fail("Invalid status");
    dateOption(opts["--overdue"], "--overdue");
    const tag = opts["--tag"] === undefined ? undefined : normalizeTag(opts["--tag"]);
    if (tag === "") fail("Tag must not be empty");
    return load().tasks.filter(task =>
      (opts["--status"] === undefined || task.status === opts["--status"]) &&
      (tag === undefined || task.tags.includes(tag)) &&
      (opts["--overdue"] === undefined || overdue(task, opts["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "done" || command === "delete") {
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0]))) fail("Expected one positive integer task ID");
    const db = load();
    const index = db.tasks.findIndex(task => task.id === Number(rest[0]));
    if (index < 0) fail(`Task ${rest[0]} not found`);
    const task = db.tasks[index];
    if (command === "delete") {
      db.tasks.splice(index, 1);
      save(db);
    } else if (task.status !== "done") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      save(db);
    }
    return task;
  }
  if (command === "stats") {
    options(rest, []);
    const tasks = load().tasks;
    const done = tasks.filter(task => task.status === "done").length;
    const today = localToday();
    return { total: tasks.length, open: tasks.length - done, done, overdue: tasks.filter(task => overdue(task, today)).length };
  }
  return fail(command ? `Unknown command: ${command}` : "Expected command: add, list, done, delete, stats");
}
try {
  console.log(JSON.stringify(main(process.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
