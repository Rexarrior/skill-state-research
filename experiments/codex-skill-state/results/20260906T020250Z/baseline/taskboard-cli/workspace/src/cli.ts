#!/usr/bin/env bun

import { rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

class CliError extends Error {}

const configuredDatabasePath = process.env.TASKBOARD_FILE;
const databasePath = resolve(configuredDatabasePath || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags)) return false;
  if (
    value.tags.some(
      (tag) => typeof tag !== "string" || tag === "" || normalizeTag(tag) !== tag,
    ) ||
    new Set(value.tags).size !== value.tags.length
  ) {
    return false;
  }
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    return fail("malformed task database");
  }
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) {
    return fail("malformed task database");
  }
  if (!value.tasks.every(validateTask)) return fail("malformed task database");

  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    return fail("malformed task database");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { nextId: 1, tasks: [] };
    return fail(`cannot read task database: ${(error as Error).message}`);
  }

  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    return fail("malformed task database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    return fail(`cannot write task database in ${directory}: ${(error as Error).message}`);
  }
}

function readFlag(
  args: string[],
  index: number,
  allowed: ReadonlySet<string>,
): { name: string; value: string; next: number } {
  const argument = args[index];
  const equals = argument.indexOf("=");
  const name = equals === -1 ? argument : argument.slice(0, equals);
  if (!name.startsWith("--") || !allowed.has(name)) fail(`unknown flag: ${name}`);
  if (equals !== -1) {
    return { name, value: argument.slice(equals + 1), next: index + 1 };
  }
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    return fail(`missing value for ${name}`);
  }
  return { name, value: args[index + 1], next: index + 2 };
}

function parseFlags(args: string[], allowedNames: string[]): Map<string, string> {
  const allowed = new Set(allowedNames);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; ) {
    const parsed = readFlag(args, index, allowed);
    if (flags.has(parsed.name)) fail(`duplicate flag: ${parsed.name}`);
    flags.set(parsed.name, parsed.value);
    index = parsed.next;
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function parseTags(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  const tags = value.split(",").map(normalizeTag);
  if (tags.some((tag) => tag === "")) fail("tags must not be empty");
  return [...new Set(tags)];
}

function requireDate(value: string, flag: string): string {
  if (!isDate(value)) fail(`${flag} must be a valid YYYY-MM-DD date`);
  return value;
}

async function add(args: string[]): Promise<Task> {
  const flags = parseFlags(args, ["--title", "--tags", "--due"]);
  const title = flags.get("--title");
  if (title === undefined) fail("missing required flag: --title");
  if (title.trim() === "") fail("title must not be empty");

  const dueValue = flags.get("--due");
  const database = await loadDatabase();
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    createdAt: new Date().toISOString(),
    tags: parseTags(flags.get("--tags")),
    ...(dueValue === undefined ? {} : { due: requireDate(dueValue, "--due") }),
  };
  database.nextId += 1;
  database.tasks.push(task);
  await saveDatabase(database);
  return task;
}

async function list(args: string[]): Promise<Task[]> {
  const flags = parseFlags(args, ["--status", "--tag", "--overdue"]);
  const status = flags.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") {
    fail("--status must be open or done");
  }
  const rawTag = flags.get("--tag");
  const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
  if (tag === "") fail("--tag must not be empty");
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

async function deleteTask(args: string[]): Promise<{ deleted: number }> {
  if (args.length !== 1) fail("usage: delete ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const index = database.tasks.findIndex((task) => task.id === id);
  if (index === -1) fail(`task ${id} not found`);
  database.tasks.splice(index, 1);
  await saveDatabase(database);
  return { deleted: id };
}

function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function stats(args: string[]): Promise<{
  total: number;
  open: number;
  done: number;
  overdue: number;
}> {
  if (args.length !== 0) fail(`unknown flag or argument: ${args[0]}`);
  const database = await loadDatabase();
  const today = localDate();
  const open = database.tasks.filter((task) => task.status === "open").length;
  return {
    total: database.tasks.length,
    open,
    done: database.tasks.length - open,
    overdue: database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length,
  };
}

async function run(args: string[]): Promise<unknown> {
  if (configuredDatabasePath === "") fail("TASKBOARD_FILE must not be empty");
  const [command, ...rest] = args;
  switch (command) {
    case "add":
      return add(rest);
    case "list":
      return list(rest);
    case "done":
      return done(rest);
    case "delete":
      return deleteTask(rest);
    case "stats":
      return stats(rest);
    default:
      return fail(command === undefined ? "missing command" : `unknown command: ${command}`);
  }
}

try {
  console.log(JSON.stringify(await run(Bun.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
