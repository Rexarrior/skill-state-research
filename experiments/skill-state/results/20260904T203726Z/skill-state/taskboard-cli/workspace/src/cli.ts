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

type Database = { tasks: Task[]; nextId: number };

const databasePath = process.env.TASKBOARD_FILE || `${process.cwd()}/.taskboard.json`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function today(): string {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function readDatabase(): Database {
  if (!require("fs").existsSync(databasePath)) return { tasks: [], nextId: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(require("fs").readFileSync(databasePath, "utf8"));
  } catch {
    fail("Malformed taskboard database");
  }
  if (
    !parsed || typeof parsed !== "object" || !Array.isArray((parsed as Database).tasks) ||
    !Number.isInteger((parsed as Database).nextId) || (parsed as Database).nextId < 1
  ) fail("Malformed taskboard database");
  const db = parsed as Database;
  for (const task of db.tasks) {
    if (!task || !Number.isInteger(task.id) || typeof task.title !== "string" ||
      !Array.isArray(task.tags) || (task.status !== "open" && task.status !== "done") ||
      typeof task.createdAt !== "string" || (task.due !== undefined && !validDate(task.due))) {
      fail("Malformed taskboard database");
    }
  }
  return db;
}

function writeDatabase(db: Database): void {
  const temporary = `${databasePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    require("fs").writeFileSync(temporary, `${JSON.stringify(db, null, 2)}\n`);
    require("fs").renameSync(temporary, databasePath);
  } catch (error) {
    try { require("fs").unlinkSync(temporary); } catch { /* nothing to clean up */ }
    fail(`Unable to write taskboard database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOptions(args: string[], allowed: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !allowed.includes(flag) || value === undefined || options.has(flag)) {
      fail("Invalid command options");
    }
    options.set(flag, value);
  }
  return options;
}

function taskId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1) fail("Invalid task id");
  return Number(value);
}

function main(): void {
const [command, ...args] = process.argv.slice(2);
let output: unknown;

switch (command) {
  case "add": {
    const options = parseOptions(args, ["--title", "--tags", "--due"]);
    const title = options.get("--title")?.trim();
    if (!title) fail("A non-empty title is required");
    const due = options.get("--due");
    if (due && !validDate(due)) fail("Invalid due date");
    const tags = [...new Set((options.get("--tags") || "").split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean))];
    const db = readDatabase();
    const task: Task = { id: db.nextId++, title, tags, status: "open", createdAt: new Date().toISOString(), ...(due ? { due } : {}) };
    db.tasks.push(task);
    writeDatabase(db);
    output = task;
    break;
  }
  case "list": {
    const options = parseOptions(args, ["--status", "--tag", "--overdue"]);
    const status = options.get("--status");
    const tag = options.get("--tag")?.trim().toLowerCase();
    const overdue = options.get("--overdue");
    if (status && status !== "open" && status !== "done") fail("Invalid status");
    if (overdue && !validDate(overdue)) fail("Invalid overdue date");
    output = readDatabase().tasks.filter(task =>
      (!status || task.status === status) && (!tag || task.tags.includes(tag)) &&
      (!overdue || (task.status === "open" && !!task.due && task.due < overdue)),
    ).sort((a, b) => a.id - b.id);
    break;
  }
  case "done": {
    if (args.length !== 1) fail("Usage: done ID");
    const db = readDatabase();
    const task = db.tasks.find(item => item.id === taskId(args[0]));
    if (!task) fail("Task not found");
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      writeDatabase(db);
    }
    output = task;
    break;
  }
  case "delete": {
    if (args.length !== 1) fail("Usage: delete ID");
    const db = readDatabase();
    const id = taskId(args[0]);
    const index = db.tasks.findIndex(task => task.id === id);
    if (index < 0) fail("Task not found");
    const [deleted] = db.tasks.splice(index, 1);
    writeDatabase(db);
    output = deleted;
    break;
  }
  case "stats": {
    if (args.length) fail("Usage: stats");
    const tasks = readDatabase().tasks;
    output = { total: tasks.length, open: tasks.filter(task => task.status === "open").length, done: tasks.filter(task => task.status === "done").length, overdue: tasks.filter(task => task.status === "open" && task.due && task.due < today()).length };
    break;
  }
  default:
    fail("Unknown command");
}

console.log(JSON.stringify(output));
}

main();
