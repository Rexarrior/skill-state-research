#!/usr/bin/env bun

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  tags: string[];
  due?: string;
  createdAt: string;
  completedAt?: string;
}

interface Database {
  version: 1;
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

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
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requireDate(value: string, label: string): string {
  if (!validDate(value)) fail(`${label} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateTask(value: unknown): value is Task {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase())) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !validDate(value.due))) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.status === "done") return isIsoTimestamp(value.completedAt);
  return value.completedAt === undefined;
}

function validateDatabase(value: unknown): Database {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !["version", "nextId", "tasks"].includes(key))) {
    fail("database has an invalid structure");
  }
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("database has an invalid structure");
  }
  if (!value.tasks.every(validateTask)) fail("database contains an invalid task");
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail("database contains invalid task ids");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    fail(`cannot read database: ${(error as Error).message}`);
  }
  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("database is not valid JSON");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = resolve(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    fail(`cannot write database: ${(error as Error).message}`);
  }
}

function parseOptions(args: string[], permitted: Set<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag ?? ""}`);
    if (!permitted.has(flag)) fail(`unknown flag: ${flag}`);
    if (options.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function normalizeTag(value: string): string {
  const tag = value.trim().toLowerCase();
  if (!tag) fail("tag must not be empty");
  return tag;
}

function normalizeTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  const tags = value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;

  if (command === "add") {
    const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const dueValue = options.get("--due");
    const due = dueValue === undefined ? undefined : requireDate(dueValue, "--due");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags: normalizeTags(options.get("--tags")),
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tagValue = options.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    const overdueValue = options.get("--overdue");
    const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "--overdue");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("usage: done ID");
    const id = parseId(rest[0]);
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

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0) fail(`task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("stats does not accept arguments");
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(command === undefined ? "a command is required" : `unknown command: ${command}`);
}

try {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
