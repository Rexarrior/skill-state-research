import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type Task = { id: number; title: string; status: "open" | "done"; tags: string[]; createdAt: string; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const fail = (message: string): never => { throw new Error(message); };
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function iso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
const normalize = (value: string) => value.trim().toLowerCase();
function validate(value: any): Database {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const t of value.tasks) {
    if (!t || !Number.isSafeInteger(t.id) || t.id < 1 || t.id >= value.nextId || ids.has(t.id)
      || typeof t.title !== "string" || !t.title.trim() || !["open", "done"].includes(t.status)
      || !iso(t.createdAt) || !Array.isArray(t.tags)
      || t.tags.some((tag: unknown) => typeof tag !== "string" || !tag || normalize(tag) !== tag)
      || new Set(t.tags).size !== t.tags.length
      || (t.due !== undefined && !date(t.due))
      || (t.status === "done" ? !iso(t.completedAt) : t.completedAt !== undefined)) fail("Malformed database");
    ids.add(t.id);
  }
  return value;
}
async function load(path: string): Promise<Database> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error: any) {
    if (error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("Malformed database: invalid JSON"); }
  return validate(value);
}
async function save(path: string, db: Database) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
function flags(args: string[], allowed: string[]): Record<string, string> {
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
function today(): string {
  const now = new Date();
  return `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}
const overdue = (task: Task, day: string) => task.status === "open" && task.due !== undefined && task.due < day;
async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const options = command === "add" ? flags(args, ["--title", "--tags", "--due"])
    : command === "list" ? flags(args, ["--status", "--tag", "--overdue"]) : {};
  if (command === "add") {
    if (!options["--title"]?.trim()) fail("A non-empty --title is required");
    if (options["--due"] !== undefined && !date(options["--due"])) fail("Invalid due date; expected YYYY-MM-DD");
  }
  if (command === "list") {
    if (options["--status"] !== undefined && !["open", "done"].includes(options["--status"])) fail("Invalid status");
    if (options["--overdue"] !== undefined && !date(options["--overdue"])) fail("Invalid overdue date; expected YYYY-MM-DD");
    if (options["--tag"] !== undefined && !normalize(options["--tag"])) fail("Tag must not be empty");
  }
  if (command === "stats" && args.length) fail(`Unexpected argument: ${args[0]}`);
  if (["done", "delete"].includes(command) && (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0])))) fail("Expected one positive integer task ID");
  const path = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = await load(path);
  if (command === "list") return db.tasks.filter(t =>
    (options["--status"] === undefined || t.status === options["--status"])
    && (options["--tag"] === undefined || t.tags.includes(normalize(options["--tag"])))
    && (options["--overdue"] === undefined || overdue(t, options["--overdue"]))).sort((a, b) => a.id - b.id);
  if (command === "stats") return {
    total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length,
    done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, today())).length,
  };
  if (command === "add") {
    if (db.nextId >= Number.MAX_SAFE_INTEGER) fail("Task IDs exhausted");
    const task: Task = { id: db.nextId++, title: options["--title"].trim(), status: "open", createdAt: new Date().toISOString(), tags: [...new Set((options["--tags"] ?? "").split(",").map(normalize).filter(Boolean))] };
    if (options["--due"] !== undefined) task.due = options["--due"];
    db.tasks.push(task);
    await save(path, db);
    return task;
  }
  const task = db.tasks.find(t => t.id === Number(args[0]));
  if (!task) fail(`Task ${args[0]} not found`);
  if (command === "delete") db.tasks = db.tasks.filter(t => t.id !== task.id);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  await save(path, db);
  return task;
}
try { console.log(JSON.stringify(await main())); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
