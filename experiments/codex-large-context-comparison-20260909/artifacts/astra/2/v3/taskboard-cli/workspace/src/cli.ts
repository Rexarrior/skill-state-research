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
function validId(id: unknown): id is number {
  return Number.isSafeInteger(id) && (id as number) > 0;
}
function validateDatabase(value: unknown): Database {
  const invalid = () => fail("Malformed database");
  if (!record(value) || value.version !== 1 || !validId(value.nextId) || !Array.isArray(value.tasks)) return invalid();
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !validId(task.id) || ids.has(task.id) || task.id >= value.nextId ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !validTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || tag !== normalizeTag(tag)) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !validTimestamp(task.completedAt) : "completedAt" in task)) return invalid();
    ids.add(task.id);
  }
  return value as Database;
}
async function load(file: string): Promise<Database> {
  let contents: string;
  try { contents = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(contents); } catch { fail("Malformed database: invalid JSON"); }
  return validateDatabase(value);
}
async function save(file: string, db: Database): Promise<void> {
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(db, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
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
function requireDate(value: string | undefined, flag: string): void {
  if (value !== undefined && !validDate(value)) fail(`Invalid date for ${flag}: expected YYYY-MM-DD`);
}
function today(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}
async function main(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  let opts: Record<string, string> = {};
  let id: number | undefined;
  if (command === "add") {
    opts = options(rest, ["--title", "--tags", "--due"]);
    if (!opts["--title"]?.trim()) fail("A non-empty --title is required");
    requireDate(opts["--due"], "--due");
  } else if (command === "list") {
    opts = options(rest, ["--status", "--tag", "--overdue"]);
    if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"])) fail("Invalid status: expected open or done");
    if (opts["--tag"] !== undefined && !normalizeTag(opts["--tag"])) fail("Tag must not be empty");
    requireDate(opts["--overdue"], "--overdue");
  } else if (command === "stats") {
    if (rest.length) fail(`Unexpected argument: ${rest[0]}`);
  } else {
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !validId(Number(rest[0]))) fail("Expected one positive integer task ID");
    id = Number(rest[0]);
  }
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = await load(file);
  if (command === "add") {
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID capacity exhausted");
    const task: Task = {
      id: db.nextId++, title: opts["--title"].trim(), status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
      ...(opts["--due"] !== undefined ? { due: opts["--due"] } : {}),
    };
    db.tasks.push(task);
    await save(file, db);
    return task;
  }
  if (command === "list") {
    return db.tasks.filter(task =>
      (opts["--status"] === undefined || task.status === opts["--status"]) &&
      (opts["--tag"] === undefined || task.tags.includes(normalizeTag(opts["--tag"]))) &&
      (opts["--overdue"] === undefined || overdue(task, opts["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    const date = today();
    return { total: db.tasks.length, open: db.tasks.filter(task => task.status === "open").length,
      done: db.tasks.filter(task => task.status === "done").length,
      overdue: db.tasks.filter(task => overdue(task, date)).length };
  }
  const index = db.tasks.findIndex(task => task.id === id);
  if (index === -1) fail(`Task ${id} not found`);
  const task = db.tasks[index];
  if (command === "delete") db.tasks.splice(index, 1);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  await save(file, db);
  return task;
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
