import { readFile, writeFile, rename, unlink } from "node:fs/promises";
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeTag(tag: string): string { return tag.trim().toLowerCase(); }
function validate(value: unknown): Database {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId)
      || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1
        || (task.id as number) >= (value.nextId as number) || ids.has(task.id as number)
        || typeof task.title !== "string" || !task.title.trim()
        || (task.status !== "open" && task.status !== "done") || !isTimestamp(task.createdAt)
        || !Array.isArray(task.tags)
        || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag)
        || new Set(task.tags).size !== task.tags.length
        || ("due" in task && !isDate(task.due))
        || (task.status === "done" ? !isTimestamp(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database");
    }
    ids.add(task.id as number);
  }
  return value as unknown as Database;
}
async function load(): Promise<Database> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("Malformed database: invalid JSON"); }
  return validate(value);
}
async function save(db: Database): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Duplicate flag: ${flag}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}
function dateOption(value: string | undefined, flag: string): void {
  if (value !== undefined && !isDate(value)) fail(`Invalid date for ${flag}: expected YYYY-MM-DD`);
}
function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}
async function main(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!["add", "list", "done", "delete", "stats"].includes(command ?? "")) fail(`Unknown command: ${command ?? "(missing)"}`);
  const opts = command === "add" ? options(rest, ["--title", "--tags", "--due"])
    : command === "list" ? options(rest, ["--status", "--tag", "--overdue"]) : {};
  let id = 0;
  if (command === "done" || command === "delete") {
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]!) || !Number.isSafeInteger(Number(rest[0]))) fail("Expected one positive integer task ID");
    id = Number(rest[0]);
  }
  if (command === "stats" && rest.length) fail(`Unexpected argument: ${rest[0]}`);
  if (command === "add") {
    if (!opts["--title"]?.trim()) fail("A non-empty --title is required");
    dateOption(opts["--due"], "--due");
  }
  if (command === "list") {
    if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"]!)) fail("Invalid status: expected open or done");
    if (opts["--tag"] !== undefined && !normalizeTag(opts["--tag"]!)) fail("Tag must not be empty");
    dateOption(opts["--overdue"], "--overdue");
  }
  const db = await load();
  switch (command) {
    case "add": {
      if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID capacity exhausted");
      const task: Task = { id: db.nextId++, title: opts["--title"]!.trim(), status: "open",
        createdAt: new Date().toISOString(), tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))] };
      if (opts["--due"] !== undefined) task.due = opts["--due"];
      db.tasks.push(task);
      await save(db);
      return task;
    }
    case "list":
      return db.tasks.filter(task => (opts["--status"] === undefined || task.status === opts["--status"])
        && (opts["--tag"] === undefined || task.tags.includes(normalizeTag(opts["--tag"]!)))
        && (opts["--overdue"] === undefined || overdue(task, opts["--overdue"]!))).sort((a, b) => a.id - b.id);
    case "done":
    case "delete": {
      const index = db.tasks.findIndex(task => task.id === id);
      if (index === -1) fail(`Task ${id} not found`);
      const task = db.tasks[index]!;
      if (command === "delete") db.tasks.splice(index, 1);
      else if (task.status === "done") return task;
      else { task.status = "done"; task.completedAt = new Date().toISOString(); }
      await save(db);
      return task;
    }
    case "stats": {
      const today = localToday();
      return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length,
        done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, today)).length };
    }
  }
}
try {
  console.log(JSON.stringify(await main(process.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
