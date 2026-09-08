type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };

function fail(message: string): never {
  throw new Error(message);
}

function validate(input: unknown): Task[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as any).tasks)) {
    fail('Input must be an object with a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks: Task[] = (input as { tasks: unknown[] }).tasks.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`tasks[${index}] must be an object`);
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) fail(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(task.id)) fail(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      fail(`Task ${task.id}: duration must be a finite non-negative number`);
    }
    const dependsOn = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(id => typeof id !== "string")) fail(`Task ${task.id}: dependsOn must be an array of strings`);
    if (new Set(dependsOn).size !== dependsOn.length) fail(`Task ${task.id}: duplicate dependency`);
    if (dependsOn.includes(task.id)) fail(`Task ${task.id}: self-dependency (${task.id} -> ${task.id})`);
    return { id: task.id, duration: task.duration, dependsOn: [...dependsOn].sort() };
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`Task ${task.id}: unknown dependency ${dependency}`);
    }
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Iterative DFS avoids call-stack limits and returns an actual directed cycle.
function cycleIn(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    const positions = new Map([[root, 0]]);
    color.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = children.get(frame.id)!;
      if (frame.next === next.length) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const child = next[frame.next++];
      if (color.get(child) === 1) return [...stack.slice(positions.get(child)!).map(frame => frame.id), child];
      if (!color.has(child)) {
        positions.set(child, stack.length);
        color.set(child, 1);
        stack.push({ id: child, next: 0 });
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
  for (const task of tasks) for (const dependency of task.dependsOn) children.get(dependency)!.push(task.id);
  const ready = tasks.filter(task => task.dependsOn.length === 0).map(task => task.id);
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      layer = Math.max(layer, depth.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) fail(`Task ${id}: total duration exceeds the finite numeric range`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depth.set(id, layer);
    (layers[layer] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        // Binary insertion maintains the lexicographically smallest ready task.
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
  if (order.length !== tasks.length) fail(`Dependency cycle: ${cycleIn(tasks.map(task => task.id), children).join(" -> ")}`);
  for (const layer of layers) layer.sort();

  // Maximum-weight suffixes let us compare complete chains, including zero
  // duration alternatives. A sequence sorts before its strict extensions.
  const weight = new Map<string, number>();
  const successor = new Map<string, string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let best = 0;
    for (const child of children.get(id)!) {
      if (weight.get(child)! > best) {
        best = weight.get(child)!;
        successor.set(id, child);
      }
    }
    weight.set(id, byId.get(id)!.duration + best);
  }
  let first: string | undefined;
  let maximum = -1;
  for (const task of tasks) {
    if (weight.get(task.id)! > maximum) {
      maximum = weight.get(task.id)!;
      first = task.id;
    }
  }
  const criticalPath: string[] = [];
  while (first !== undefined) {
    criticalPath.push(first);
    first = successor.get(first);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
      fail("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    }
    let input: unknown;
    try {
      input = JSON.parse(await Bun.file(args[1]).text());
    } catch (error) {
      fail(`Cannot read JSON input ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
