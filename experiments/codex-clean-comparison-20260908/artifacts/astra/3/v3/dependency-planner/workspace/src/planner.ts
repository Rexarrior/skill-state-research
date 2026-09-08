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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) {
    throw new Error("Input must be an object with a tasks array");
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    if (!record(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    }
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string")) {
      throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`Task ${id}: dependsOn contains duplicates`);
    }
    if (dependsOn.includes(id)) throw new Error(`Task ${id}: cannot depend on itself`);
    return { id, duration, dependsOn: [...dependsOn].sort() };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
    }
  }
  return tasks;
}

// Iterative DFS avoids call-stack limits on long dependency chains.
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
      const next = children.get(frame.id)!;
      if (frame.next === next.length) {
        color.set(frame.id, 2);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      const child = next[frame.next++];
      if (color.get(child) === 1) {
        return [...stack.slice(active.get(child)!).map(item => item.id), child];
      }
      if (!color.has(child)) {
        color.set(child, 1);
        active.set(child, stack.length);
        stack.push({ id: child, next: 0 });
      }
    }
  }
  throw new Error("Cycle detection failed");
}

// A binary min-heap keeps lexical Kahn ordering efficient for wide graphs.
class ReadyQueue {
  private items: string[] = [];
  push(id: string) {
    let i = this.items.length;
    this.items.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent] <= id) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = id;
  }
  pop(): string | undefined {
    if (!this.items.length) return undefined;
    const result = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (2 * i + 1 < this.items.length) {
        let child = 2 * i + 1;
        if (child + 1 < this.items.length && this.items[child + 1] < this.items[child]) child++;
        if (this.items[child] >= last) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return result;
  }
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort();
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const pending = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  }
  for (const list of children.values()) list.sort();
  const ready = new ReadyQueue();
  for (const id of ids) if (pending.get(id) === 0) ready.push(id);
  const order: string[] = [];
  const layers: string[][] = [];
  const level = new Map<string, number>();
  const earliest: Plan["earliest"] = Object.create(null);
  let totalDuration = 0;
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      layer = Math.max(layer, level.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Task ${id}: accumulated duration exceeds finite number range`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    level.set(id, layer);
    (layers[layer] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = pending.get(child)! - 1;
      pending.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.length) {
    throw new Error(`Dependency cycle: ${findCycle(ids, children).join(" -> ")}`);
  }
  for (const layer of layers) layer.sort();

  // Mark nodes that can reach a maximum finish using only timing-tight edges.
  // Greedy lexical traversal then compares entire sequences, not just endpoints.
  const optimal = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i];
    if (earliest[current].finish === totalDuration || children.get(current)!.some(child =>
      optimal.has(child) && earliest[current].finish === earliest[child].start
    )) optimal.add(current);
  }
  const criticalPath: string[] = [];
  let current = ids.find(id => earliest[id].start === 0 && optimal.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    // A sequence precedes all of its longer extensions.
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = children.get(current)!.find(child => optimal.has(child) && earliest[child].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}
