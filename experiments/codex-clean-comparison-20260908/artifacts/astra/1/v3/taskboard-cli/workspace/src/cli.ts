import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

interface Task {
  id: number;
  title: string;
  status: "open" | "done";
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
}
interface Database { version: 1; nextId: number; tasks: Task[] }
const file = process.env.TASKBOARD_FILE ?? ".taskboard.json";
const fail = (message: string): never => { throw new Error(message); };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const normalizeTag = (tag: string) => tag.trim().toLowerCase();
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
function validateDatabase(value: unknown): asserts value is Database {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        !["open", "done"].includes(task.status as string) || !validTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !validTimestamp(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database");
    }
    ids.add(task.id as number);
  }
}
async function load(): Promise<Database> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { fail("Malformed database: invalid JSON"); }
  validateDatabase(data);
  return data;
}
async function save(data: Database): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
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
function dateFlag(value: string | undefined, flag: string) {
  if (value !== undefined && !validDate(value)) fail(`Invalid ${flag}: expected a real YYYY-MM-DD date`);
}
function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
const overdue = (task: Task, date: string) => task.status === "open" && task.due !== undefined && task.due < date;
async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  if (command === "add") {
    const options = flags(args, ["--title", "--tags", "--due"]);
    const title = options["--title"]?.trim();
    if (!title) fail("A nonempty --title is required");
    dateFlag(options["--due"], "--due");
    const data = await load();
    if (data.nextId === Number.MAX_SAFE_INTEGER) fail("Task IDs exhausted");
    const task: Task = { id: data.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((options["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))] };
    if (options["--due"] !== undefined) task.due = options["--due"];
    data.tasks.push(task);
    await save(data);
    return task;
  }
  if (command === "list") {
    const options = flags(args, ["--status", "--tag", "--overdue"]);
    if (options["--status"] !== undefined && !["open", "done"].includes(options["--status"])) fail("Invalid --status: expected open or done");
    dateFlag(options["--overdue"], "--overdue");
    const tag = options["--tag"] === undefined ? undefined : normalizeTag(options["--tag"]);
    if (tag === "") fail("A nonempty --tag is required");
    const data = await load();
    return data.tasks.filter(task =>
      (options["--status"] === undefined || task.status === options["--status"]) &&
      (tag === undefined || task.tags.includes(tag)) &&
      (options["--overdue"] === undefined || overdue(task, options["--overdue"])))
      .sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    if (args.length) fail(`Unexpected argument: ${args[0]}`);
    const { tasks } = await load();
    const today = localToday();
    return { total: tasks.length, open: tasks.filter(t => t.status === "open").length,
      done: tasks.filter(t => t.status === "done").length, overdue: tasks.filter(t => overdue(t, today)).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail("Expected one positive integer task ID");
  const data = await load();
  const index = data.tasks.findIndex(task => task.id === Number(args[0]));
  if (index === -1) fail(`Task ${args[0]} not found`);
  const task = data.tasks[index];
  if (command === "delete") data.tasks.splice(index, 1);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  await save(data);
  return task;
}
try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
