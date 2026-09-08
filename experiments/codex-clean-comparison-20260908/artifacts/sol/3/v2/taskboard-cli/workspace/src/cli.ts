type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
}

interface Database {
  nextId: number;
  tasks: Task[];
}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    return fail("malformed database");
  }

  const ids = new Set<number>();
  let highestId = 0;
  for (const raw of value.tasks) {
    if (!isRecord(raw)) return fail("malformed database");
    const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) return fail("malformed database");
    if (!Number.isSafeInteger(raw.id) || (raw.id as number) < 1 || ids.has(raw.id as number)) return fail("malformed database");
    if (typeof raw.title !== "string" || raw.title.trim() === "") return fail("malformed database");
    if (raw.status !== "open" && raw.status !== "done") return fail("malformed database");
    if (!isIsoTimestamp(raw.createdAt) || !Array.isArray(raw.tags)) return fail("malformed database");
    if (raw.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase())) return fail("malformed database");
    if (new Set(raw.tags).size !== raw.tags.length) return fail("malformed database");
    if (raw.due !== undefined && !isValidDate(raw.due)) return fail("malformed database");
    if (raw.completedAt !== undefined && !isIsoTimestamp(raw.completedAt)) return fail("malformed database");
    if (raw.status === "open" && raw.completedAt !== undefined) return fail("malformed database");
    if (raw.status === "done" && raw.completedAt === undefined) return fail("malformed database");
    ids.add(raw.id as number);
    highestId = Math.max(highestId, raw.id as number);
  }
  if ((value.nextId as number) <= highestId) return fail("malformed database");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  try {
    const text = await Bun.file(databasePath).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("malformed database");
    }
    return validateDatabase(parsed);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (isRecord(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const slash = Math.max(databasePath.lastIndexOf("/"), databasePath.lastIndexOf("\\"));
  const directory = slash < 0 ? "." : databasePath.slice(0, slash) || "/";
  const basename = slash < 0 ? databasePath : databasePath.slice(slash + 1);
  const temporaryPath = `${directory}/.${basename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await Bun.$`mv ${temporaryPath} ${databasePath}`.quiet();
  } catch (error) {
    try {
      await Bun.file(temporaryPath).delete();
    } catch {}
    throw error;
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`unknown flag: ${flag ?? ""}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) return fail("ID must be a positive integer");
  return id;
}

function normalizeTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  const tags = value.split(",").map((tag) => tag.trim().toLowerCase());
  if (tags.some((tag) => tag === "")) return fail("tags must not be empty");
  return [...new Set(tags)];
}

function localDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) return fail("missing command");
  const database = await loadDatabase();

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title");
    if (title === undefined) return fail("missing required flag: --title");
    if (title.trim() === "") return fail("title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isValidDate(due)) return fail("invalid due date");
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(flags.get("--tags")),
      ...(due === undefined ? {} : { due }),
    };
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") return fail("invalid status");
    const tag = flags.get("--tag")?.trim().toLowerCase();
    if (tag === "") return fail("tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isValidDate(overdue)) return fail("invalid overdue date");
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (rest.length !== 1) return fail("usage: done ID");
    const id = parseId(rest[0]);
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) return fail(`task not found: ${id}`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) return fail("usage: delete ID");
    const id = parseId(rest[0]);
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0) return fail(`task not found: ${id}`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) return fail(`unknown flag: ${rest[0]}`);
    const today = localDate();
    const open = database.tasks.filter((task) => task.status === "open");
    return {
      total: database.tasks.length,
      open: open.length,
      done: database.tasks.length - open.length,
      overdue: open.filter((task) => task.due !== undefined && task.due < today).length,
    };
  }

  return fail(`unknown command: ${command}`);
}

try {
  const result = await execute(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
