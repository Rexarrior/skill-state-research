type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null ||
      !Array.isArray((input as { tasks?: unknown }).tasks)) {
    throw new Error("Input must be an object with a tasks array");
  }
  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (const [index, value] of (input as { tasks: unknown[] }).tasks.entries()) {
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${JSON.stringify(task.id)}`);
    ids.add(task.id);
    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const dependencies = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string")) {
      throw new Error(`${label}.dependsOn must be an array of strings`);
    }
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`${label}.dependsOn must contain unique ids`);
    }
    if (dependencies.includes(task.id)) {
      throw new Error(`Task ${JSON.stringify(task.id)} cannot depend on itself`);
    }
    tasks.push({ id: task.id, duration: task.duration, dependsOn: [...dependencies].sort(compare) });
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
      }
    }
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// A min-heap ensures newly ready tasks compete with every already ready task.
class ReadyQueue {
  private items: string[] = [];
  push(id: string): void {
    const items = this.items;
    let index = items.length;
    items.push(id);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compare(items[parent]!, id) <= 0) break;
      items[index] = items[parent]!;
      index = parent;
    }
    items[index] = id;
  }
  pop(): string | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const first = items[0]!;
    const last = items.pop()!;
    if (items.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < items.length) {
      let child = index * 2 + 1;
      if (child + 1 < items.length && compare(items[child + 1]!, items[child]!) < 0) child++;
      if (compare(last, items[child]!) <= 0) break;
      items[index] = items[child]!;
      index = child;
    }
    items[index] = last;
    return first;
  }
}

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = compare(a[i]!, b[i]!);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

// Iterative DFS avoids overflowing the call stack on long cyclic graphs.
function findCycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const task of tasks) {
    if (state.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    state.set(task.id, 1);
    positions.set(task.id, 0);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const dependencies = byId.get(frame.id)!.dependsOn;
      if (frame.next === dependencies.length) {
        state.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const id = dependencies[frame.next++]!;
      if (state.get(id) === 1) {
        return [...stack.slice(positions.get(id)!).map(frame => frame.id), id];
      }
      if (!state.has(id)) {
        state.set(id, 1);
        positions.set(id, stack.length);
        stack.push({ id, next: 0 });
      }
    }
  }
  throw new Error("Internal error: cycle not found");
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map(task => [task.id, [] as string[]]));
  const ready = new ReadyQueue();
  for (const task of tasks) {
    if (task.dependsOn.length === 0) ready.push(task.id);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  const order: string[] = [];
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  if (order.length !== tasks.length) {
    throw new Error(`Dependency cycle: ${findCycle(tasks, byId).join(" -> ")}`);
  }

  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const timings = new Map<string, Timing>();
  const paths = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] | undefined;
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, timings.get(dependency)!.finish);
      level = Math.max(level, levels.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration overflows at task ${JSON.stringify(id)}`);
    timings.set(id, { start, finish });
    levels.set(id, level);
    (layers[level] ??= []).push(id);

    // A chain may start or stop at any task, including zero-duration tasks.
    let path: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dependency of task.dependsOn) {
      if (timings.get(dependency)!.finish !== start) continue;
      const candidate = [...paths.get(dependency)!, id];
      if (path === undefined || comparePaths(candidate, path) < 0) path = candidate;
    }
    paths.set(id, path!);
    if (criticalPath === undefined || finish > totalDuration ||
        (finish === totalDuration && comparePaths(path!, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = path!;
    }
  }
  for (const layer of layers) layer.sort(compare);
  return {
    order,
    layers,
    earliest: Object.fromEntries(tasks.map(task => [task.id, timings.get(task.id)!])),
    totalDuration,
    criticalPath: criticalPath ?? [],
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args.some(arg => arg.startsWith("-"))) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    }
    const source = await Bun.file(args[1]!).text();
    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
