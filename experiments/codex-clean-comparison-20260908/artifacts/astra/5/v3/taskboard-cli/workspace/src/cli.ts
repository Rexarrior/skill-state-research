import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { nextId: number; tasks: Task[] };
const fail = (message: string): never => { throw new Error(message); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const iso = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const tag = (value: string): string => value.trim().toLowerCase();
function load(file: string): Database {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { return fail("Malformed database: invalid JSON"); }
  if (!record(data) || !Number.isSafeInteger(data.nextId) || (data.nextId as number) < 1 || !Array.isArray(data.tasks)) fail("Malformed database");
  const db = data as unknown as Database;
  const ids = new Set<number>();
  for (const task of db.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || task.id < 1 || task.id >= db.nextId || ids.has(task.id)
      || typeof task.title !== "string" || !task.title.trim() || !["open", "done"].includes(task.status)
      || !iso(task.createdAt) || !Array.isArray(task.tags)
      || task.tags.some(t => typeof t !== "string" || !t || tag(t) !== t)
      || new Set(task.tags).size !== task.tags.length
      || ("due" in task && !validDate(task.due))
      || (task.status === "done" ? !iso(task.completedAt) : "completedAt" in task)) fail("Malformed database: invalid task");
    ids.add(task.id);
  }
  return db;
}
function save(file: string, db: Database): void {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, file);
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
  return `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}
function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(file);
  if (command === "add") {
    const opts = options(args, ["--title", "--tags", "--due"]);
    const title = opts["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    if ("--due" in opts && !validDate(opts["--due"])) fail("Invalid due date; expected YYYY-MM-DD");
    if (db.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
    const task: Task = { id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(), tags: [...new Set((opts["--tags"] ?? "").split(",").map(tag).filter(Boolean))] };
    if ("--due" in opts) task.due = opts["--due"];
    db.tasks.push(task);
    save(file, db);
    return task;
  }
  if (command === "list") {
    const opts = options(args, ["--status", "--tag", "--overdue"]);
    if ("--status" in opts && !["open", "done"].includes(opts["--status"])) fail("Invalid status; expected open or done");
    if ("--overdue" in opts && !validDate(opts["--overdue"])) fail("Invalid overdue date; expected YYYY-MM-DD");
    return db.tasks.filter(t => (!("--status" in opts) || t.status === opts["--status"])
      && (!("--tag" in opts) || t.tags.includes(tag(opts["--tag"])))
      && (!("--overdue" in opts) || (t.status === "open" && t.due !== undefined && t.due < opts["--overdue"])))
      .sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    if (args.length) fail(`Unexpected argument: ${args[0]}`);
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === "open").length, done: db.tasks.filter(t => t.status === "done").length, overdue: db.tasks.filter(t => t.status === "open" && t.due !== undefined && t.due < today()).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail(`${command} requires one positive integer ID`);
  const index = db.tasks.findIndex(t => t.id === Number(args[0]));
  if (index === -1) fail(`Task ${args[0]} not found`);
  const task = db.tasks[index];
  if (command === "delete") db.tasks.splice(index, 1);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  save(file, db);
  return task;
}
try { console.log(JSON.stringify(main())); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
