#!/usr/bin/env bun

type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array.');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string.`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${JSON.stringify(value.id)}.`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number.`);
    }
    const dependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some((id: unknown) => typeof id !== "string")) {
      throw new Error(`${label}.dependsOn must be an array of unique strings.`);
    }
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`${label}.dependsOn contains duplicate dependencies.`);
    }
    if (dependencies.includes(value.id)) {
      throw new Error(`Task ${JSON.stringify(value.id)} cannot depend on itself: ${value.id} -> ${value.id}.`);
    }
    return { id: value.id, duration: value.duration, dependsOn: [...dependencies].sort(compare) };
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}.`);
      }
    }
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// A min-heap keeps ready-task selection efficient even for wide graphs.
class ReadyQueue {
  private values: string[] = [];
  push(value: string) {
    const values = this.values;
    let index = values.length;
    values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compare(values[parent], value) <= 0) break;
      values[index] = values[parent];
      index = parent;
    }
    values[index] = value;
  }
  pop(): string | undefined {
    const values = this.values;
    if (values.length === 0) return undefined;
    const first = values[0];
    const last = values.pop()!;
    if (values.length) {
      let index = 0;
      while (index * 2 + 1 < values.length) {
        let child = index * 2 + 1;
        if (child + 1 < values.length && compare(values[child + 1], values[child]) < 0) child++;
        if (compare(last, values[child]) <= 0) break;
        values[index] = values[child];
        index = child;
      }
      values[index] = last;
    }
    return first;
  }
}

// Iterative DFS avoids call-stack limits on long dependency chains.
function findCycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  for (const task of tasks) {
    if (state.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    state.set(task.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const dependencies = byId.get(frame.id)!.dependsOn;
      if (frame.next === dependencies.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const next = dependencies[frame.next++];
      if (state.get(next) === 1) {
        const start = stack.findIndex((entry) => entry.id === next);
        return [...stack.slice(start).map((entry) => entry.id), next];
      }
      if (!state.has(next)) {
        state.set(next, 1);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  throw new Error("Cycle detection failed.");
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const pending = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const ready = new ReadyQueue();
  for (const task of tasks) {
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      level = Math.max(level, depth.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds the finite number range at task ${JSON.stringify(id)}.`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depth.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = pending.get(dependent)! - 1;
      pending.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  if (order.length !== tasks.length) {
    throw new Error(`Dependency cycle: ${findCycle(tasks, byId).join(" -> ")}`);
  }
  for (const layer of layers) layer.sort(compare);

  // Mark tight edges that can reach a maximum finish, then choose the
  // smallest viable next id. Stop at the first valid endpoint: a prefix
  // sorts before any extension, including extensions of zero duration.
  const viable = new Set<string>();
  for (let index = order.length - 1; index >= 0; index--) {
    const current = order[index];
    if (earliest[current].finish === totalDuration || dependents.get(current)!.some(
      (next) => viable.has(next) && earliest[current].finish === earliest[next].start,
    )) viable.add(current);
  }
  const criticalPath: string[] = [];
  let current = tasks.find((task) => earliest[task.id].start === 0 && viable.has(task.id))?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = dependents.get(current)!.find((next) => viable.has(next) && earliest[next].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
  }
  let input: unknown;
  const content = await Bun.file(args[1]).text();
  try {
    input = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${JSON.stringify(args[1])}: ${(error as Error).message}`);
  }
  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
