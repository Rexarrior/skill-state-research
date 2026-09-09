type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function fail(message: string): never { throw new Error(message); }
function validate(value: unknown): Task[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).tasks)) fail('Input must contain a tasks array');
  const ids = new Set<string>();
  const tasks = (value as any).tasks.map((raw: any, index: number): Task => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Task ${index} must be an object`);
    const { id, duration } = raw;
    if (typeof id !== 'string' || id.length === 0) fail(`Task ${index}: id must be a non-empty string`);
    if (ids.has(id)) fail(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) fail(`Task ${id}: duration must be a finite non-negative number`);
    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((dep: unknown) => typeof dep !== 'string')) fail(`Task ${id}: dependsOn must be an array of strings`);
    if (new Set(dependsOn).size !== dependsOn.length) fail(`Task ${id}: duplicate dependency`);
    if (dependsOn.includes(id)) fail(`Task ${id}: self dependency cycle: ${id} -> ${id}`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn) if (!ids.has(dep)) fail(`Task ${task.id}: unknown dependency ${dep}`);
  return tasks.sort((a: Task, b: Task) => compare(a.id, b.id));
}
function cycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const color = new Map<string, number>();
  for (const task of tasks) {
    if (color.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    const positions = new Map([[task.id, 0]]);
    color.set(task.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = byId.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        color.set(frame.id, 2); positions.delete(frame.id); stack.pop(); continue;
      }
      const dep = deps[frame.next++];
      if (color.get(dep) === 1) return [...stack.slice(positions.get(dep)!).map(f => f.id), dep];
      if (!color.has(dep)) {
        color.set(dep, 1); positions.set(dep, stack.length); stack.push({ id: dep, next: 0 });
      }
    }
  }
  return [];
}
export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  const ready = tasks.filter(task => !task.dependsOn.length).map(task => task.id);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    let start = 0, level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) fail(`Schedule duration exceeds finite numeric range at task ${id}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (!count) { ready.push(child); ready.sort(compare); }
    }
  }
  if (order.length !== tasks.length) fail(`Dependency cycle: ${cycle(tasks, byId).join(' -> ')}`);
  for (const layer of layers) layer.sort(compare);
  // Best suffixes allow zero-duration prefixes; stopping wins a prefix tie.
  const lengths = new Map<string, number>();
  const next = new Map<string, string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let best = 0, selected: string | undefined;
    for (const child of children.get(id)!) {
      const length = lengths.get(child)!;
      if (length > best || (length === best && selected !== undefined && compare(child, selected) < 0)) {
        best = length; selected = child;
      }
    }
    lengths.set(id, byId.get(id)!.duration + best);
    if (selected !== undefined) next.set(id, selected);
  }
  let head: string | undefined, longest = -1;
  for (const task of tasks) {
    const length = lengths.get(task.id)!;
    if (length > longest) { longest = length; head = task.id; }
  }
  const criticalPath: string[] = [];
  while (head !== undefined) { criticalPath.push(head); head = next.get(head); }
  return { order, layers, earliest, totalDuration, criticalPath };
}
if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'plan' || args[1].startsWith('-')) fail('Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)');
    let input: unknown;
    try { input = JSON.parse(await Bun.file(args[1]).text()); }
    catch (error) { fail(`Cannot read JSON input: ${(error as Error).message}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
