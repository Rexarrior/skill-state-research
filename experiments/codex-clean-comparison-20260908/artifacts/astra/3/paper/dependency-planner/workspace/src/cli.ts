export type Task = { id: string; duration: number; dependsOn: string[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) throw new Error("Input must contain a tasks array");
  const ids = new Set<string>();
  const tasks = input.tasks.map((raw, index): Task => {
    if (!record(raw)) throw new Error(`Task ${index} must be an object`);
    const { id, duration } = raw;
    if (typeof id !== "string" || id.length === 0) throw new Error(`Task ${index}: id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    }
    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string")) {
      throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (dependsOn.includes(id)) throw new Error(`Task ${id}: self dependency (${id} -> ${id})`);
    return { id, duration, dependsOn: [...dependsOn].sort() };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
    }
  }
  return tasks;
}

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

// Iterative DFS avoids call-stack limits on long dependency chains.
function findCycle(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  const path: string[] = [];
  const positions = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    color.set(root, 1);
    positions.set(root, 0);
    path.push(root);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = children.get(frame.id)![frame.next++];
      if (next === undefined) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        path.pop();
        stack.pop();
      } else if (color.get(next) === 1) {
        return [...path.slice(positions.get(next)!), next];
      } else if (!color.has(next)) {
        color.set(next, 1);
        positions.set(next, path.length);
        path.push(next);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort();
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  for (const list of children.values()) list.sort();
  const ready = ids.filter(id => remaining.get(id) === 0);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
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
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds finite numeric range at task ${id}`);
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
    ready.sort();
  }
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${findCycle(ids, children).join(" -> ")}`);
  for (const layer of layers) layer.sort();

  // Every node can start or end a chain. Empty suffixes beat zero-duration
  // extensions, while zero-duration prefixes can make a full path smaller.
  const suffix = new Map<string, { duration: number; path: string[] }>();
  let criticalPath: string[] = [];
  let longest = -1;
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    let best = { duration: byId.get(id)!.duration, path: [id] };
    for (const child of children.get(id)!) {
      const tail = suffix.get(child)!;
      const candidate = { duration: byId.get(id)!.duration + tail.duration, path: [id, ...tail.path] };
      if (candidate.duration > best.duration || (candidate.duration === best.duration && comparePaths(candidate.path, best.path) < 0)) best = candidate;
    }
    suffix.set(id, best);
    if (best.duration > longest || (best.duration === longest && comparePaths(best.path, criticalPath) < 0)) {
      longest = best.duration;
      criticalPath = best.path;
    }
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    }
    const text = await Bun.file(args[1]!).text();
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new Error("Invalid JSON in input file"); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
