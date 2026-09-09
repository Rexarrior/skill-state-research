#!/usr/bin/env bun

import { rename } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

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

const databasePath = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt)))) return false;
  if (value.status === "done" && typeof value.completedAt !== "string") return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  return ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    fail(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text!);
  } catch {
    fail("database contains malformed JSON");
  }
  if (!validateDatabase(value)) fail("database has an invalid structure");
  return value;
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await Bun.file(temporaryPath).delete();
    } catch {}
    fail(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag ?? ""}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function requireId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function normalizeTags(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const tags = raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("--due must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      tags: normalizeTags(flags.get("--tags")),
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("--status must be open or done");
    }
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("--overdue must be a valid YYYY-MM-DD date");
    const requestedTag = flags.get("--tag")?.trim().toLowerCase();
    if (flags.has("--tag") && !requestedTag) fail("--tag must not be empty");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => requestedTag === undefined || task.tags.includes(requestedTag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("usage: done ID");
    const id = requireId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} does not exist`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const id = requireId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index < 0) fail(`task ${id} does not exist`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`unknown flag or argument: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
