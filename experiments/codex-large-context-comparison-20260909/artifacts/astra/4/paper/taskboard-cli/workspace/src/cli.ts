import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
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
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeTag(value: string): string { return value.trim().toLowerCase(); }
function validate(value: unknown): Database {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!object(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        !["open", "done"].includes(task.status as string) || !isoValid(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        (task.due !== undefined && !dateValid(task.due)) ||
        (task.status === "done" ? !isoValid(task.completedAt) : task.completedAt !== undefined)) {
      fail("Malformed database");
    }
    ids.add(task.id as number);
  }
  return value as unknown as Database;
}
async function load(path: string): Promise<Database> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  try { return validate(JSON.parse(text)); }
  catch { fail("Malformed database"); }
}
async function save(path: string, db: Database): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
function flags(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key)) fail(`Unknown flag or argument: ${key}`);
    if (key in result) fail(`Duplicate flag: ${key}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${key}`);
    result[key] = value;
  }
  return result;
}
function taskId(args: string[]): number {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail("Expected one positive integer task ID");
  return Number(args[0]);
}
function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}
async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const options = command === "add" ? flags(args, ["--title", "--tags", "--due"])
    : command === "list" ? flags(args, ["--status", "--tag", "--overdue"])
    : command === "stats" ? flags(args, []) : {};
  const id = command === "done" || command === "delete" ? taskId(args) : undefined;
  if (command === "add" && !options["--title"]?.trim()) fail("A non-empty --title is required");
  for (const key of ["--due", "--overdue"]) {
    if (options[key] !== undefined && !dateValid(options[key])) fail(`Invalid date for ${key}: expected YYYY-MM-DD`);
  }
  if (options["--status"] !== undefined && !["open", "done"].includes(options["--status"])) fail("Invalid status: expected open or done");
  if (options["--tag"] !== undefined && !normalizeTag(options["--tag"])) fail("Tag must not be empty");
  const path = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = await load(path);
  switch (command) {
    case "add": {
      if (db.nextId >= Number.MAX_SAFE_INTEGER) fail("Task IDs exhausted");
      const task: Task = { id: db.nextId++, title: options["--title"].trim(), status: "open", createdAt: new Date().toISOString(), tags: [...new Set((options["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))] };
      if (options["--due"] !== undefined) task.due = options["--due"];
      db.tasks.push(task);
      await save(path, db);
      return task;
    }
    case "list": return db.tasks.filter(task =>
      (options["--status"] === undefined || task.status === options["--status"]) &&
      (options["--tag"] === undefined || task.tags.includes(normalizeTag(options["--tag"]))) &&
      (options["--overdue"] === undefined || overdue(task, options["--overdue"]))
    ).sort((a, b) => a.id - b.id);
    case "done":
    case "delete": {
      const index = db.tasks.findIndex(task => task.id === id);
      if (index === -1) fail(`Task ${id} not found`);
      const task = db.tasks[index];
      if (command === "delete") db.tasks.splice(index, 1);
      else if (task.status === "done") return task;
      else { task.status = "done"; task.completedAt = new Date().toISOString(); }
      await save(path, db);
      return task;
    }
    case "stats": return {
      total: db.tasks.length,
      open: db.tasks.filter(task => task.status === "open").length,
      done: db.tasks.filter(task => task.status === "done").length,
      overdue: db.tasks.filter(task => overdue(task, localToday())).length,
    };
  }
}
try { console.log(JSON.stringify(await main())); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
