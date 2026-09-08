type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };

function fail(message: string): never {
  throw new Error(message);
}

function validate(input: unknown): Task[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as any).tasks)) {
    fail("Input must be an object with a tasks array");
  }
  const ids = new Set<string>();
  const tasks: Task[] = (input as { tasks: unknown[] }).tasks.map((value, i) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`tasks[${i}] must be an object`);
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) fail(`tasks[${i}].id must be a non-empty string`);
    if (ids.has(task.id)) fail(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      fail(`Task ${task.id}: duration must be a finite non-negative number`);
    }
    const dependencies = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string")) {
      fail(`Task ${task.id}: dependsOn must be an array of strings`);
    }
    if (new Set(dependencies).size !== dependencies.length) fail(`Task ${task.id}: duplicate dependency`);
    if (dependencies.includes(task.id)) fail(`Task ${task.id}: self-dependency (${task.id} -> ${task.id})`);
    return { id: task.id, duration: task.duration, dependsOn: dependencies };
  });
  for (const task of tasks) {
    for (const id of task.dependsOn) {
      if (!ids.has(id)) fail(`Task ${task.id}: unknown dependency ${id}`);
    }
  }
  return tasks;
}

// A min heap keeps the ready frontier lexicographic without repeated full sorts.
class ReadyQueue {
  private values: string[] = [];
  push(id: string) {
    const a = this.values;
    let i = a.length;
    a.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]! <= id) break;
      a[i] = a[parent]!;
      i = parent;
    }
    a[i] = id;
  }
  pop(): string | undefined {
    const a = this.values;
    if (!a.length) return undefined;
    const first = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let child = i * 2 + 1;
        if (child + 1 < a.length && a[child + 1]! < a[child]!) child++;
        if (last <= a[child]!) break;
        a[i] = a[child]!;
        i = child;
      }
      a[i] = last;
    }
    return first;
  }
}

// Iterative DFS avoids call-stack limits and reports an actual directed cycle.
function findCycle(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    color.set(root, 1);
    positions.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = children.get(frame.id)![frame.next++];
      if (next === undefined) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
      } else if (color.get(next) === 1) {
        return [...stack.slice(positions.get(next)!).map(frame => frame.id), next];
      } else if (!color.has(next)) {
        color.set(next, 1);
        positions.set(next, stack.length);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  return [];
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort();
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const remaining = new Map<string, number>();
  const ready = new ReadyQueue();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dependency of task.dependsOn) children.get(dependency)!.push(task.id);
  }
  for (const list of children.values()) list.sort();
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      level = Math.max(level, levels.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) fail(`Task ${id}: schedule duration exceeds finite numeric range`);
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
  }
  if (order.length !== tasks.length) fail(`Dependency cycle: ${findCycle(ids, children).join(" -> ")}`);
  for (const layer of layers) layer.sort();

  // Mark nodes that can reach a maximum finish through tight scheduling edges.
  // Greedy selection on this subgraph compares whole sequences, including prefixes.
  const critical = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (earliest[id]!.finish === totalDuration || children.get(id)!.some(child =>
      critical.has(child) && earliest[id]!.finish === earliest[child]!.start
    )) critical.add(id);
  }
  const criticalPath: string[] = [];
  let current = ids.find(id => critical.has(id) && earliest[id]!.start === 0);
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current]!.finish === totalDuration) break;
    const finish = earliest[current]!.finish;
    current = children.get(current)!.find(child => critical.has(child) && earliest[child]!.start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
      fail("Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)");
    }
    let input: unknown;
    try {
      input = JSON.parse(await Bun.file(args[1]!).text());
    } catch (error) {
      fail(`Cannot read JSON input: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
