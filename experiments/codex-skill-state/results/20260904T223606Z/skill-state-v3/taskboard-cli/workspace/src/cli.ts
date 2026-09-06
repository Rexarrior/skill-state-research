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

const databaseFile = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validTask(value: unknown): value is Task {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  if (!Number.isSafeInteger(task.id) || (task.id as number) < 1) return false;
  if (typeof task.title !== "string" || !task.title.trim()) return false;
  if (task.status !== "open" && task.status !== "done") return false;
  if (!Array.isArray(task.tags) || !task.tags.every((tag) => typeof tag === "string" && tag === tag.trim().toLowerCase() && tag.length > 0)) return false;
  if (new Set(task.tags).size !== task.tags.length || !validIso(task.createdAt)) return false;
  if (task.due !== undefined && (typeof task.due !== "string" || !validDate(task.due))) return false;
  if (task.completedAt !== undefined && !validIso(task.completedAt)) return false;
  return task.status === "done" ? task.completedAt !== undefined : task.completedAt === undefined;
}

async function load(): Promise<Database> {
  const source = Bun.file(databaseFile);
  if (!(await source.exists())) return { nextId: 1, tasks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await source.text());
  } catch {
    fail("Malformed taskboard database");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Malformed taskboard database");
  const db = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(db.nextId) || (db.nextId as number) < 1 || !Array.isArray(db.tasks) || !db.tasks.every(validTask)) fail("Malformed taskboard database");
  const ids = db.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (db.nextId as number))) fail("Malformed taskboard database");
  return { nextId: db.nextId as number, tasks: db.tasks as Task[] };
}

async function save(db: Database): Promise<void> {
  const target = databaseFile;
  const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temp, `${JSON.stringify(db, null, 2)}\n`);
    const { rename } = await import("node:fs/promises");
    await rename(temp, target);
  } catch (error) {
    try { await (await import("node:fs/promises")).unlink(temp); } catch {}
    fail(`Unable to save taskboard database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value));
}

function parseFlags(args: string[], permitted: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !permitted.includes(flag) || value === undefined || flags.has(flag)) fail("Invalid command arguments");
    flags.set(flag, value);
  }
  return flags;
}

function taskId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail("Invalid task id");
  return Number(value);
}

function normalizedTags(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  const tags = raw.split(",").map((tag) => tag.trim().toLowerCase());
  if (tags.some((tag) => !tag)) fail("Invalid tag");
  return [...new Set(tags)];
}

function today(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) fail("Missing command");
  if (command === "add") {
    const flags = parseFlags(args, ["--title", "--tags", "--due"]);
    const title = flags.get("--title")?.trim();
    const due = flags.get("--due");
    if (!title) fail("Title is required");
    if (due !== undefined && !validDate(due)) fail("Invalid due date");
    const db = await load();
    const task: Task = { id: db.nextId++, title, tags: normalizedTags(flags.get("--tags")), status: "open", createdAt: new Date().toISOString() };
    if (due !== undefined) task.due = due;
    db.tasks.push(task);
    await save(db);
    print(task);
    return;
  }
  if (command === "list") {
    const flags = parseFlags(args, ["--status", "--tag", "--overdue"]);
    const status = flags.get("--status");
    const tag = flags.get("--tag");
    const overdue = flags.get("--overdue");
    if (status !== undefined && status !== "open" && status !== "done") fail("Invalid status");
    if (tag !== undefined && !tag.trim()) fail("Invalid tag");
    if (overdue !== undefined && !validDate(overdue)) fail("Invalid overdue date");
    const tasks = (await load()).tasks.filter((task) =>
      (status === undefined || task.status === status) &&
      (tag === undefined || task.tags.includes(tag.trim().toLowerCase())) &&
      (overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue)),
    ).sort((a, b) => a.id - b.id);
    print(tasks);
    return;
  }
  if (command === "done" || command === "delete") {
    if (args.length !== 1) fail("Invalid command arguments");
    const db = await load();
    const index = db.tasks.findIndex((task) => task.id === taskId(args[0]));
    if (index < 0) fail("Task not found");
    if (command === "delete") {
      const [task] = db.tasks.splice(index, 1);
      await save(db);
      print(task);
    } else {
      const task = db.tasks[index];
      if (task.status === "open") {
        task.status = "done";
        task.completedAt = new Date().toISOString();
        await save(db);
      }
      print(task);
    }
    return;
  }
  if (command === "stats") {
    if (args.length) fail("Invalid command arguments");
    const tasks = (await load()).tasks;
    const open = tasks.filter((task) => task.status === "open").length;
    const done = tasks.length - open;
    const overdue = tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today()).length;
    print({ total: tasks.length, open, done, overdue });
    return;
  }
  fail("Unknown command");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
