import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
type Options = Record<string, string>;

function fail(message: string): never { throw new Error(message); }
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
function normalizeTag(tag: string): string { return tag.trim().toLowerCase(); }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateDatabase(value: unknown): Database {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!object(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !isISO(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !isDate(task.due)) ||
        (task.status === "done" ? !isISO(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database");
    }
    ids.add(task.id as number);
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
async function save(file: string, database: Database): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(database, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
function options(args: string[], allowed: string[]): Options {
  const result: Options = Object.create(null);
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
function taskId(args: string[]): number {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) {
    fail("Expected one positive integer task ID");
  }
  return Number(args[0]);
}
function checkDate(opts: Options, flag: string): void {
  if (flag in opts && !isDate(opts[flag])) fail(`Invalid date for ${flag}: expected YYYY-MM-DD`);
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
  let opts: Options = {};
  let id = 0;
  switch (command) {
    case "add":
      opts = options(args, ["--title", "--tags", "--due"]);
      if (!opts["--title"]?.trim()) fail("A non-empty --title is required");
      checkDate(opts, "--due");
      break;
    case "list":
      opts = options(args, ["--status", "--tag", "--overdue"]);
      if ("--status" in opts && !["open", "done"].includes(opts["--status"])) fail("Status must be open or done");
      if ("--tag" in opts && !normalizeTag(opts["--tag"])) fail("Tag must not be empty");
      checkDate(opts, "--overdue");
      break;
    case "done": case "delete": id = taskId(args); break;
    case "stats": options(args, []); break;
    default: fail(`Unknown command: ${command ?? "(missing)"}`);
  }
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const database = await load(file);
  switch (command) {
    case "add": {
      if (database.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID space exhausted");
      const task: Task = {
        id: database.nextId++, title: opts["--title"].trim(), status: "open",
        createdAt: new Date().toISOString(),
        tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
        ...("--due" in opts ? { due: opts["--due"] } : {}),
      };
      database.tasks.push(task);
      await save(file, database);
      return task;
    }
    case "list": return database.tasks.filter(task =>
      (!("--status" in opts) || task.status === opts["--status"]) &&
      (!("--tag" in opts) || task.tags.includes(normalizeTag(opts["--tag"]))) &&
      (!("--overdue" in opts) || overdue(task, opts["--overdue"]))
    ).sort((a, b) => a.id - b.id);
    case "done": case "delete": {
      const task = database.tasks.find(task => task.id === id);
      if (!task) fail(`Task ${id} not found`);
      if (command === "delete") database.tasks = database.tasks.filter(task => task.id !== id);
      else if (task.status === "done") return task;
      else { task.status = "done"; task.completedAt = new Date().toISOString(); }
      await save(file, database);
      return task;
    }
    case "stats": {
      const today = localToday();
      const done = database.tasks.filter(task => task.status === "done").length;
      return { total: database.tasks.length, open: database.tasks.length - done, done,
        overdue: database.tasks.filter(task => overdue(task, today)).length };
    }
  }
}
try { console.log(JSON.stringify(await main())); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log("null");
  process.exitCode = 1;
}
