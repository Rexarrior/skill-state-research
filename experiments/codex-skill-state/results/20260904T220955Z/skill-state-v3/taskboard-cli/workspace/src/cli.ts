import { rename, unlink } from "node:fs/promises";

type Status = "open" | "done";

type Task = {
  id: number;
  title: string;
  status: Status;
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
};

type Database = { nextId: number; tasks: Task[] };

const file = Bun.env.TASKBOARD_FILE || `${process.cwd()}/.taskboard.json`;

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function todayLocal(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function validTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return Number.isSafeInteger(task.id) && (task.id as number) > 0 &&
    typeof task.title === "string" && (task.status === "open" || task.status === "done") &&
    typeof task.createdAt === "string" && Array.isArray(task.tags) && task.tags.every((tag) => typeof tag === "string") &&
    (task.due === undefined || (typeof task.due === "string" && isDate(task.due))) &&
    (task.completedAt === undefined || typeof task.completedAt === "string");
}

async function load(): Promise<Database> {
  const path = Bun.file(file);
  if (!(await path.exists())) return { nextId: 1, tasks: [] };
  let value: unknown;
  try {
    value = JSON.parse(await path.text());
  } catch {
    fail(`Malformed database: ${file}`);
  }
  if (typeof value !== "object" || value === null) fail(`Malformed database: ${file}`);
  const db = value as Record<string, unknown>;
  if (!Number.isSafeInteger(db.nextId) || (db.nextId as number) < 1 || !Array.isArray(db.tasks) || !db.tasks.every(validTask)) {
    fail(`Malformed database: ${file}`);
  }
  const ids = new Set<number>();
  for (const task of db.tasks) {
    if (ids.has(task.id) || task.id >= (db.nextId as number)) fail(`Malformed database: ${file}`);
    ids.add(task.id);
  }
  return { nextId: db.nextId as number, tasks: db.tasks as Task[] };
}

async function save(db: Database): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await Bun.write(temp, `${JSON.stringify(db, null, 2)}\n`);
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* best effort */ }
    throw error;
  }
}

function parseOptions(args: string[], permitted: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!flag?.startsWith("--") || !permitted.includes(flag) || options[flag] !== undefined || args[i + 1] === undefined || args[i + 1].startsWith("--")) {
      fail(`Invalid option: ${flag ?? "(missing)"}`);
    }
    options[flag] = args[i + 1];
  }
  return options;
}

function normalizedTags(value: string | undefined): string[] {
  if (!value) return [];
  const tags = value.split(",").map((tag) => tag.trim().toLowerCase());
  if (tags.some((tag) => tag.length === 0)) fail("Tags must not be empty");
  return [...new Set(tags)];
}

function parseId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail("ID must be a positive integer");
  return Number(value);
}

async function main(): Promise<unknown> {
  const [command, ...args] = Bun.argv.slice(2);
  if (!command) fail("Missing command");
  const db = await load();

  if (command === "add") {
    const options = parseOptions(args, ["--title", "--tags", "--due"]);
    const title = options["--title"]?.trim();
    if (!title) fail("Title must not be empty");
    const due = options["--due"];
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const task: Task = { id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(), tags: normalizedTags(options["--tags"]), ...(due ? { due } : {}) };
    db.tasks.push(task);
    await save(db);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(args, ["--status", "--tag", "--overdue"]);
    if (options["--status"] !== undefined && options["--status"] !== "open" && options["--status"] !== "done") fail("Status must be open or done");
    if (options["--overdue"] !== undefined && !isDate(options["--overdue"])) fail("Overdue date must be a valid YYYY-MM-DD date");
    const tag = options["--tag"]?.trim().toLowerCase();
    if (options["--tag"] !== undefined && !tag) fail("Tag must not be empty");
    return db.tasks.filter((task) =>
      (options["--status"] === undefined || task.status === options["--status"]) &&
      (tag === undefined || task.tags.includes(tag)) &&
      (options["--overdue"] === undefined || (task.status === "open" && task.due !== undefined && task.due < options["--overdue"])),
    ).sort((a, b) => a.id - b.id);
  }

  if (command === "done" || command === "delete") {
    if (args.length !== 1) fail(`${command} requires exactly one ID`);
    const id = parseId(args[0]);
    const index = db.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`Task not found: ${id}`);
    if (command === "delete") {
      const [deleted] = db.tasks.splice(index, 1);
      await save(db);
      return deleted;
    }
    const task = db.tasks[index];
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await save(db);
    }
    return task;
  }

  if (command === "stats") {
    if (args.length) fail("stats takes no arguments");
    const today = todayLocal();
    const open = db.tasks.filter((task) => task.status === "open");
    return { total: db.tasks.length, open: open.length, done: db.tasks.length - open.length, overdue: open.filter((task) => task.due !== undefined && task.due < today).length };
  }
  fail(`Unknown command: ${command}`);
}

main().then((result) => console.log(JSON.stringify(result))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
