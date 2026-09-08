import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

interface Task {
  id: number;
  title: string;
  status: "open" | "done";
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
}
interface Database { version: 1; nextId: number; tasks: Task[] }

function fail(message: string): never { throw new Error(message); }
function dateValid(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isoValid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function normalizeTag(value: string): string { return value.trim().toLowerCase(); }
function validateDatabase(value: unknown): Database {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !isoValid(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(t => typeof t !== "string" || !t || normalizeTag(t) !== t) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !dateValid(task.due)) ||
        (task.status === "done" ? !isoValid(task.completedAt) : "completedAt" in task)) fail("Malformed database");
    ids.add(task.id as number);
  }
  return value as unknown as Database;
}
function load(file: string): Database {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { fail("Malformed database: invalid JSON"); }
  return validateDatabase(data);
}
function save(file: string, db: Database): void {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Duplicate flag: ${flag}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}
function requireDate(value: string | undefined, flag: string): void {
  if (value !== undefined && !dateValid(value)) fail(`Invalid date for ${flag}: expected YYYY-MM-DD`);
}
function localToday(): string {
  const date = new Date();
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}
function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(file);
  if (command === "add") {
    const opts = options(args, ["--title", "--tags", "--due"]);
    const title = opts["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    requireDate(opts["--due"], "--due");
    if (db.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
    const task: Task = { id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))] };
    if (opts["--due"] !== undefined) task.due = opts["--due"];
    db.tasks.push(task);
    save(file, db);
    return task;
  }
  if (command === "list") {
    const opts = options(args, ["--status", "--tag", "--overdue"]);
    if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"])) fail("Invalid status: expected open or done");
    requireDate(opts["--overdue"], "--overdue");
    return db.tasks.filter(task =>
      (opts["--status"] === undefined || task.status === opts["--status"]) &&
      (opts["--tag"] === undefined || task.tags.includes(normalizeTag(opts["--tag"]))) &&
      (opts["--overdue"] === undefined || overdue(task, opts["--overdue"])))
      .sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    options(args, []);
    const today = localToday();
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length,
      done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, today)).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail(`${command} requires one positive integer ID`);
  const id = Number(args[0]);
  const task = db.tasks.find(t => t.id === id);
  if (!task) fail(`Task ${id} does not exist`);
  if (command === "done") {
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      save(file, db);
    }
  } else {
    db.tasks = db.tasks.filter(t => t.id !== id);
    save(file, db);
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
