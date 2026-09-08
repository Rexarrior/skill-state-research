export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export interface Plan {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${JSON.stringify(value.id)}`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const dependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string")) {
      throw new Error(`${label}.dependsOn must be an array of strings`);
    }
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`${label}.dependsOn contains duplicate dependencies`);
    }
    if (dependencies.includes(value.id)) throw new Error(`${label} cannot depend on itself`);
    return { id: value.id, duration: value.duration, dependsOn: [...dependencies].sort(compare) };
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
      }
    }
  }
  return tasks;
}

// A min-heap keeps each ready-task choice lexical, including newly ready tasks.
class ReadyQueue {
  private items: string[] = [];
  push(id: string): void {
    const items = this.items;
    let i = items.length;
    items.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(items[parent]!, id) <= 0) break;
      items[i] = items[parent]!;
      i = parent;
    }
    items[i] = id;
  }
  pop(): string | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const first = items[0]!;
    const last = items.pop()!;
    if (items.length) {
      let i = 0;
      while (2 * i + 1 < items.length) {
        let child = 2 * i + 1;
        if (child + 1 < items.length && compare(items[child + 1]!, items[child]!) < 0) child++;
        if (compare(last, items[child]!) <= 0) break;
        items[i] = items[child]!;
        i = child;
      }
      items[i] = last;
    }
    return first;
  }
}

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
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort(compare);
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const pending = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) children.get(dependency)!.push(task.id);
  }
  for (const list of children.values()) list.sort(compare);
  const ready = new ReadyQueue();
  for (const id of ids) if (pending.get(id) === 0) ready.push(id);
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Plan["earliest"] = Object.create(null);
  let totalDuration = 0;
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      layer = Math.max(layer, depth.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration overflow at task ${JSON.stringify(id)}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depth.set(id, layer);
    (layers[layer] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = pending.get(child)! - 1;
      pending.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.length) {
    throw new Error(`Cycle detected: ${findCycle(ids, children).join(" -> ")}`);
  }
  for (const layer of layers) layer.sort(compare);

  // Mark tasks that can reach a maximum finish through timing-tight edges.
  // Greedily choose the smallest eligible next id. End a chain immediately
  // when it reaches the total: a sequence sorts before any extension of itself.
  const reachesTotal = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i]!;
    if (earliest[current]!.finish === totalDuration || children.get(current)!.some(child =>
      reachesTotal.has(child) && earliest[current]!.finish === earliest[child]!.start)) {
      reachesTotal.add(current);
    }
  }
  const criticalPath: string[] = [];
  let current = ids.find(id => earliest[id]!.start === 0 && reachesTotal.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current]!.finish === totalDuration) break;
    const finish = earliest[current]!.finish;
    current = children.get(current)!.find(child => reachesTotal.has(child) && earliest[child]!.start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    }
    let input: unknown;
    const text = await Bun.file(args[1]!).text();
    try {
      input = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
