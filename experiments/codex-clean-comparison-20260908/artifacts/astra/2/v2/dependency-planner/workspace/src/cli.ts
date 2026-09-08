type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || !Array.isArray((input as any).tasks)) {
    throw new Error("Input must be an object with a tasks array");
  }
  const ids = new Set<string>();
  const tasks: Task[] = (input as any).tasks.map((value: unknown, index: number) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`tasks[${index}] must be an object`);
    }
    const { id, duration, dependsOn = [] } = value as Task;
    if (typeof id !== "string" || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${JSON.stringify(id)}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${JSON.stringify(id)} duration must be a finite non-negative number`);
    }
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string")) {
      throw new Error(`Task ${JSON.stringify(id)} dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${JSON.stringify(id)} has duplicate dependencies`);
    if (dependsOn.includes(id)) throw new Error(`Task ${JSON.stringify(id)} cannot depend on itself: ${id} -> ${id}`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dep)}`);
    }
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// Iterative DFS avoids overflowing the call stack on long dependency chains.
function findCycle(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  const active = new Map<string, number>();
  const stack: { id: string; next: number }[] = [];
  for (const root of ids) {
    if (color.has(root)) continue;
    color.set(root, 1);
    active.set(root, 0);
    stack.push({ id: root, next: 0 });
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = children.get(frame.id)!;
      if (frame.next === edges.length) {
        color.set(frame.id, 2);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      const id = edges[frame.next++];
      if (color.get(id) === 1) return [...stack.slice(active.get(id)!).map(item => item.id), id];
      if (!color.has(id)) {
        color.set(id, 1);
        active.set(id, stack.length);
        stack.push({ id, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
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
  const timings = new Map<string, Timing>();
  let totalDuration = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, timings.get(dep)!.finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds numeric range at task ${JSON.stringify(id)}`);
    timings.set(id, { start, finish });
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    totalDuration = Math.max(totalDuration, finish);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        // Insert into the sorted ready queue, including newly ready tasks.
        let lo = 0, hi = ready.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (compare(ready[mid], child) < 0) lo = mid + 1;
          else hi = mid;
        }
        ready.splice(lo, 0, child);
      }
    }
  }
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${findCycle(tasks.map(task => task.id), children).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // A tight edge preserves the longest prefix. Mark tight paths that reach
  // a maximum-finish task, then choose the smallest viable id at each step.
  // Stopping first wins prefix ties, including trailing zero-duration tasks.
  const viable = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const finish = timings.get(id)!.finish;
    if (finish === totalDuration || children.get(id)!.some(child => viable.has(child) && timings.get(child)!.start === finish)) viable.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => viable.has(task.id) && timings.get(task.id)!.start === 0)?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    const finish = timings.get(current)!.finish;
    if (finish === totalDuration) break;
    current = children.get(current)!.find(child => viable.has(child) && timings.get(child)!.start === finish);
  }
  const earliest: Record<string, Timing> = Object.create(null);
  for (const task of tasks) earliest[task.id] = timings.get(task.id)!;
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    }
    let input: unknown;
    const text = await Bun.file(args[1]).text();
    try { input = JSON.parse(text); }
    catch { throw new Error(`Invalid JSON in ${JSON.stringify(args[1])}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
