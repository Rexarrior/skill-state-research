import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const fail = (message: string): never => { throw new Error(message); };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
const normalizeTag = (tag: string) => tag.trim().toLowerCase();
function validate(value: unknown): Database {
  const invalid = () => fail("Malformed database");
  if (!object(value) || value.version !== 1 || !integer(value.nextId) || !Array.isArray(value.tasks)) return invalid();
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!object(task) || !integer(task.id) || task.id >= value.nextId || ids.has(task.id)
      || typeof task.title !== "string" || !task.title.trim()
      || (task.status !== "open" && task.status !== "done") || !timestamp(task.createdAt)
      || !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag)
      || new Set(task.tags).size !== task.tags.length
      || ("due" in task && !date(task.due))
      || (task.status === "done" ? !timestamp(task.completedAt) : "completedAt" in task)) return invalid();
    ids.add(task.id);
  }
  return value as Database;
}
function load(file: string): Database {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail("Malformed database: invalid JSON"); }
  return validate(value);
}
function save(file: string, db: Database): void {
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(db, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
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
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
const overdue = (task: Task, day: string) => task.status === "open" && task.due !== undefined && task.due < day;
function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(file);
  if (command === "add") {
    const options = flags(args, ["--title", "--tags", "--due"]);
    const title = options["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    if ("--due" in options && !date(options["--due"])) fail("Invalid due date; expected a real YYYY-MM-DD date");
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
    const task: Task = { id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(), tags: [...new Set((options["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))] };
    if ("--due" in options) task.due = options["--due"];
    db.tasks.push(task);
    save(file, db);
    return task;
  }
  if (command === "list") {
    const options = flags(args, ["--status", "--tag", "--overdue"]);
    if ("--status" in options && !["open", "done"].includes(options["--status"])) fail("Status must be open or done");
    if ("--overdue" in options && !date(options["--overdue"])) fail("Invalid overdue date; expected a real YYYY-MM-DD date");
    if ("--tag" in options && !normalizeTag(options["--tag"])) fail("Tag must not be empty");
    return db.tasks.filter(task => (!("--status" in options) || task.status === options["--status"])
      && (!("--tag" in options) || task.tags.includes(normalizeTag(options["--tag"])))
      && (!("--overdue" in options) || overdue(task, options["--overdue"]))).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    flags(args, []);
    const day = today();
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length, done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, day)).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !integer(Number(args[0]))) fail(`${command} requires one positive integer ID`);
  const task = db.tasks.find(t => t.id === Number(args[0]));
  if (!task) fail(`Task ${args[0]} not found`);
  if (command === "delete") db.tasks = db.tasks.filter(t => t.id !== task.id);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  save(file, db);
  return task;
}
try {
  console.log(JSON.stringify(main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
