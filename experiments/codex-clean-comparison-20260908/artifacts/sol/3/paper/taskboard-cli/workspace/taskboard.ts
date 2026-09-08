#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { mkdir, rename } from "node:fs/promises";

export const STATUSES = ["todo", "in-progress", "done"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  id: number;
  title: string;
  description: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
}

interface Board {
  version: 1;
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const HELP = `Taskboard — a small persistent task CLI

Usage:
  taskboard add <title> [-d, --description <text>] [-s, --status <status>] [--json]
  taskboard list [--status <status>] [--json]
  taskboard show <id> [--json]
  taskboard edit <id> [--title <title>] [-d, --description <text>] [--json]
  taskboard move <id> <status> [--json]
  taskboard remove <id> [--json]
  taskboard clear [--yes] [--json]
  taskboard stats [--json]

Statuses: todo, in-progress, done

Data is stored in .taskboard.json in the current directory. Set TASKBOARD_FILE
to use another path.`;

function emptyBoard(): Board {
  return { version: 1, nextId: 1, tasks: [] };
}

function dataPath(): string {
  return resolve(process.env.TASKBOARD_FILE || ".taskboard.json");
}

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && STATUSES.includes(value as Status);
}

function validateBoard(value: unknown): Board {
  if (!value || typeof value !== "object") throw new CliError("data file is not a JSON object");
  const board = value as Partial<Board>;
  if (board.version !== 1 || !Number.isInteger(board.nextId) || (board.nextId ?? 0) < 1 || !Array.isArray(board.tasks)) {
    throw new CliError("data file has an unsupported or invalid format");
  }
  for (const task of board.tasks) {
    if (!task || typeof task !== "object") throw new CliError("data file contains an invalid task");
    const item = task as Partial<Task>;
    if (!Number.isInteger(item.id) || (item.id ?? 0) < 1 || typeof item.title !== "string" || !item.title.trim() ||
        typeof item.description !== "string" || !isStatus(item.status) ||
        typeof item.createdAtAt === "string" || typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") {
      throw new CliError("data file contains an invalid task");
    }
  }
  return board as Board;
}

