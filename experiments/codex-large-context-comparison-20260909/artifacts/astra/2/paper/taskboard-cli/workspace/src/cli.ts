import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const normalize = (text: string) => text.trim().toLowerCase();
function dateValid(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isoValid(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validate(value: unknown): asserts value is Database {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.tasks)) throw new Error("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || task.id < 1 || task.id >= value.nextId || ids.has(task.id) ||
        typeof task.title !== "string" || !task.title.trim() || !["open", "done"].includes(task.status) || !isoValid(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some((tag: unknown) => typeof tag !== "string" || !tag || tag !== normalize(tag)) || new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !dateValid(task.due)) || (task.status === "done" ? !isoValid(task.completedAt) : "completedAt" in task)) throw new Error("Malformed database");
    ids.add(task.id);
  }
}
function load(file: string): Database {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Malformed database: invalid JSON"); }
  validate(value);
  return value;
}
function save(file: string, db: Database) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.includes(flag)) throw new Error(`Unknown flag or argument: ${flag}`);
    if (Object.hasOwn(result, flag)) throw new Error(`Duplicate flag: ${flag}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
    result[flag] = args[i + 1];
  }
  return result;
}
function today(): string {
  const date = new Date();
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) throw new Error(`Unknown command: ${command ?? "(missing)"}`);
  const flags = command === "add" ? options(args, ["--title", "--tags", "--due"]) : command === "list" ? options(args, ["--status", "--tag", "--overdue"]) : {};
  if (command === "add" && !flags["--title"]?.trim()) throw new Error("A nonempty --title is required");
  for (const flag of ["--due", "--overdue"]) if (flag in flags && !dateValid(flags[flag])) throw new Error(`Invalid date for ${flag}: expected a real YYYY-MM-DD`);
  if ("--status" in flags && !["open", "done"].includes(flags["--status"])) throw new Error("Invalid status");
  if ("--tag" in flags && !normalize(flags["--tag"])) throw new Error("Tag must be nonempty");
  if (command === "stats" && args.length) throw new Error("stats accepts no arguments");
  let id = 0;
  if (command === "done" || command === "delete") {
    if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) throw new Error("Expected one positive integer task ID");
    id = Number(args[0]);
  }
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(file);
  if (command === "add") {
    if (db.nextId >= Number.MAX_SAFE_INTEGER) throw new Error("Task ID range exhausted");
    const task: Task = { id: db.nextId++, title: flags["--title"].trim(), status: "open", createdAt: new Date().toISOString(), tags: [...new Set((flags["--tags"] ?? "").split(",").map(normalize).filter(Boolean))] };
    if ("--due" in flags) task.due = flags["--due"];
    db.tasks.push(task);
    save(file, db);
    return task;
  }
  const overdue = (task: Task, date: string) => task.status === "open" && task.due !== undefined && task.due < date;
  if (command === "list") return db.tasks.filter(task =>
    (!("--status" in flags) || task.status === flags["--status"]) &&
    (!("--tag" in flags) || task.tags.includes(normalize(flags["--tag"]))) &&
    (!("--overdue" in flags) || overdue(task, flags["--overdue"]))).sort((a, b) => a.id - b.id);
  if (command === "stats") return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length, done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, today())).length };
  const task = db.tasks.find(task => task.id === id);
  if (!task) throw new Error(`Task ${id} does not exist`);
  if (command === "delete") db.tasks = db.tasks.filter(task => task.id !== id);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  save(file, db);
  return task;
}
try { console.log(JSON.stringify(main())); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log("null");
  process.exitCode = 1;
}
