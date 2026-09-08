import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";

 type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
 type Database = { version: 1; nextId: number; tasks: Task[] };

function fail(message: string): never { throw new Error(message); }
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
function tag(value: string): string { return value.trim().toLowerCase(); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validDatabase(value: unknown): value is Database {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return false;
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!object(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 || (task.id as number) >= (value.nextId as number) || ids.has(task.id as number)) return false;
    ids.add(task.id as number);
    if (typeof task.title !== "string" || !task.title.trim() || !iso(task.createdAt) || !["open", "done"].includes(task.status as string)) return false;
    if (!Array.isArray(task.tags) || task.tags.some(t => typeof t !== "string" || !t || tag(t) !== t) || new Set(task.tags).size !== task.tags.length) return false;
    if ("due" in task && !date(task.due)) return false;
    if (task.status === "done" ? !iso(task.completedAt) : "completedAt" in task) return false;
  }
  return true;
}
function load(file: string): Database {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("Malformed database: invalid JSON"); }
  if (!validDatabase(value)) fail("Malformed database: invalid schema");
  return value;
}
function save(file: string, database: Database): void {
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temp, JSON.stringify(database, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temp, file);
  } finally {
    if (created) { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
}
function options(args: string[], allowed: string[]): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key)) fail(`Unknown flag or argument: ${key}`);
    if (key in values) fail(`Duplicate flag: ${key}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) fail(`Missing value for ${key}`);
    values[key] = args[i + 1];
  }
  return values;
}
function today(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function overdue(task: Task, day: string): boolean { return task.status === "open" && task.due !== undefined && task.due < day; }
function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(file);
  if (command === "add") {
    const opts = options(args, ["--title", "--tags", "--due"]);
    const title = opts["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    if ("--due" in opts && !date(opts["--due"])) fail("Invalid due date: expected a real YYYY-MM-DD date");
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID space exhausted");
    const task: Task = { id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(), tags: [...new Set((opts["--tags"] ?? "").split(",").map(tag).filter(Boolean))] };
    if ("--due" in opts) task.due = opts["--due"];
    db.tasks.push(task);
    save(file, db);
    return task;
  }
  if (command === "list") {
    const opts = options(args, ["--status", "--tag", "--overdue"]);
    if ("--status" in opts && !["open", "done"].includes(opts["--status"])) fail("Status must be open or done");
    if ("--overdue" in opts && !date(opts["--overdue"])) fail("Invalid overdue date: expected a real YYYY-MM-DD date");
    if ("--tag" in opts && !tag(opts["--tag"])) fail("Tag must not be empty");
    return db.tasks.filter(t => (!("--status" in opts) || t.status === opts["--status"]) && (!("--tag" in opts) || t.tags.includes(tag(opts["--tag"]))) && (!("--overdue" in opts) || overdue(t, opts["--overdue"]))).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    options(args, []);
    const day = today();
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length, done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, day)).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail(`${command} requires one positive integer ID`);
  const index = db.tasks.findIndex(t => t.id === Number(args[0]));
  if (index === -1) fail(`Task ${args[0]} does not exist`);
  const task = db.tasks[index];
  if (command === "delete") db.tasks.splice(index, 1);
  else {
    if (task.status === "done") return task;
    task.status = "done";
    task.completedAt = new Date().toISOString();
  }
  save(file, db);
  return task;
}
try { console.log(JSON.stringify(main())); }
catch (error) {
  console.error(`taskboard: ${error instanceof Error ? error.message : String(error)}`);
  console.log("null");
  process.exitCode = 1;
}
