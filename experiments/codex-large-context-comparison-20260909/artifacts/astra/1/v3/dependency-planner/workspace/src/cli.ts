type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new Error("Input must be an object with a tasks array");
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    if (!isObject(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(id)) throw new Error(`Duplicate task id: ${JSON.stringify(id)}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Duration for ${JSON.stringify(id)} must be finite and non-negative`);
    }
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string")) {
      throw new Error(`dependsOn for ${JSON.stringify(id)} must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`Duplicate dependency for ${JSON.stringify(id)}`);
    }
    if (dependsOn.includes(id)) throw new Error(`Task ${JSON.stringify(id)} cannot depend on itself`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Unknown dependency ${JSON.stringify(dep)} for ${JSON.stringify(task.id)}`);
    }
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// Iterative DFS avoids call-stack limits and follows sorted dependency edges.
function findCycle(tasks: Task[], byId: Map<string, Task>): string[] {
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
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++];
      if (color.get(dep) === 1) {
        return [...stack.slice(positions.get(dep)!).map(item => item.id), dep];
      }
      if (!color.has(dep)) {
        color.set(dep, 1);
        positions.set(dep, stack.length);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = compare(a[i], b[i]);
    if (difference) return difference;
  }
  return a.length - b.length;
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  }
  const ready = tasks.filter(task => task.dependsOn.length === 0).map(task => task.id);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  const paths = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    order.push(id);
    let start = 0;
    let level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration overflow at ${JSON.stringify(id)}`);
    earliest[id] = { start, finish };
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    // A chain may start here if all preceding work has zero duration.
    let path: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dep of task.dependsOn) {
      if (earliest[dep].finish !== start) continue;
      const candidate = [...paths.get(dep)!, id];
      if (!path || comparePaths(candidate, path) < 0) path = candidate;
    }
    paths.set(id, path!);
    if (!criticalPath.length || finish > totalDuration ||
        (finish === totalDuration && comparePaths(path!, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = path!;
    }
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        // Keep the frontier sorted, including tasks unlocked during this step.
        let low = 0;
        let high = ready.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (compare(ready[mid], child) < 0) low = mid + 1;
          else high = mid;
        }
        ready.splice(low, 0, child);
      }
    }
  }
  if (order.length !== tasks.length) {
    throw new Error(`Cycle detected: ${findCycle(tasks, byId).join(" -> ")}`);
  }
  layers.forEach(layer => layer.sort(compare));
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
