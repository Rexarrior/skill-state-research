import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";
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
const file = process.env.TASKBOARD_FILE ?? ".taskboard.json";
const fail = (message: string): never => { throw new Error(message); };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const tag = (value: string) => value.trim().toLowerCase();

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function iso(value: unknown): value is string {
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
  const invalid = (): never => fail("Malformed database: invalid schema");
  if (!object(db) || db.version !== 1 || !positiveInteger(db.nextId) || !Array.isArray(db.tasks)) return invalid();
  const ids = new Set<number>();
  for (const task of db.tasks) {
    if (!object(task) || !positiveInteger(task.id) || ids.has(task.id) || task.id >= db.nextId ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !iso(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(t => typeof t !== "string" || !t || tag(t) !== t) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !iso(task.completedAt) : "completedAt" in task)) return invalid();
    ids.add(task.id);
  }
  return db as Database;
}
function save(db: Database): void {
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
function flags(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!allowed.includes(key)) fail(`Unknown flag or argument: ${key}`);
    if (key in result) fail(`Duplicate flag: ${key}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${key}`);
    result[key] = value;
  }
  return result;
}
function localToday(): string {
  const date = new Date();
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}
const overdue = (task: Task, day: string) => task.status === "open" && task.due !== undefined && task.due < day;
function main(args: string[]): unknown {
  const [command, ...rest] = args;
  if (command === "add") {
    const options = flags(rest, ["--title", "--tags", "--due"]);
    const title = options["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    const due = options["--due"];
    if (due !== undefined && !validDate(due)) fail("Invalid due date: expected a real YYYY-MM-DD date");
    const db = load();
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID range exhausted");
    const task: Task = {
      id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((options["--tags"] ?? "").split(",").map(tag).filter(Boolean))],
      ...(due !== undefined ? { due } : {}),
    };
    db.tasks.push(task);
    save(db);
    return task;
  }
  if (command === "list") {
    const options = flags(rest, ["--status", "--tag", "--overdue"]);
    const status = options["--status"], day = options["--overdue"];
    if (status !== undefined && status !== "open" && status !== "done") fail("Invalid status: expected open or done");
    if (day !== undefined && !validDate(day)) fail("Invalid overdue date: expected a real YYYY-MM-DD date");
    const filterTag = options["--tag"];
    return load().tasks.filter(task =>
      (status === undefined || task.status === status) &&
      (filterTag === undefined || task.tags.includes(tag(filterTag))) &&
      (day === undefined || overdue(task, day))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "done" || command === "delete") {
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]!) || !positiveInteger(Number(rest[0]))) fail(`${command} requires one positive integer ID`);
    const db = load();
    const index = db.tasks.findIndex(task => task.id === Number(rest[0]));
    if (index === -1) fail(`Task ${rest[0]} not found`);
    const task = db.tasks[index]!;
    if (command === "delete") db.tasks.splice(index, 1);
    else {
      if (task.status === "done") return task;
      task.status = "done";
      task.completedAt = new Date().toISOString();
    }
    save(db);
    return task;
  }
  if (command === "stats") {
    if (rest.length) fail(`Unexpected argument: ${rest[0]}`);
    const tasks = load().tasks;
    const open = tasks.filter(task => task.status === "open").length;
    const today = localToday();
    return { total: tasks.length, open, done: tasks.length - open, overdue: tasks.filter(task => overdue(task, today)).length };
  }
  return fail(command ? `Unknown command: ${command}` : "Expected a command: add, list, done, delete, stats");
}
try {
  console.log(JSON.stringify(main(process.argv.slice(2))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log("null");
  process.exitCode = 1;
}
