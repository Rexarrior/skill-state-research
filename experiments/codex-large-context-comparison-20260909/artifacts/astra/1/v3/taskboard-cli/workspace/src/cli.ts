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
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const tag = (value: string) => value.trim().toLowerCase();
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function load(): Database {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let db: unknown;
  try { db = JSON.parse(raw); } catch { return fail("Malformed database: invalid JSON"); }
  if (!record(db) || db.version !== 1 || !integer(db.nextId) || !Array.isArray(db.tasks))
    return fail("Malformed database: invalid structure");
  const ids = new Set<number>();
  for (const task of db.tasks) {
    if (!record(task) || !integer(task.id) || ids.has(task.id) || task.id >= db.nextId ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !iso(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(t => typeof t !== "string" || !t || tag(t) !== t) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !date(task.due)) ||
        (task.status === "done" ? !iso(task.completedAt) : "completedAt" in task))
      return fail("Malformed database: invalid task");
    ids.add(task.id);
  }
  return db as Database;
}
function save(db: Database) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key)) fail(`Unknown flag or argument: ${key}`);
    if (key in result) fail(`Duplicate flag: ${key}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) fail(`Missing value for ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}
const overdue = (task: Task, day: string) => task.status === "open" && task.due !== undefined && task.due < day;
function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  if (command === "add") {
    const opts = options(args, ["--title", "--tags", "--due"]);
    const title = opts["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    if ("--due" in opts && !date(opts["--due"])) fail("Invalid due date; expected YYYY-MM-DD");
    const db = load();
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
    const task: Task = { id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((opts["--tags"] ?? "").split(",").map(tag).filter(Boolean))] };
    if ("--due" in opts) task.due = opts["--due"];
    db.tasks.push(task);
    save(db);
    return task;
  }
  if (command === "list") {
    const opts = options(args, ["--status", "--tag", "--overdue"]);
    if ("--status" in opts && !["open", "done"].includes(opts["--status"])) fail("Invalid status");
    if ("--overdue" in opts && !date(opts["--overdue"])) fail("Invalid overdue date; expected YYYY-MM-DD");
    if ("--tag" in opts && !tag(opts["--tag"])) fail("Tag must not be empty");
    return load().tasks.filter(task =>
      (!("--status" in opts) || task.status === opts["--status"]) &&
      (!("--tag" in opts) || task.tags.includes(tag(opts["--tag"]))) &&
      (!("--overdue" in opts) || overdue(task, opts["--overdue"])))
      .sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    if (args.length) fail("stats accepts no arguments");
    const tasks = load().tasks;
    const now = new Date();
    const today = `${now.getFullYear().toString().padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const done = tasks.filter(task => task.status === "done").length;
    return { total: tasks.length, open: tasks.length - done, done, overdue: tasks.filter(task => overdue(task, today)).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !integer(Number(args[0]))) fail(`${command} requires one positive integer ID`);
  const db = load();
  const task = db.tasks.find(task => task.id === Number(args[0]));
  if (!task) fail(`Task ${args[0]} not found`);
  if (command === "delete") {
    db.tasks = db.tasks.filter(item => item.id !== task.id);
    save(db);
  } else if (task.status !== "done") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    save(db);
  }
  return task;
}
try { console.log(JSON.stringify(main())); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
