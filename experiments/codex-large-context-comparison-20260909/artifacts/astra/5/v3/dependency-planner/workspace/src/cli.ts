type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function validate(input: unknown): Task[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as any).tasks)) {
    throw new Error('Input must be an object with a tasks array');
  }
  const ids = new Set<string>();
  const tasks = (input as { tasks: unknown[] }).tasks.map((value, index): Task => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`tasks[${index}] must be an object`);
    }
    const { id, duration, dependsOn = [] } = value as Task;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    }
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== 'string')) {
      throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (dependsOn.includes(id)) throw new Error(`Task ${id}: self dependency (${id} -> ${id})`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
    }
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// Iterative DFS keeps cycle reporting safe even for long dependency chains.
function findCycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const color = new Map<string, number>();
  for (const task of tasks) {
    if (color.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    const positions = new Map([[task.id, 0]]);
    color.set(task.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const deps = byId.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++]!;
      if (color.get(dep) === 1) return [...stack.slice(positions.get(dep)!).map(f => f.id), dep];
      if (!color.has(dep)) {
        positions.set(dep, stack.length);
        color.set(dep, 1);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error('Cycle detection failed');
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  const ready = tasks.filter(task => task.dependsOn.length === 0).map(task => task.id);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep]!.finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Task ${id}: schedule duration exceeds finite numeric range`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
    ready.sort(compare);
  }
  if (order.length !== tasks.length) throw new Error(`Dependency cycle: ${findCycle(tasks, byId).join(' -> ')}`);
  for (const layer of layers) layer.sort(compare);

  // A tight edge preserves longest-path timing. Mark nodes that can reach a
  // maximum finish through tight edges, then choose the smallest viable next id.
  // Stopping before a zero-duration suffix wins because a prefix sorts first.
  const viable = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (earliest[id]!.finish === totalDuration || children.get(id)!.some(child =>
      viable.has(child) && earliest[id]!.finish === earliest[child]!.start)) viable.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => viable.has(task.id) && earliest[task.id]!.start === 0)?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current]!.finish === totalDuration) break;
    const finish = earliest[current]!.finish;
    current = children.get(current)!.find(child => viable.has(child) && earliest[child]!.start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'plan' || args[1]!.startsWith('-')) {
      throw new Error('Usage: bun run src/cli.ts plan INPUT.json (no flags supported)');
    }
    const text = await Bun.file(args[1]!).text();
    let input: unknown;
    try { input = JSON.parse(text); }
    catch (error) { throw new Error(`Invalid JSON: ${(error as Error).message}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
