import { readFile, writeFile, rename, unlink } from "node:fs/promises";
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

function fail(message: string): never { throw new Error(message); }
function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function normalizeTag(value: string): string { return value.trim().toLowerCase(); }
function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function validateDatabase(value: unknown): Database {
  if (!record(value) || value.version !== 1 || !validId(value.nextId) || !Array.isArray(value.tasks)) {
    fail("Malformed database: expected version, nextId, and tasks");
  }
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !validId(task.id) || task.id >= value.nextId || ids.has(task.id)
      || typeof task.title !== "string" || !task.title.trim()
      || (task.status !== "open" && task.status !== "done") || !isTimestamp(task.createdAt)
      || !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag)
      || new Set(task.tags).size !== task.tags.length
      || ("due" in task && !isDate(task.due))
      || (task.status === "done" ? !isTimestamp(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database: invalid task");
    }
    ids.add(task.id);
  }
  return value as Database;
}
async function load(file: string): Promise<Database> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("Malformed database: invalid JSON"); }
  return validateDatabase(value);
}
async function save(file: string, db: Database): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
function flags(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!allowed.includes(name)) fail(`Unknown flag or argument: ${name}`);
    if (name in result) fail(`Duplicate flag: ${name}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${name}`);
    result[name] = value;
  }
  return result;
}
function dateFlag(value: string | undefined, name: string): void {
  if (value !== undefined && !isDate(value)) fail(`Invalid ${name}: expected a real YYYY-MM-DD date`);
}
function today(): string {
  const now = new Date();
  return `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}
function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}
async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  let options: Record<string, string> = {};
  let id: number | undefined;
  if (command === "add") {
    options = flags(args, ["--title", "--tags", "--due"]);
    if (!options["--title"]?.trim()) fail("A non-empty --title is required");
    dateFlag(options["--due"], "due date");
  } else if (command === "list") {
    options = flags(args, ["--status", "--tag", "--overdue"]);
    if (options["--status"] !== undefined && !["open", "done"].includes(options["--status"])) fail("Invalid status: expected open or done");
    if (options["--tag"] !== undefined && !normalizeTag(options["--tag"])) fail("Tag must not be empty");
    dateFlag(options["--overdue"], "overdue date");
  } else if (command === "done" || command === "delete") {
    if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !validId(Number(args[0]))) fail("Expected one positive integer task ID");
    id = Number(args[0]);
  } else if (args.length) fail(`Unexpected argument: ${args[0]}`);

  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = await load(file);
  if (command === "add") {
    if (!Number.isSafeInteger(db.nextId + 1)) fail("Task ID limit reached");
    const task: Task = {
      id: db.nextId++, title: options["--title"].trim(), status: "open",
      createdAt: new Date().toISOString(),
      tags: [...new Set((options["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
      ...(options["--due"] !== undefined ? { due: options["--due"] } : {}),
    };
    db.tasks.push(task);
    await save(file, db);
    return task;
  }
  if (command === "list") {
    return db.tasks.filter(task =>
      (options["--status"] === undefined || task.status === options["--status"])
      && (options["--tag"] === undefined || task.tags.includes(normalizeTag(options["--tag"])))
      && (options["--overdue"] === undefined || overdue(task, options["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    const date = today();
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length,
      done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, date)).length };
  }
  const task = db.tasks.find(task => task.id === id);
  if (!task) fail(`Task ${id} not found`);
  if (command === "delete") db.tasks = db.tasks.filter(t => t.id !== id);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  await save(file, db);
  return task;
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
