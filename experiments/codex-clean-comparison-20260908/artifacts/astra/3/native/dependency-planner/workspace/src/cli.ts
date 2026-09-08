#!/usr/bin/env bun

export type Task = { id: string; duration: number; dependsOn: string[] };
export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!object(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!object(value) || typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${value.id}`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const deps = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(deps) || deps.some((id: unknown) => typeof id !== "string")) {
      throw new Error(`${label}.dependsOn must be an array of strings`);
    }
    if (new Set(deps).size !== deps.length) throw new Error(`${label}.dependsOn contains duplicates`);
    if (deps.includes(value.id)) throw new Error(`Task ${value.id} cannot depend on itself`);
    return { id: value.id, duration: value.duration, dependsOn: [...deps].sort() };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id} references unknown dependency: ${dep}`);
    }
  }
  return tasks;
}

// A min-heap keeps the next ready id deterministic without repeatedly sorting.
class ReadyQueue {
  private values: string[] = [];
  push(id: string): void {
    let i = this.values.length;
    this.values.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent] <= id) break;
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.values[i] = id;
  }
  pop(): string | undefined {
    if (this.values.length === 0) return undefined;
    const first = this.values[0];
    const last = this.values.pop()!;
    if (this.values.length > 0) {
      let i = 0;
      while (i * 2 + 1 < this.values.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.values.length && this.values[child + 1] < this.values[child]) child++;
        if (last <= this.values[child]) break;
        this.values[i] = this.values[child];
        i = child;
      }
      this.values[i] = last;
    }
    return first;
  }
}

function concreteCycle(tasks: Map<string, Task>): string[] {
  const done = new Set<string>();
  const active = new Map<string, number>();
  // Iterative DFS also handles cycles deeper than the JavaScript call stack.
  for (const root of [...tasks.keys()].sort()) {
    if (done.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    active.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = tasks.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        done.add(frame.id);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++];
      const position = active.get(dep);
      if (position !== undefined) return [...stack.slice(position).map(frame => frame.id), dep];
      if (!done.has(dep)) {
        active.set(dep, stack.length);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown): Plan {
  const tasks = new Map(validate(input).map(task => [task.id, task]));
  const remaining = new Map<string, number>();
  const children = new Map<string, string[]>();
  const ready = new ReadyQueue();
  for (const task of tasks.values()) {
    remaining.set(task.id, task.dependsOn.length);
    children.set(task.id, []);
    if (!task.dependsOn.length) ready.push(task.id);
  }
  for (const task of tasks.values()) {
    for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  }
  for (const list of children.values()) list.sort();
  const order: string[] = [];
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.size) {
    throw new Error(`Cycle detected: ${concreteCycle(tasks).join(" -> ")}`);
  }

  const layers: string[][] = [];
  const depths = new Map<string, number>();
  const earliest: Plan["earliest"] = Object.create(null);
  let totalDuration = 0;
  for (const id of order) {
    const task = tasks.get(id)!;
    let start = 0;
    let depth = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      depth = Math.max(depth, depths.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds the finite number range at task ${id}`);
    earliest[id] = { start, finish };
    depths.set(id, depth);
    (layers[depth] ??= []).push(id);
    totalDuration = Math.max(totalDuration, finish);
  }
  for (const layer of layers) layer.sort();

  // Mark paths that reach the makespan using edges with no scheduling slack.
  // Greedy lexical choices then compare complete sequences correctly, even
  // when zero-duration nodes make one candidate a prefix of another.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || children.get(id)!.some(child =>
      reachesEnd.has(child) && earliest[id].finish === earliest[child].start)) {
      reachesEnd.add(id);
    }
  }
  const criticalPath: string[] = [];
  let current = [...tasks.keys()].sort().find(id => earliest[id].start === 0 && reachesEnd.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = children.get(current)!.find(child => reachesEnd.has(child) && earliest[child].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    }
    const content = await Bun.file(args[1]).text();
    let input: unknown;
    try {
      input = JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
