#!/usr/bin/env bun

type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function validate(input: unknown): Task[] {
  if (input === null || typeof input !== 'object' || !Array.isArray((input as any).tasks)) {
    throw new Error('Input must be an object with a tasks array');
  }
  const ids = new Set<string>();
  const tasks: Task[] = (input as { tasks: unknown[] }).tasks.map((value, index) => {
    const label = `tasks[${index}]`;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    const task = value as Record<string, unknown>;
    if (typeof task.id !== 'string' || task.id.length === 0) throw new Error(`${label}.id must be a non-empty string`);
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.duration !== 'number' || !Number.isFinite(task.duration) || task.duration < 0) {
      throw new Error(`Task ${task.id}: duration must be a finite non-negative number`);
    }
    const dependencies = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== 'string')) {
      throw new Error(`Task ${task.id}: dependsOn must be an array of strings`);
    }
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`Task ${task.id}: duplicate dependency`);
    if (dependencies.includes(task.id)) throw new Error(`Task ${task.id}: self-dependency (${task.id} -> ${task.id})`);
    return { id: task.id, duration: task.duration, dependsOn: [...dependencies].sort(compare) };
  });
  for (const task of tasks) {
    for (const id of task.dependsOn) if (!ids.has(id)) throw new Error(`Task ${task.id}: unknown dependency ${id}`);
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// Iterative DFS avoids exhausting the call stack on long dependency chains.
function findCycle(ids: string[], outgoing: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  const position = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    color.set(root, 1);
    position.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = outgoing.get(frame.id)!;
      if (frame.next === children.length) {
        color.set(frame.id, 2);
        position.delete(frame.id);
        stack.pop();
        continue;
      }
      const child = children[frame.next++];
      if (color.get(child) === 1) return [...stack.slice(position.get(child)!).map(f => f.id), child];
      if (!color.has(child)) {
        color.set(child, 1);
        position.set(child, stack.length);
        stack.push({ id: child, next: 0 });
      }
    }
  }
  return [];
}

class MinHeap {
  private values: string[] = [];
  get size() { return this.values.length; }
  push(value: string) {
    let i = this.values.length;
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(this.values[parent], value) <= 0) break;
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.values[i] = value;
  }
  pop(): string {
    const result = this.values[0];
    const tail = this.values.pop()!;
    if (this.values.length) {
      let i = 0;
      while (2 * i + 1 < this.values.length) {
        let child = 2 * i + 1;
        if (child + 1 < this.values.length && compare(this.values[child + 1], this.values[child]) < 0) child++;
        if (compare(tail, this.values[child]) <= 0) break;
        this.values[i] = this.values[child];
        i = child;
      }
      this.values[i] = tail;
    }
    return result;
  }
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const outgoing = new Map(tasks.map(task => [task.id, [] as string[]]));
  const pending = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) outgoing.get(dep)!.push(task.id);
  const ready = new MinHeap();
  for (const task of tasks) if (!task.dependsOn.length) ready.push(task.id);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  while (ready.size) {
    const id = ready.pop();
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration overflow at task ${id}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of outgoing.get(id)!) {
      const count = pending.get(child)! - 1;
      pending.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.length) {
    throw new Error(`Cycle detected: ${findCycle(tasks.map(t => t.id), outgoing).join(' -> ')}`);
  }
  for (const layer of layers) layer.sort(compare);

  // Mark tight edges that can reach the maximum finish. Greedy traversal then
  // compares full sequences correctly even when zero-duration tasks create ties.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || outgoing.get(id)!.some(child =>
      earliest[id].finish === earliest[child].start && reachesEnd.has(child))) reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => earliest[task.id].start === 0 && reachesEnd.has(task.id))?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = outgoing.get(current)!.find(child => earliest[child].start === finish && reachesEnd.has(child));
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'plan' || args[1].startsWith('-')) {
      throw new Error('Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)');
    }
    let input: unknown;
    const text = await Bun.file(args[1]).text();
    try { input = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${args[1]}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