async function loadBoard(): Promise<Board> {
  const file = Bun.file(dataPath());
  if (!(await file.exists())) return emptyBoard();
  try {
    return validateBoard(await file.json());
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`cannot read ${dataPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveBoard(board: Board): Promise<void> {
  const file = dataPath();
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await Bun.write(temporary, `${JSON.stringify(board, null, 2)}\n`);
  await rename(temporary, file);
}

function takeFlag(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) throw new CliError(`${option} requires a value`);
  return value;
}

function parseOptions(args: string[], allowed: Set<string>): { positional: string[]; options: Map<string, string | true> } {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  const aliases: Record<string, string> = { "-d": "--description", "-s": "--status", "-h": "--help" };
  for (let index = 0; index < args.length; index++) {
    let arg = aliases[args[index]] ?? args[index];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (!allowed.has(arg)) throw new CliError(`unknown option: ${args[index]}`);
    if (["--json", "--yes", "--help"].includes(arg)) options.set(arg, true);
    else {
      options.set(arg, takeValue(args, index, arg));
      index++;
    }
  }
  return { positional, options };
}

function takeValue(args: string[], index: number, option: string): string {
  return take(args, index, option);
}

function requiredId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1) throw new CliError("task id must be a positive integer");
  return Number(value);
}

function requiredStatus(value: unknown): Status {
  if (!isStatus(value)) throw new CliError(`status must be one of: ${STATUSES.join(", ")}`);
  return value;
}

function requiredTitle(parts: string[]): string {
  const title = parts.join(" ").trim();
  if (!title) throw new CliError("title must not be empty");
  return title;
}

function findTask(board: Board, id: number): Task {
  const task = board.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new CliError(`task ${id} not found`);
  return task;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printTask(task: Task): void {
  console.log(`#${task.id} [${task.status}] ${task.title}`);
  if (task.description) console.log(`  ${task.description}`);
}

async function run(argv: string[]): Promise<void> {
  const [command = "help", ...args] = argv;
  if (["help", "--help", "-h"].includes(command)) {
    if (args.length) throw new CliError("help does not accept arguments");
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "version") {
    if (args.length) throw new CliError("version does not accept arguments");
    console.log("taskboard 1.0.0");
    return;
  }

  const board = await loadBoard();
  if (command === "add") {
    const parsed = parseOptions(args, new Set(["--description", "--status", "--json"]));
    const now = new Date().toISOString();
    const task: Task = {
      id: board.nextId++,
      title: requiredTitle(parsed.positional),
      description: String(parsed.options.get("--description") ?? ""),
      status: parsed.options.has("--status") ? requiredStatus(parsed.options.get("--status")) : "todo",
      createdAt: now,
      updatedAt: now,
    };
    board.tasks.push(task);
    await saveBoard(board);
    parsed.options.has("--json") ? printJson(task) : console.log(`Added task #${task.id}: ${task.title}`);
    return;
  }

  if (command === "list") {
    const parsed = parseOptions(args, new Set(["--status", "--json"]));
    if (parsed.positional.length) throw new CliError("list does not accept positional arguments");
    const status = parsed.options.has("--status") ? requiredStatus(parsed.options.get("--status")) : undefined;
    const tasks = status ? board.tasks.filter((task) => task.status === status) : board.tasks;
    if (parsed.options.has("--json")) printJson(tasks);
    else if (!tasks.length) console.log("No tasks.");
    else tasks.forEach(printTask);
    return;
  }

  if (command === "show") {
    const parsed = parseOptions(args, new Set(["--json"]));
    if (parsed.positional.length !== 1) throw new CliError("usage: taskboard show <id> [--json]");
    const task = findTask(board, requiredId(parsed.positional[0]));
    parsed.options.has("--json") ? printJson(task) : printTask(task);
    return;
  }

  if (command === "edit") {
    const parsed = parseOptions(args, new Set(["--title", "--description", "--json"]));
    if (parsed.positional.length !== 1) throw new CliError("usage: taskboard edit <id> [--title <title>] [--description <text>]");
    if (!parsed.options.has("--title") && !parsed.options.has("--description")) throw new CliError("edit requires --title or --description");
    const task = findTask(board, requiredId(parsed.positional[0]));
    if (parsed.options.has("--title")) task.title = requiredTitle([String(parsed.options.get("--title"))]);
    if (parsed.options.has("--description")) task.description = String(parsed.options.get("--description"));
    task.updatedAt = new Date().toISOString();
    await saveBoard(board);
    parsed.options.has("--json") ? printJson(task) : console.log(`Updated task #${task.id}.`);
    return;
  }

  if (command === "move") {
    const parsed = parseOptions(args, new Set(["--json"]));
    if (parsed.positional.length !== 2) throw new CliError("usage: taskboard move <id> <status> [--json]");
    const task = findTask(board, requiredId(parsed.positional[0]));
    task.status = requiredStatus(parsed.positional[1]);
    task.updatedAt = new Date().toISOString();
    await saveBoard(board);
    parsed.options.has("--json") ? printJson(task) : console.log(`Moved task #${task.id} to ${task.status}.`);
    return;
  }

  if (command === "remove" || command === "delete") {
    const parsed = parseOptions(args, new Set(["--json"]));
    if (parsed.positional.length !== 1) throw new CliError("usage: taskboard remove <id> [--json]");
    const task = findTask(board, requiredId(parsed.positional[0]));
    board.tasks = board.tasks.filter((candidate) => candidate.id !== task.id);
    await saveBoard(board);
    parsed.options.has("--json") ? printJson(task) : console.log(`Removed task #${task.id}.`);
    return;
  }

  if (command === "clear") {
    const parsed = parseOptions(args, new Set(["--yes", "--json"]));
    if (parsed.positional.length) throw new CliError("clear does not accept positional arguments");
    if (!parsed.options.has("--yes")) throw new CliError("clear requires --yes");
    const removed = board.tasks.length;
    board.tasks = [];
    await saveBoard(board);
    parsed.options.has("--json") ? printJson({ removed }) : console.log(`Removed ${removed} task${removed === 1 ? "" : "s"}.`);
    return;
  }

  if (command === "stats") {
    const parsed = parseOptions(args, new Set(["--json"]));
    if (parsed.positional.length) throw new CliError("stats does not accept positional arguments");
    const stats = {
      total: board.tasks.length,
      todo: board.tasks.filter((task) => task.status === "todo").length,
      "in-progress": board.tasks.filter((task) => task.status === "in-progress").length,
      done: board.tasks.filter((task) => task.status === "done").length,
    };
    if (parsed.options.has("--json")) printJson(stats);
    else console.log(`Total: ${stats.total}\nTodo: ${stats.todo}\nIn progress: ${stats["in-progress"]}\nDone: ${stats.done}`);
    return;
  }

  throw new CliError(`unknown command: ${command}`);
}

try {
  await run(Bun.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
