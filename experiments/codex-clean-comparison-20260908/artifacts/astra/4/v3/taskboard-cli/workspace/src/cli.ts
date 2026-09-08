import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const fail = (message: string): never => { throw new Error(message); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
const normalize = (tag: string) => tag.trim().toLowerCase();
function validate(value: unknown): Database {
  const invalid = () => fail("Malformed database");
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return invalid();
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 || (task.id as number) >= (value.nextId as number) || ids.has(task.id as number)
      || typeof task.title !== "string" || !task.title.trim() || !["open", "done"].includes(task.status as string)
      || !timestamp(task.createdAt) || !Array.isArray(task.tags)
      || task.tags.some(tag => typeof tag !== "string" || !tag || normalize(tag) !== tag)
      || new Set(task.tags).size !== task.tags.length
      || ("due" in task && !validDate(task.due))
      || (task.status === "done" ? !timestamp(task.completedAt) : "completedAt" in task)) return invalid();
    ids.add(task.id as number);
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
function save(file: string, db: Database) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function flags(args: string[], allowed: string[]): Record<string, string> {
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
function main(args: string[]): unknown {
  const [command, ...rest] = args;
  if (!command || !["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const options = command === "add" ? flags(rest, ["--title", "--tags", "--due"])
    : command === "list" ? flags(rest, ["--status", "--tag", "--overdue"]) : {};
  let id = 0;
  if (command === "done" || command === "delete") {
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]! ) || !Number.isSafeInteger(Number(rest[0]))) fail("Expected one positive integer task ID");
    id = Number(rest[0]);
  }
  if (command === "stats" && rest.length) fail(`Unexpected argument: ${rest[0]}`);
  if (command === "add" && !options["--title"]?.trim()) fail("A nonempty --title is required");
  for (const flag of ["--due", "--overdue"]) if (flag in options && !validDate(options[flag])) fail(`Invalid date for ${flag}: expected YYYY-MM-DD`);
  if ("--status" in options && !["open", "done"].includes(options["--status"]!)) fail("Invalid status: expected open or done");
  if ("--tag" in options && !normalize(options["--tag"]!)) fail("Tag must not be empty");
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(file);
  if (command === "add") {
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID capacity exhausted");
    const task: Task = { id: db.nextId++, title: options["--title"]!.trim(), status: "open", createdAt: new Date().toISOString(), tags: [...new Set((options["--tags"] ?? "").split(",").map(normalize).filter(Boolean))] };
    if (options["--due"] !== undefined) task.due = options["--due"];
    db.tasks.push(task);
    save(file, db);
    return task;
  }
  if (command === "list") return db.tasks.filter(task =>
    (!options["--status"] || task.status === options["--status"])
    && (!options["--tag"] || task.tags.includes(normalize(options["--tag"])))
    && (!options["--overdue"] || (task.status === "open" && task.due !== undefined && task.due < options["--overdue"]))
  ).sort((a, b) => a.id - b.id);
  if (command === "stats") {
    const now = new Date();
    const today = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const open = db.tasks.filter(task => task.status === "open").length;
    return { total: db.tasks.length, open, done: db.tasks.length - open, overdue: db.tasks.filter(task => task.status === "open" && task.due !== undefined && task.due < today).length };
  }
  const task = db.tasks.find(task => task.id === id);
  if (!task) fail(`Task ${id} not found`);
  if (command === "delete") db.tasks = db.tasks.filter(task => task.id !== id);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  save(file, db);
  return task;
}
try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
