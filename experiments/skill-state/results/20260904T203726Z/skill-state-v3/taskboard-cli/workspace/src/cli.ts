import { dirname } from "node:path";
import { rename } from "node:fs/promises";

type Status = "open" | "done";

type Task = {
  id: number;
  title: string;
  tags: string[];
  status: Status;
  createdAt: string;
  due?: string;
  completedAt?: string;
};

type Database = { nextId: number; tasks: Task[] };

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function today(): string {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return Number.isSafeInteger(task.id) && (task.id as number) > 0 &&
    typeof task.title === "string" && task.title.trim().length > 0 &&
    Array.isArray(task.tags) && task.tags.every((tag) => typeof tag === "string") &&
    (task.status === "open" || task.status === "done") &&
    typeof task.createdAt === "string" && !Number.isNaN(Date.parse(task.createdAt)) &&
    (task.due === undefined || (typeof task.due === "string" && isDate(task.due))) &&
    (task.completedAt === undefined || (typeof task.completedAt === "string" && !Number.isNaN(Date.parse(task.completedAt))));
}

async function load(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { nextId: 1, tasks: [] };
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    fail("Malformed taskboard database");
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as Database).tasks) ||
      !Number.isSafeInteger((value as Database).nextId) || (value as Database).nextId < 1 ||
      !(value as Database).tasks.every(isTask)) {
    fail("Malformed taskboard database");
  }
  return value as Database;
}

async function save(database: Database): Promise<void> {
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await Bun.write(temporaryPath, JSON.stringify(database, null, 2) + "\n");
    await rename(temporaryPath, databasePath);
  } finally {
    const temporary = Bun.file(temporaryPath);
    if (await temporary.exists()) await temporary.delete();
  }
}

function parseOptions(args: string[], allowed: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !allowed.includes(flag) || value === undefined || options[flag] !== undefined) {
      fail(`Invalid option: ${flag ?? "missing"}`);
    }
    options[flag] = value;
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail("ID must be a positive integer");
  return id;
}

async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) fail("Missing command");
  const database = await load();

  if (command === "add") {
    const options = parseOptions(args, ["--title", "--tags", "--due"]);
    const title = options["--title"]?.trim();
    if (!title) fail("Title must not be empty");
    const due = options["--due"];
    if (due && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const tags = [...new Set((options["--tags"] || "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
    const task: Task = { id: database.nextId++, title, tags, status: "open", createdAt: new Date().toISOString() };
    if (due) task.due = due;
    database.tasks.push(task);
    await save(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(args, ["--status", "--tag", "--overdue"]);
    const status = options["--status"];
    if (status && status !== "open" && status !== "done") fail("Status must be open or done");
    const overdue = options["--overdue"];
    if (overdue && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const tag = options["--tag"]?.trim().toLowerCase();
    return database.tasks.filter((task) =>
      (!status || task.status === status) && (!tag || task.tags.includes(tag)) &&
      (!overdue || (task.status === "open" && !!task.due && task.due < overdue)),
    ).sort((a, b) => a.id - b.id);
  }

  if (command === "done" || command === "delete") {
    if (args.length !== 1) fail(`Usage: ${command} ID`);
    const id = parseId(args[0]);
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0) fail(`Task ${id} not found`);
    if (command === "delete") {
      const [deleted] = database.tasks.splice(index, 1);
      await save(database);
      return deleted;
    }
    const task = database.tasks[index];
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await save(database);
    }
    return task;
  }

  if (command === "stats") {
    if (args.length) fail("stats does not accept options");
    const open = database.tasks.filter((task) => task.status === "open");
    return { total: database.tasks.length, open: open.length, done: database.tasks.length - open.length, overdue: open.filter((task) => task.due && task.due < today()).length };
  }

  fail(`Unknown command: ${command}`);
}

main().then((result) => console.log(JSON.stringify(result))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
