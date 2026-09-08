import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
const fail = (message: string): never => { throw new Error(message); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const normalize = (tag: string) => tag.trim().toLowerCase();
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
function validate(value: unknown): Database {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 || (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
      typeof task.title !== "string" || !task.title.trim() || !["open", "done"].includes(task.status as string) || !iso(task.createdAt) ||
      !Array.isArray(task.tags) || !task.tags.every(tag => typeof tag === "string" && tag.length > 0 && tag === normalize(tag)) || new Set(task.tags).size !== task.tags.length ||
      ("due" in task && !date(task.due)) || (task.status === "done" ? !iso(task.completedAt) : "completedAt" in task)) fail("Malformed database");
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
async function save(db: Database) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
function options(args: string[], allowed: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (Object.hasOwn(result, flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}
function localToday() {
  const now = new Date();
  return `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}
const overdue = (task: Task, day: string) => task.status === "open" && task.due !== undefined && task.due < day;
async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  let opts: Record<string, string> = {};
  let id: number | undefined;
  if (command === "add") {
    opts = options(args, ["--title", "--tags", "--due"]);
    if (!opts["--title"]?.trim()) fail("A non-empty --title is required");
    if (opts["--due"] !== undefined && !date(opts["--due"])) fail("Invalid due date; expected YYYY-MM-DD");
  } else if (command === "list") {
    opts = options(args, ["--status", "--tag", "--overdue"]);
    if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"])) fail("Invalid status");
    if (opts["--tag"] !== undefined && !normalize(opts["--tag"])) fail("Tag cannot be empty");
    if (opts["--overdue"] !== undefined && !date(opts["--overdue"])) fail("Invalid overdue date; expected YYYY-MM-DD");
  } else if (command === "stats") {
    if (args.length) fail("stats accepts no arguments");
  } else {
    if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail("Expected one positive integer task ID");
    id = Number(args[0]);
  }
  const db = await load();
  if (command === "add") {
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
    const task: Task = { id: db.nextId++, title: opts["--title"].trim(), status: "open", createdAt: new Date().toISOString(), tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalize).filter(Boolean))] };
    if (opts["--due"] !== undefined) task.due = opts["--due"];
    db.tasks.push(task);
    await save(db);
    return task;
  }
  if (command === "list") return db.tasks.filter(task =>
    (opts["--status"] === undefined || task.status === opts["--status"]) &&
    (opts["--tag"] === undefined || task.tags.includes(normalize(opts["--tag"]))) &&
    (opts["--overdue"] === undefined || overdue(task, opts["--overdue"]))).sort((a, b) => a.id - b.id);
  if (command === "stats") return { total: db.tasks.length, open: db.tasks.filter(task => task.status === "open").length, done: db.tasks.filter(task => task.status === "done").length, overdue: db.tasks.filter(task => overdue(task, localToday())).length };
  const task = db.tasks.find(task => task.id === id);
  if (!task) fail(`Task ${id} not found`);
  if (command === "delete") db.tasks = db.tasks.filter(item => item.id !== id);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  await save(db);
  return task;
}
try { console.log(JSON.stringify(await main())); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
