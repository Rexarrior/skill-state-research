import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Task = { id: number; title: string; status: 'open' | 'done'; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const file = resolve(process.env.TASKBOARD_FILE ?? '.taskboard.json');
const fail = (message: string): never => { throw new Error(message); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const tag = (v: string) => v.trim().toLowerCase();
function date(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00.000Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function iso(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.toISOString() === v;
}
function validate(v: unknown): asserts v is Database {
  if (!object(v) || v.version !== 1 || !positiveInt(v.nextId) || !Array.isArray(v.tasks)) fail('Malformed database');
  const ids = new Set<number>();
  for (const t of v.tasks) {
    if (!object(t) || !positiveInt(t.id) || ids.has(t.id) || t.id >= v.nextId ||
      typeof t.title !== 'string' || !t.title.trim() || !iso(t.createdAt) ||
      !['open', 'done'].includes(t.status as string) || !Array.isArray(t.tags) ||
      t.tags.some(x => typeof x !== 'string' || !x || tag(x) !== x) || new Set(t.tags).size !== t.tags.length ||
      ('due' in t && !date(t.due)) || (t.status === 'done' ? !iso(t.completedAt) : 'completedAt' in t)) fail('Malformed database');
    ids.add(t.id);
  }
}
async function load(): Promise<Database> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, nextId: 1, tasks: [] }; throw e; }
  let db: unknown;
  try { db = JSON.parse(text); } catch { fail('Malformed database: invalid JSON'); }
  validate(db);
  return db;
}
async function save(db: Database) {
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(db, null, 2) + '\n', { flag: 'wx' });
    await rename(temp, file);
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
function options(args: string[], allowed: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key)) fail(`Unknown flag or argument: ${key}`);
    if (key in result) fail(`Duplicate flag: ${key}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`Missing value for ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}
function today() {
  const d = new Date();
  return `${d.getFullYear().toString().padStart(4, '0')}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}
const overdue = (t: Task, day: string) => t.status === 'open' && t.due !== undefined && t.due < day;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['add', 'list', 'done', 'delete', 'stats'].includes(command)) fail(`Unknown command: ${command ?? '(missing)'}`);
  const db = await load();
  if (command === 'add') {
    const o = options(args, ['--title', '--tags', '--due']);
    const title = o['--title']?.trim();
    if (!title) fail('A non-empty --title is required');
    if ('--due' in o && !date(o['--due'])) fail('Invalid due date: expected YYYY-MM-DD');
    if (db.nextId >= Number.MAX_SAFE_INTEGER) fail('Task ID limit reached');
    const task: Task = { id: db.nextId++, title, status: 'open', createdAt: new Date().toISOString(), tags: [...new Set((o['--tags'] ?? '').split(',').map(tag).filter(Boolean))] };
    if ('--due' in o) task.due = o['--due'];
    db.tasks.push(task);
    await save(db);
    return task;
  }
  if (command === 'list') {
    const o = options(args, ['--status', '--tag', '--overdue']);
    if ('--status' in o && !['open', 'done'].includes(o['--status'])) fail('Invalid status: expected open or done');
    if ('--overdue' in o && !date(o['--overdue'])) fail('Invalid overdue date: expected YYYY-MM-DD');
    if ('--tag' in o && !tag(o['--tag'])) fail('Tag must not be empty');
    return db.tasks.filter(t => (!('--status' in o) || t.status === o['--status']) &&
      (!('--tag' in o) || t.tags.includes(tag(o['--tag']))) &&
      (!('--overdue' in o) || overdue(t, o['--overdue']))).sort((a, b) => a.id - b.id);
  }
  if (command === 'stats') {
    options(args, []);
    const day = today();
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === 'open').length, done: db.tasks.filter(t => t.status === 'done').length, overdue: db.tasks.filter(t => overdue(t, day)).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !positiveInt(Number(args[0]))) fail('Expected one positive integer task ID');
  const index = db.tasks.findIndex(t => t.id === Number(args[0]));
  if (index === -1) fail(`Task ${args[0]} not found`);
  const task = db.tasks[index];
  if (command === 'delete') db.tasks.splice(index, 1);
  else if (task.status === 'done') return task;
  else { task.status = 'done'; task.completedAt = new Date().toISOString(); }
  await save(db);
  return task;
}
try { console.log(JSON.stringify(await main())); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log('null');
  process.exitCode = 1;
}
