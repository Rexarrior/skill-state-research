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

const file = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function load(): Database {
  if (!Bun.file(file).size) return { tasks: [], nextId: 1 };
  let data: unknown;
  try {
    data = JSON.parse(require("fs").readFileSync(file, "utf8"));
  } catch {
    fail(`Malformed task database: ${file}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as Database).tasks) || !Number.isInteger((data as Database).nextId)) {
    fail(`Malformed task database: ${file}`);
  }
  return data as Database;
}

function save(db: Database): void {
  const fs = require("fs");
  const path = require("path");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(db, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    fail(`Unable to save task database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOptions(args: string[], allowed: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag?.startsWith("--") || !allowed.includes(flag) || value === undefined || options[flag] !== undefined) fail(`Invalid option: ${flag || ""}`);
    options[flag] = value;
  }
  return options;
}

function taskId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) fail("Task ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail("Task ID must be a positive integer");
  return id;
}

function today(): string {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

const [command, ...args] = process.argv.slice(2);
if (!command) fail("Missing command");
const db = load();

if (command === "add") {
  const options = parseOptions(args, ["--title", "--tags", "--due"]);
  const title = options["--title"]?.trim();
  if (!title) fail("Title cannot be empty");
  if (options["--due"] && !validDate(options["--due"])) fail("Due date must be YYYY-MM-DD");
  const tags = [...new Set((options["--tags"] || "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  const task: Task = { id: db.nextId++, title, tags, status: "open", createdAt: new Date().toISOString(), ...(options["--due"] ? { due: options["--due"] } : {}) };
  db.tasks.push(task);
  save(db);
  console.log(JSON.stringify(task));
} else if (command === "list") {
  const options = parseOptions(args, ["--status", "--tag", "--overdue"]);
  if (options["--status"] && options["--status"] !== "open" && options["--status"] !== "done") fail("Status must be open or done");
  if (options["--overdue"] && !validDate(options["--overdue"])) fail("Overdue date must be YYYY-MM-DD");
  const tag = options["--tag"]?.trim().toLowerCase();
  console.log(JSON.stringify(db.tasks.filter((task) =>
    (!options["--status"] || task.status === options["--status"]) &&
    (!tag || task.tags.includes(tag)) &&
    (!options["--overdue"] || (task.status === "open" && !!task.due && task.due < options["--overdue"])),
  ).sort((a, b) => a.id - b.id)));
} else if (command === "done" || command === "delete") {
  if (args.length !== 1) fail(`Usage: ${command} ID`);
  const index = db.tasks.findIndex((task) => task.id === taskId(args[0]));
  if (index === -1) fail("Task not found");
  if (command === "done") {
    const task = db.tasks[index];
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      save(db);
    }
    console.log(JSON.stringify(task));
  } else {
    const [task] = db.tasks.splice(index, 1);
    save(db);
    console.log(JSON.stringify(task));
  }
} else if (command === "stats") {
  if (args.length) fail("stats does not accept options");
  const open = db.tasks.filter((task) => task.status === "open");
  console.log(JSON.stringify({ total: db.tasks.length, open: open.length, done: db.tasks.length - open.length, overdue: open.filter((task) => task.due && task.due < today()).length }));
} else {
  fail(`Unknown command: ${command}`);
}
