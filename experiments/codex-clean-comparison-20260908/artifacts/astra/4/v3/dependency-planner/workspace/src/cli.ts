type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function validate(input: unknown): Task[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as any).tasks)) {
    throw new Error('Input must be an object with a tasks array');
  }
  const ids = new Set<string>();
  const tasks = (input as { tasks: unknown[] }).tasks.map((value, i) => {
    const label = `tasks[${i}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    const task = value as Record<string, unknown>;
    if (typeof task.id !== 'string' || task.id.length === 0) throw new Error(`${label}.id must be a non-empty string`);
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.duration !== 'number' || !Number.isFinite(task.duration) || task.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const deps = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(deps) || deps.some(dep => typeof dep !== 'string')) throw new Error(`${label}.dependsOn must be an array of strings`);
    if (new Set(deps).size !== deps.length) throw new Error(`${label}.dependsOn contains duplicates`);
    if (deps.includes(task.id)) throw new Error(`Task ${task.id} cannot depend on itself (${task.id} -> ${task.id})`);
    return { id: task.id, duration: task.duration, dependsOn: [...deps].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) throw new Error(`Task ${task.id} references unknown dependency: ${dep}`);
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

function findCycle(ids: string[], tasks: Map<string, Task>): string[] {
  const color = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    const positions = new Map([[root, 0]]);
    color.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = tasks.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++];
      if (color.get(dep) === 1) return [...stack.slice(positions.get(dep)!).map(f => f.id), dep];
      if (!color.has(dep)) {
        positions.set(dep, stack.length);
        color.set(dep, 1);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error('Unable to locate cycle');
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
  const depth = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, depth.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Computed duration exceeds finite number range at task ${id}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depth.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        let low = 0, high = ready.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (compare(ready[mid], child) < 0) low = mid + 1;
          else high = mid;
        }
        ready.splice(low, 0, child);
      }
    }
  }
  if (order.length !== tasks.length) throw new Error(`Dependency cycle: ${findCycle(tasks.map(t => t.id), byId).join(' -> ')}`);
  for (const layer of layers) layer.sort(compare);

  // Mark nodes that can reach a maximum finish through edges with no idle time.
  // Greedy selection compares full sequences correctly even with zero durations:
  // a completed path is lexicographically smaller than any extension of itself.
  const viable = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || children.get(id)!.some(child =>
      viable.has(child) && earliest[id].finish === earliest[child].start)) viable.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => viable.has(task.id) && earliest[task.id].start === 0)?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = children.get(current)!.find(child => viable.has(child) && earliest[child].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args[0] !== 'plan') throw new Error('Unknown or missing command. Usage: bun run src/cli.ts plan INPUT.json');
    if (args.some(arg => arg.startsWith('-'))) throw new Error('Unknown flag. Usage: bun run src/cli.ts plan INPUT.json');
    if (args.length !== 2) throw new Error('Expected exactly one input file. Usage: bun run src/cli.ts plan INPUT.json');
    let input: unknown;
    const text = await Bun.file(args[1]).text();
    try { input = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${args[1]}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
