import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  tags: string[];
  status: Status;
  createdAt: string;
  due?: string;
  completedAt?: string;
}

interface Database {
  nextId: number;
  tasks: Task[];
}

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function localDate(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function validateDatabase(value: unknown): Database {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Malformed taskboard database.");
  const db = value as Partial<Database>;
  if (!Number.isSafeInteger(db.nextId) || (db.nextId as number) < 1 || !Array.isArray(db.tasks)) {
    fail("Malformed taskboard database.");
  }
  const ids = new Set<number>();
  for (const task of db.tasks) {
    if (!task || typeof task !== "object" || !Number.isSafeInteger(task.id) || task.id < 1 ||
      ids.has(task.id) || typeof task.title !== "string" || !task.title.trim() ||
      !Array.isArray(task.tags) || !task.tags.every((tag) => typeof tag === "string") ||
      (task.status !== "open" && task.status !== "done") || typeof task.createdAt !== "string" ||
      (task.due !== undefined && (typeof task.due !== "string" || !isDate(task.due))) ||
      (task.completedAt !== undefined && typeof task.completedAt !== "string")) {
      fail("Malformed taskboard database.");
    }
    if (task.status === "done" && typeof task.completedAt !== "string") fail("Malformed taskboard database.");
    ids.add(task.id);
  }
  if (db.nextId <= Math.max(0, ...ids)) fail("Malformed taskboard database.");
  return db as Database;
}

async function loadDatabase(): Promise<Database> {
  try {
    return validateDatabase(JSON.parse(await readFile(databasePath, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    if (error instanceof SyntaxError) fail("Malformed taskboard database.");
    throw error;
  }
}

async function saveDatabase(db: Database): Promise<void> {
  const directory = dirname(databasePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${databasePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await rename(temporaryPath, databasePath);
}

function parseOptions(args: string[], allowed: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.includes(flag) || value === undefined || value.startsWith("--") || options.has(flag)) {
      fail(`Invalid option: ${flag ?? ""}`.trim());
    }
    options.set(flag, value);
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) fail("Task id must be a positive integer.");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail("Task id must be a positive integer.");
  return id;
}

function tagsFrom(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("A command is required.");

  if (command === "add") {
    const options = parseOptions(rest, ["--title", "--tags", "--due"]);
    const title = options.get("--title")?.trim();
    const due = options.get("--due");
    if (!title) fail("A non-empty title is required.");
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date.");
    const db = await loadDatabase();
    const task: Task = { id: db.nextId++, title, tags: tagsFrom(options.get("--tags")), status: "open", createdAt: new Date().toISOString() };
    if (due !== undefined) task.due = due;
    db.tasks.push(task);
    await saveDatabase(db);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, ["--status", "--tag", "--overdue"]);
    const status = options.get("--status");
    const tag = options.get("--tag")?.trim().toLowerCase();
    const overdue = options.get("--overdue");
    if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done.");
    if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date.");
    const db = await loadDatabase();
    return db.tasks.filter((task) =>
      (status === undefined || task.status === status) &&
      (!tag || task.tags.includes(tag)) &&
      (overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue)),
    ).sort((a, b) => a.id - b.id);
  }

  if (command === "done" || command === "delete") {
    if (rest.length !== 1) fail(`${command} requires exactly one task id.`);
    const db = await loadDatabase();
    const index = db.tasks.findIndex((task) => task.id === parseId(rest[0]));
    if (index === -1) fail("Task not found.");
    if (command === "delete") {
      const [deleted] = db.tasks.splice(index, 1);
      await saveDatabase(db);
      return deleted;
    }
    const task = db.tasks[index];
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(db);
    }
    return task;
  }

  if (command === "stats") {
    if (rest.length) fail("stats does not accept arguments.");
    const tasks = (await loadDatabase()).tasks;
    const today = localDate();
    return {
      total: tasks.length,
      open: tasks.filter((task) => task.status === "open").length,
      done: tasks.filter((task) => task.status === "done").length,
      overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`Unknown command: ${command}`);
}

run(process.argv.slice(2)).then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
