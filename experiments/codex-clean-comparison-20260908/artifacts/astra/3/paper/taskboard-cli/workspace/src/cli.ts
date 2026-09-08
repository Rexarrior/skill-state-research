import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";

type Task = { id: number; title: string; status: "open" | "done"; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const fail = (message: string): never => { throw new Error(message); };
const tag = (value: string) => value.trim().toLowerCase();
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function validate(value: unknown): Database {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!object(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 || (task.id as number) >= (value.nextId as number) || ids.has(task.id as number)
      || typeof task.title !== "string" || !task.title.trim() || !["open", "done"].includes(task.status as string) || !timestamp(task.createdAt)
      || !Array.isArray(task.tags) || task.tags.some(t => typeof t !== "string" || !t || tag(t) !== t) || new Set(task.tags).size !== task.tags.length
      || (task.due !== undefined && !validDate(task.due)) || (task.status === "done" ? !timestamp(task.completedAt) : task.completedAt !== undefined)) fail("Malformed database");
    ids.add(task.id as number);
  }
  return value as unknown as Database;
}
async function load(file: string): Promise<Database> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] }; throw error; }
  try { return validate(JSON.parse(text)); } catch { return fail("Malformed database"); }
}
async function save(file: string, data: Database) {
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(data) + "\n", { flag: "wx" });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
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
async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  let options: Record<string, string> = {};
  let id = 0;
  switch (command) {
    case "add":
      options = flags(args, ["--title", "--tags", "--due"]);
      if (!options["--title"]?.trim()) fail("A non-empty --title is required");
      if ("--due" in options && !validDate(options["--due"])) fail("Invalid due date; expected YYYY-MM-DD");
      break;
    case "list":
      options = flags(args, ["--status", "--tag", "--overdue"]);
      if ("--status" in options && !["open", "done"].includes(options["--status"])) fail("Invalid status");
      if ("--overdue" in options && !validDate(options["--overdue"])) fail("Invalid overdue date; expected YYYY-MM-DD");
      break;
    case "done": case "delete":
      if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail("Expected one positive integer task ID");
      id = Number(args[0]);
      break;
    case "stats": if (args.length) fail(`Unknown flag or argument: ${args[0]}`); break;
    default: fail(`Unknown command: ${command ?? "(missing)"}`);
  }
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const data = await load(file);
  if (command === "add") {
    if (data.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID capacity exhausted");
    const task: Task = { id: data.nextId++, title: options["--title"].trim(), status: "open", createdAt: new Date().toISOString(), tags: [...new Set((options["--tags"] ?? "").split(",").map(tag).filter(Boolean))] };
    if ("--due" in options) task.due = options["--due"];
    data.tasks.push(task);
    await save(file, data);
    return task;
  }
  if (command === "list") return data.tasks.filter(task =>
    (!("--status" in options) || task.status === options["--status"])
    && (!("--tag" in options) || task.tags.includes(tag(options["--tag"])))
    && (!("--overdue" in options) || task.status === "open" && task.due !== undefined && task.due < options["--overdue"])
  ).sort((a, b) => a.id - b.id);
  if (command === "stats") {
    const now = new Date();
    const today = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return { total: data.tasks.length, open: data.tasks.filter(t => t.status === "open").length, done: data.tasks.filter(t => t.status === "done").length, overdue: data.tasks.filter(t => t.status === "open" && t.due !== undefined && t.due < today).length };
  }
  const task = data.tasks.find(t => t.id === id) ?? fail(`Task ${id} not found`);
  if (command === "delete") data.tasks = data.tasks.filter(t => t.id !== id);
  else if (task.status === "done") return task;
  else { task.status = "done"; task.completedAt = new Date().toISOString(); }
  await save(file, data);
  return task;
}
try { console.log(JSON.stringify(await main())); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
