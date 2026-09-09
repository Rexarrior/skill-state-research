import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const fail = (message: string): never => { throw new Error(message); };
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const normalize = (s: string) => s.trim().toLowerCase();
function date(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function timestamp(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
function validate(value: unknown): Database {
  const invalid = () => fail("Malformed taskboard database");
  if (!object(value) || value.version !== 1 || !positive(value.nextId) || !Array.isArray(value.tasks)) return invalid();
  const ids = new Set<number>();
  for (const t of value.tasks) {
    if (!object(t) || !positive(t.id) || ids.has(t.id) || t.id >= value.nextId ||
        typeof t.title !== "string" || !t.title.trim() || !["open", "done"].includes(t.status as string) ||
        !timestamp(t.createdAt) || !Array.isArray(t.tags) ||
        t.tags.some((tag: unknown) => typeof tag !== "string" || !tag || normalize(tag) !== tag) ||
        new Set(t.tags).size !== t.tags.length || (own(t, "due") && !date(t.due)) ||
        (t.status === "done" ? !timestamp(t.completedAt) : own(t, "completedAt"))) return invalid();
    ids.add(t.id);
  }
  return value as unknown as Database;
}
function load(file: string): Database {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail("Malformed taskboard database: invalid JSON"); }
  return validate(value);
}
function save(file: string, db: Database): void {
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
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
    if (own(result, key)) fail(`Duplicate flag: ${key}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) fail(`Missing value for ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}
function main(args: string[]): unknown {
  const [command, ...rest] = args;
  let opts: Record<string, string> = {};
  let id = 0;
  switch (command) {
    case "add":
      opts = flags(rest, ["--title", "--tags", "--due"]);
      if (!opts["--title"]?.trim()) fail("A non-empty --title is required");
      if (own(opts, "--due") && !date(opts["--due"])) fail("Invalid --due date; expected YYYY-MM-DD");
      break;
    case "list":
      opts = flags(rest, ["--status", "--tag", "--overdue"]);
      if (own(opts, "--status") && !["open", "done"].includes(opts["--status"])) fail("Invalid --status; expected open or done");
      if (own(opts, "--tag") && !normalize(opts["--tag"])) fail("--tag must not be empty");
      if (own(opts, "--overdue") && !date(opts["--overdue"])) fail("Invalid --overdue date; expected YYYY-MM-DD");
      break;
    case "done": case "delete":
      if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !positive(Number(rest[0]))) fail(`${command} requires one positive integer ID`);
      id = Number(rest[0]);
      break;
    case "stats":
      if (rest.length) fail("stats accepts no arguments");
      break;
    default: fail(`Unknown command: ${command ?? "(missing)"}`);
  }
  const file = process.env.TASKBOARD_FILE ?? ".taskboard.json";
  if (!file) fail("TASKBOARD_FILE must not be empty");
  const db = load(file);
  const overdue = (t: Task, day: string) => t.status === "open" && t.due !== undefined && t.due < day;
  if (command === "add") {
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID space exhausted");
    const task: Task = { id: db.nextId++, title: opts["--title"].trim(), status: "open", createdAt: new Date().toISOString(), tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalize).filter(Boolean))] };
    if (own(opts, "--due")) task.due = opts["--due"];
    db.tasks.push(task);
    save(file, db);
    return task;
  }
  if (command === "list") return db.tasks.filter(t =>
    (!own(opts, "--status") || t.status === opts["--status"]) &&
    (!own(opts, "--tag") || t.tags.includes(normalize(opts["--tag"]))) &&
    (!own(opts, "--overdue") || overdue(t, opts["--overdue"]))
  ).sort((a, b) => a.id - b.id);
  if (command === "stats") {
    const now = new Date();
    const today = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length, done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => overdue(t, today)).length };
  }
  const index = db.tasks.findIndex(t => t.id === id);
  if (index < 0) fail(`Task ${id} not found`);
  const task = db.tasks[index];
  if (command === "delete") db.tasks.splice(index, 1);
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
