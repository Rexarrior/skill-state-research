#!/usr/bin/env bun

import { open, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

const databasePath = process.env.TASKBOARD_FILE ?? ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "id",
    "title",
    "status",
    "createdAt",
    "tags",
    "due",
    "completedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoInstant(value.createdAt)) return false;
  if (!Array.isArray(value.tags)) return false;
  if (!value.tags.every((tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag))) {
    return false;
  }
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.status === "done" && !isIsoInstant(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value)) fail("malformed database: expected an object");
  const allowed = new Set(["version", "nextId", "tasks"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("malformed database: unexpected field");
  }
  if (value.version !== 1) fail("malformed database: unsupported version");
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) {
    fail("malformed database: invalid nextId");
  }
  if (!Array.isArray(value.tasks) || !value.tasks.every(isTask)) {
    fail("malformed database: invalid tasks");
  }

  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) fail("malformed database: duplicate task id");
  if (ids.some((id) => id >= (value.nextId as number))) {
    fail("malformed database: nextId must exceed all task ids");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("malformed database: invalid JSON");
  }
  return validateDatabase(parsed);
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, databasePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseFlags(
  args: string[],
  accepted: ReadonlySet<string>,
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag ?? ""}`);
    if (!accepted.has(flag)) fail(`unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function requireDate(value: string, flag: string): string {
  if (!isDate(value)) fail(`${flag} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function parseTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function localToday(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function add(args: string[]): Promise<Task> {
  const flags = parseFlags(args, new Set(["--title", "--tags", "--due"]));
  const rawTitle = flags.get("--title");
  if (rawTitle === undefined) fail("missing required flag: --title");
  const title = rawTitle.trim();
  if (title === "") fail("title must not be empty");

  const dueValue = flags.get("--due");
  const database = await loadDatabase();
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    createdAt: new Date().toISOString(),
    tags: parseTags(flags.get("--tags")),
  };
  if (dueValue !== undefined) task.due = requireDate(dueValue, "--due");
  database.tasks.push(task);
  database.nextId += 1;
  await saveDatabase(database);
  return task;
}

async function list(args: string[]): Promise<Task[]> {
  const flags = parseFlags(args, new Set(["--status", "--tag", "--overdue"]));
  const status = flags.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") {
    fail("--status must be open or done");
  }
  const rawTag = flags.get("--tag");
  const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
  if (rawTag !== undefined && tag === "") fail("--tag must not be empty");
  const rawOverdue = flags.get("--overdue");
  const overdue = rawOverdue === undefined ? undefined : requireDate(rawOverdue, "--overdue");

  const database = await loadDatabase();
  return database.tasks
    .filter((task) => status === undefined || task.status === status)
    .filter((task) => tag === undefined || task.tags.includes(tag))
    .filter(
      (task) =>
        overdue === undefined ||
        (task.status === "open" && task.due !== undefined && task.due < overdue),
    )
    .sort((left, right) => left.id - right.id);
}

async function done(args: string[]): Promise<Task> {
  if (args.length !== 1) fail("usage: done ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`task ${id} not found`);
  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await saveDatabase(database);
  }
  return task;
}

async function remove(args: string[]): Promise<{ deleted: number }> {
  if (args.length !== 1) fail("usage: delete ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const index = database.tasks.findIndex((task) => task.id === id);
  if (index === -1) fail(`task ${id} not found`);
  database.tasks.splice(index, 1);
  await saveDatabase(database);
  return { deleted: id };
}

async function stats(args: string[]): Promise<{ total: number; open: number; done: number; overdue: number }> {
  if (args.length !== 0) fail(`unexpected argument: ${args[0]}`);
  const database = await loadDatabase();
  const today = localToday();
  return {
    total: database.tasks.length,
    open: database.tasks.filter((task) => task.status === "open").length,
    done: database.tasks.filter((task) => task.status === "done").length,
    overdue: database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length,
  };
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  switch (command) {
    case "add":
      return add(rest);
    case "list":
      return list(rest);
    case "done":
      return done(rest);
    case "delete":
      return remove(rest);
    case "stats":
      return stats(rest);
    default:
      fail(command === undefined ? "missing command" : `unknown command: ${command}`);
  }
}

try {
  const result = await run(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
