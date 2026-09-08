import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type TaskStatus = "open" | "done";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  tags: string[];
  due?: string;
  createdAt: string;
  completedAt?: string;
}

interface Database {
  nextId: number;
  tasks: Task[];
}

export class UsageError extends Error {}
export class DataError extends Error {}

export function normalizeTag(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validTask(value: unknown): value is Task {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (Object.keys(task).some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(task.id) || (task.id as number) < 1) return false;
  if (typeof task.title !== "string" || task.title.trim() === "") return false;
  if (task.status !== "open" && task.status !== "done") return false;
  if (!Array.isArray(task.tags) || !task.tags.every((tag) => typeof tag === "string")) return false;
  const tags = task.tags as string[];
  if (tags.some((tag) => tag === "" || normalizeTag(tag) !== tag) || new Set(tags).size !== tags.length) return false;
  if (task.due !== undefined && (typeof task.due !== "string" || !isDate(task.due))) return false;
  if (!isIsoTimestamp(task.createdAt)) return false;
  if (task.status === "done" && !isIsoTimestamp(task.completedAt)) return false;
  if (task.status === "open" && task.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DataError("Malformed task database");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "nextId" && key !== "tasks") ||
    !Number.isSafeInteger(record.nextId) ||
    (record.nextId as number) < 1 ||
    !Array.isArray(record.tasks) ||
    !record.tasks.every(validTask)
  ) {
    throw new DataError("Malformed task database");
  }

  const tasks = record.tasks as Task[];
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (record.nextId as number))) {
    throw new DataError("Malformed task database");
  }
  return { nextId: record.nextId as number, tasks };
}

export class TaskStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Database> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
      throw error;
    }

    try {
      return validateDatabase(JSON.parse(text));
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw new DataError("Malformed task database");
    }
  }

  async save(database: Database): Promise<void> {
    const directory = dirname(this.path);
    const temporary = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async add(title: string, tags: string[], due?: string): Promise<Task> {
    const database = await this.load();
    if (!Number.isSafeInteger(database.nextId + 1)) throw new DataError("No task IDs remain");
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags,
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await this.save(database);
    return task;
  }

  async list(filters: { status?: TaskStatus; tag?: string; overdue?: string }): Promise<Task[]> {
    const database = await this.load();
    return database.tasks
      .filter((task) => filters.status === undefined || task.status === filters.status)
      .filter((task) => filters.tag === undefined || task.tags.includes(filters.tag))
      .filter(
        (task) =>
          filters.overdue === undefined ||
          (task.status === "open" && task.due !== undefined && task.due < filters.overdue),
      )
      .sort((left, right) => left.id - right.id);
  }

  async done(id: number): Promise<Task> {
    const database = await this.load();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new UsageError(`Task ${id} does not exist`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await this.save(database);
    }
    return task;
  }

  async delete(id: number): Promise<Task> {
    const database = await this.load();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) throw new UsageError(`Task ${id} does not exist`);
    const [task] = database.tasks.splice(index, 1);
    await this.save(database);
    return task!;
  }

  async stats(today: string): Promise<{ total: number; open: number; done: number; overdue: number }> {
    const tasks = (await this.load()).tasks;
    return {
      total: tasks.length,
      open: tasks.filter((task) => task.status === "open").length,
      done: tasks.filter((task) => task.status === "done").length,
      overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }
}

export function localDate(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
