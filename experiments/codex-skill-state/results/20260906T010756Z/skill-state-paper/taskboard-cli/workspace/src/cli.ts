import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
  version: 1;
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validateTask(value: unknown, index: number): Task {
  if (!isPlainObject(value)) fail(`malformed database: task ${index} is invalid`);
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) {
    fail(`malformed database: task ${index} has an invalid id`);
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    fail(`malformed database: task ${index} has an invalid title`);
  }
  if (value.status !== "open" && value.status !== "done") {
    fail(`malformed database: task ${index} has an invalid status`);
  }
  if (!isIsoTimestamp(value.createdAt)) {
    fail(`malformed database: task ${index} has an invalid createdAt`);
  }
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) {
    fail(`malformed database: task ${index} has invalid tags`);
  }
  const normalized = normalizeTags(value.tags.join(","));
  if (normalized.length !== value.tags.length || normalized.some((tag, i) => tag !== value.tags[i])) {
    fail(`malformed database: task ${index} has non-normalized tags`);
  }
  if (value.due !== undefined && (typeof value.due !== "string" || !validDate(value.due))) {
    fail(`malformed database: task ${index} has an invalid due date`);
  }
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) {
    fail(`malformed database: task ${index} has an invalid completedAt`);
  }
  if (value.status === "done" && value.completedAt === undefined) {
    fail(`malformed database: task ${index} is done without completedAt`);
  }
  return value as unknown as Task;
}

function loadDatabase(): Database {
  let raw: string;
  try {
    raw = readFileSync(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    fail(`cannot read database: ${(error as Error).message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("malformed database: invalid JSON");
  }
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.tasks)) {
    fail("malformed database: invalid document structure");
  }
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) {
    fail("malformed database: invalid nextId");
  }
  const tasks = value.tasks.map(validateTask);
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) fail("malformed database: duplicate task id");
  const maximumId = tasks.reduce((maximum, task) => Math.max(maximum, task.id), 0);
  if ((value.nextId as number) <= maximumId) {
    fail("malformed database: nextId does not exceed existing ids");
  }
  return { version: 1, nextId: value.nextId as number, tasks };
}

function saveDatabase(database: Database): void {
  const directory = dirname(databasePath);
  const temporary = join(
    directory,
    `.${databasePath.split(/[\\/]/).pop()}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(database, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, databasePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    fail(`cannot write database: ${(error as Error).message}`);
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(input: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of input.split(",")) {
    const tag = normalizeTag(part);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag ?? ""}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (result.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    result.set(flag, value);
  }
  return result;
}

function parseId(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function requireTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`task ${id} not found`);
  return task;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function execute(args: string[]): unknown {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title");
    if (title === undefined) fail("missing required flag: --title");
    if (title.trim() === "") fail("title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !validDate(due)) fail("due date must be a valid YYYY-MM-DD date");
    const database = loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(flags.get("--tags") ?? ""),
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("status must be open or done");
    }
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !validDate(overdue)) {
      fail("overdue date must be a valid YYYY-MM-DD date");
    }
    const requestedTag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (requestedTag === "") fail("tag must not be empty");
    return loadDatabase().tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => requestedTag === undefined || task.tags.includes(requestedTag))
      .filter(
        (task) =>
          overdue === undefined ||
          (task.status === "open" && task.due !== undefined && task.due < overdue),
      )
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("usage: done ID");
    const id = parseId(rest[0]);
    const database = loadDatabase();
    const task = requireTask(database, id);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const id = parseId(rest[0]);
    const database = loadDatabase();
    const task = requireTask(database, id);
    database.tasks = database.tasks.filter((candidate) => candidate.id !== id);
    saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("stats does not accept arguments");
    const tasks = loadDatabase().tasks;
    const today = localToday();
    const open = tasks.filter((task) => task.status === "open").length;
    return {
      total: tasks.length,
      open,
      done: tasks.length - open,
      overdue: tasks.filter(
        (task) => task.status === "open" && task.due !== undefined && task.due < today,
      ).length,
    };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = execute(process.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
