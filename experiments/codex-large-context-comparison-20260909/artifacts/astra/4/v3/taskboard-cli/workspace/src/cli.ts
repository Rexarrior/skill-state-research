import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const fail = (message: string): never => { throw new Error(message); };
const tag = (value: string) => value.trim().toLowerCase();
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validDatabase(value: unknown): value is Database {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return false;
  const ids = new Set<number>();
  return value.tasks.every((task: unknown) => {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 || (task.id as number) >= (value.nextId as number) || ids.has(task.id as number)) return false;
    ids.add(task.id as number);
    return typeof task.title === "string" && task.title.trim().length > 0 &&
      (task.status === "open" || task.status === "done") && timestamp(task.createdAt) &&
      Array.isArray(task.tags) && task.tags.every(t => typeof t === "string" && t.length > 0 && tag(t) === t) && new Set(task.tags).size === task.tags.length &&
      (task.due === undefined || date(task.due)) &&
      (task.status === "done" ? timestamp(task.completedAt) : task.completedAt === undefined);
  });
}
function load(path: string): Database {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail("Malformed database: invalid JSON"); }
  if (!validDatabase(value)) fail("Malformed database: invalid structure");
  return value as Database;
}
function save(path: string, db: Database) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
function today(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
const overdue = (task: Task, day: string) => task.status === "open" && task.due !== undefined && task.due < day;
function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const path = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(path);
  if (command === "add") {
    const flags = options(args, ["--title", "--tags", "--due"]);
    const title = flags["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    if (flags["--due"] !== undefined && !date(flags["--due"])) fail("Invalid due date; expected YYYY-MM-DD");
    if (db.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID capacity exceeded");
    const task: Task = { id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(), tags: [...new Set((flags["--tags"] ?? "").split(",").map(tag).filter(Boolean))] };
    if (flags["--due"] !== undefined) task.due = flags["--due"];
    db.tasks.push(task);
    save(path, db);
    return task;
  }
  if (command === "list") {
    const flags = options(args, ["--status", "--tag", "--overdue"]);
    if (flags["--status"] !== undefined && !["open", "done"].includes(flags["--status"])) fail("Invalid status");
    if (flags["--tag"] !== undefined && !tag(flags["--tag"])) fail("Tag must not be empty");
    if (flags["--overdue"] !== undefined && !date(flags["--overdue"])) fail("Invalid overdue date; expected YYYY-MM-DD");
    return db.tasks.filter(task =>
      (flags["--status"] === undefined || task.status === flags["--status"]) &&
      (flags["--tag"] === undefined || task.tags.includes(tag(flags["--tag"]))) &&
      (flags["--overdue"] === undefined || overdue(task, flags["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    options(args, []);
    const day = today();
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length, done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, day)).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail("Expected one positive integer task ID");
  const task = db.tasks.find(t => t.id === Number(args[0]));
  if (!task) fail(`Task ${args[0]} not found`);
  if (command === "delete") db.tasks = db.tasks.filter(t => t.id !== task!.id);
  else if (task!.status === "done") return task;
  else { task!.status = "done"; task!.completedAt = new Date().toISOString(); }
  save(path, db);
  return task;
}
try { console.log(JSON.stringify(main())); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log("null");
  process.exitCode = 1;
}
