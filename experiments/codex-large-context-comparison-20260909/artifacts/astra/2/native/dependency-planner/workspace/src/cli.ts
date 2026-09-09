type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };

function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array.');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!isObject(value)) throw new Error(`${label} must be an object.`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string.`);
    }
    if (ids.has(id)) throw new Error(`Duplicate task id: ${JSON.stringify(id)}.`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${JSON.stringify(id)} duration must be finite and non-negative.`);
    }
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      throw new Error(`Task ${JSON.stringify(id)} dependsOn must be an array of strings.`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`Task ${JSON.stringify(id)} has duplicate dependencies.`);
    }
    if (dependsOn.includes(id)) throw new Error(`Task ${JSON.stringify(id)} depends on itself.`);
    return { id, duration, dependsOn: [...dependsOn].sort() };
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}.`);
      }
    }
  }
  return tasks;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A min heap keeps selection of the next ready id independent of input order.
class ReadyQueue {
  private items: string[] = [];
  push(id: string): void {
    let index = this.items.length;
    this.items.push(id);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent]! <= id) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = id;
  }
  pop(): string | undefined {
    const result = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last !== undefined) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1]! < this.items[child]!) child++;
        if (last <= this.items[child]!) break;
        this.items[index] = this.items[child]!;
        index = child;
      }
      this.items[index] = last;
    }
    return result;
  }
}

// Iterative DFS avoids call-stack limits on long cycles and dependency chains.
function findCycle(ids: string[], children: Map<string, string[]>): string[] {
  const state = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const root of ids) {
    if (state.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    state.set(root, 1);
    positions.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const child = children.get(frame.id)![frame.next++];
      if (child === undefined) {
        state.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
      } else if (state.get(child) === 1) {
        return [...stack.slice(positions.get(child)!).map((frame) => frame.id), child];
      } else if (!state.has(child)) {
        state.set(child, 1);
        positions.set(child, stack.length);
        stack.push({ id: child, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle.");
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ids = [...byId.keys()].sort();
  const children = new Map(ids.map((id) => [id, [] as string[]]));
  const pending = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) children.get(dependency)!.push(task.id);
  }
  for (const list of children.values()) list.sort();
  const ready = new ReadyQueue();
  for (const id of ids) if (pending.get(id) === 0) ready.push(id);
  const order: string[] = [];
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
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

  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      level = Math.max(level, levels.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error("Schedule duration exceeds the finite number range.");
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();

  // Choose suffixes, not prefixes: appending an id can reverse a prefix tie.
  // Stopping wins a tie against extending a chain with zero-duration tasks.
  const remaining = new Map<string, number>();
  const next = new Map<string, string>();
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index]!;
    let best = 0;
    for (const child of children.get(id)!) {
      const duration = remaining.get(child)!;
      if (duration > best) {
        best = duration;
        next.set(id, child);
      }
    }
    remaining.set(id, byId.get(id)!.duration + best);
  }
  let first: string | undefined;
  let longest = -1;
  for (const id of ids) {
    if (remaining.get(id)! > longest) {
      first = id;
      longest = remaining.get(id)!;
    }
  }
  const criticalPath: string[] = [];
  for (let id = first; id !== undefined; id = next.get(id)) criticalPath.push(id);
  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
    throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
  }
  let input: unknown;
  const contents = await Bun.file(args[1]!).text();
  try {
    input = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
