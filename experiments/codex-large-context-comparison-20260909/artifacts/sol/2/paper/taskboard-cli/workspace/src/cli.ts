#!/usr/bin/env bun

import { rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

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

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function parseDate(value: string, label = "date"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail(`${label} is not a valid calendar date`);
  }
  return value;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) =>
    typeof tag === "string" && tag !== "" && tag === normalizeTag(tag)
  )) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined) {
    if (typeof value.due !== "string") return false;
    try {
      parseDate(value.due, "stored due date");
    } catch {
      return false;
    }
  }
  if (value.status === "done") return isIsoTimestamp(value.completedAt);
  return value.completedAt === undefined;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || value.version !== 1 ||
      !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 ||
      !Array.isArray(value.tasks) || !value.tasks.every(validateTask)) {
    fail("database is malformed");
  }
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail("database is malformed");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { version: 1, nextId: 1, tasks: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    fail("database is malformed");
  }
  return validateDatabase(parsed);
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporary = join(
    directory,
    `.${basename(databasePath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporary, databasePath);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
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

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const rawTitle = flags.get("--title");
    if (rawTitle === undefined) fail("missing required flag: --title");
    const title = rawTitle.trim();
    if (!title) fail("title must not be empty");
    const due = flags.has("--due") ? parseDate(flags.get("--due")!, "due date") : undefined;
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: flags.has("--tags") ? normalizeTags(flags.get("--tags")!) : [],
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    print(task);
    return;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("status must be open or done");
    }
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") fail("tag must not be empty");
    const overdue = flags.has("--overdue")
      ? parseDate(flags.get("--overdue")!, "overdue date")
      : undefined;
    const database = await loadDatabase();
    const tasks = database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined ||
        (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
    print(tasks);
    return;
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
    print(task);
    return;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    print(task);
    return;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`unknown flag: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    print({
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter((task) =>
        task.status === "open" && task.due !== undefined && task.due < today
      ).length,
    });
    return;
  }

  fail(`unknown command: ${command}`);
}

try {
  await run(Bun.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
