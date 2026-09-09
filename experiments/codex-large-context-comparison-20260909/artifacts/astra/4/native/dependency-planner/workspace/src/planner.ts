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

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new Error("Input must be an object with a tasks array");
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${JSON.stringify(value.id)}`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const dependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string")) {
      throw new Error(`${label}.dependsOn must be an array of unique strings`);
    }
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`${label}.dependsOn contains duplicate ids`);
    }
    if (dependencies.includes(value.id)) throw new Error(`${label} cannot depend on itself (${value.id})`);
    return { id: value.id, duration: value.duration, dependsOn: [...dependencies] };
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

// A min-heap keeps ready-task selection lexicographic without repeated sorting.
class ReadyQueue {
  private items: string[] = [];
  push(id: string) {
    let i = this.items.length;
    this.items.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(this.items[parent], id) <= 0) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = id;
  }
  pop(): string | undefined {
    if (!this.items.length) return undefined;
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && compare(this.items[child + 1], this.items[child]) < 0) child++;
        if (compare(last, this.items[child]) <= 0) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

// Iterative DFS avoids call-stack limits on long dependency chains.
function findCycle(ids: string[], outgoing: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  const positions = new Map<string, number>();
  const stack: { id: string; next: number }[] = [];
  for (const root of ids) {
    if (color.has(root)) continue;
    color.set(root, 1);
    positions.set(root, 0);
    stack.push({ id: root, next: 0 });
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = outgoing.get(frame.id)!;
      if (frame.next === children.length) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const child = children[frame.next++];
      if (color.get(child) === 1) {
        return [...stack.slice(positions.get(child)!).map(frame => frame.id), child];
      }
      if (!color.has(child)) {
        color.set(child, 1);
        positions.set(child, stack.length);
        stack.push({ id: child, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort(compare);
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) outgoing.get(dependency)!.push(task.id);
  }
  for (const children of outgoing.values()) children.sort(compare);
  const ready = new ReadyQueue();
  for (const id of ids) if (remaining.get(id) === 0) ready.push(id);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Plan["earliest"] = Object.create(null);
  let totalDuration = 0;
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      level = Math.max(level, levels.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Total duration exceeds the finite numeric range at task ${JSON.stringify(id)}`);
    earliest[id] = { start, finish };
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    totalDuration = Math.max(totalDuration, finish);
    order.push(id);
    for (const child of outgoing.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.length) {
    throw new Error(`Cycle detected: ${findCycle(ids, outgoing).join(" -> ")}`);
  }
  for (const layer of layers) layer.sort(compare);

  // Mark nodes that can reach a maximum-finish endpoint using tight timing
  // edges. Greedy forward selection compares full sequences correctly, even
  // when zero-duration nodes make one candidate a prefix of another.
  const viable = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i];
    if (earliest[current].finish === totalDuration || outgoing.get(current)!.some(
      child => viable.has(child) && earliest[current].finish === earliest[child].start,
    )) viable.add(current);
  }
  const criticalPath: string[] = [];
  let current = ids.find(id => viable.has(id) && earliest[id].start === 0);
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = outgoing.get(current)!.find(child => viable.has(child) && earliest[child].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}
