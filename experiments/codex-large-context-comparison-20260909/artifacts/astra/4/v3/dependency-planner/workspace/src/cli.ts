#!/usr/bin/env bun

export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!object(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    if (!object(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(id)) throw new Error(`Duplicate task id: ${JSON.stringify(id)}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${JSON.stringify(id)}: duration must be finite and non-negative`);
    }
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string")) {
      throw new Error(`Task ${JSON.stringify(id)}: dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`Task ${JSON.stringify(id)}: duplicate dependency`);
    }
    if (dependsOn.includes(id)) throw new Error(`Self dependency (cycle): ${id} -> ${id}`);
    return { id, duration, dependsOn: [...dependsOn].sort() };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${JSON.stringify(task.id)}: unknown dependency ${JSON.stringify(dep)}`);
    }
  }
  return tasks;
}

// A min heap ensures that newly ready ids compete with every already ready id.
class ReadyQueue {
  private items: string[] = [];
  push(id: string) {
    const a = this.items;
    let i = a.length;
    a.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent] <= id) break;
      a[i] = a[parent];
      i = parent;
    }
    a[i] = id;
  }
  pop(): string | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const first = a[0];
    const last = a.pop()!;
    if (a.length) {
      let i = 0;
      while (2 * i + 1 < a.length) {
        let child = 2 * i + 1;
        if (child + 1 < a.length && a[child + 1] < a[child]) child++;
        if (last <= a[child]) break;
        a[i] = a[child];
        i = child;
      }
      a[i] = last;
    }
    return first;
  }
}

function cycleIn(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  const position = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, index: 0 }];
    color.set(root, 1);
    position.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = children.get(frame.id)!;
      if (frame.index === next.length) {
        color.set(frame.id, 2);
        position.delete(frame.id);
        stack.pop();
        continue;
      }
      const id = next[frame.index++];
      if (color.get(id) === 1) return [...stack.slice(position.get(id)!).map(f => f.id), id];
      if (!color.has(id)) {
        color.set(id, 1);
        position.set(id, stack.length);
        stack.push({ id, index: 0 });
      }
    }
  }
  throw new Error("Internal error: cycle not found");
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort();
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const remaining = new Map<string, number>();
  const ready = new ReadyQueue();
  for (const id of ids) {
    const task = byId.get(id)!;
    remaining.set(id, task.dependsOn.length);
    if (!task.dependsOn.length) ready.push(id);
    for (const dep of task.dependsOn) children.get(dep)!.push(id);
  }
  const order: string[] = [];
  const layers: string[][] = [];
  const level = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  let totalDuration = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    order.push(id);
    const task = byId.get(id)!;
    let start = 0;
    let depth = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      depth = Math.max(depth, level.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration overflow at task ${JSON.stringify(id)}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    level.set(id, depth);
    (layers[depth] ??= []).push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${cycleIn(ids, children).join(" -> ")}`);
  for (const layer of layers) layer.sort();

  // Find the lexicographically first maximum chain using suffix scores.
  // Stopping beats extending with zero weight because a prefix sorts first.
  const suffix = new Map<string, number>();
  const successor = new Map<string, string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let best = 0;
    for (const child of children.get(id)!) {
      const score = suffix.get(child)!;
      if (score > best) {
        best = score;
        successor.set(id, child);
      }
    }
    suffix.set(id, byId.get(id)!.duration + best);
  }
  const criticalPath: string[] = [];
  // Use the maximum suffix score directly: floating-point addition can differ
  // from the forward schedule's association for fractional durations.
  let maximum = -Infinity;
  let first: string | undefined;
  for (const id of ids) {
    if (suffix.get(id)! > maximum) {
      maximum = suffix.get(id)!;
      first = id;
    }
  }
  for (let id = first; id !== undefined; id = successor.get(id)) criticalPath.push(id);
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args.some(arg => arg.startsWith("-"))) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)");
    }
    let input: unknown;
    const text = await Bun.file(args[1]).text();
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
