#!/usr/bin/env bun

type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Schedule = {
  start: number;
  finish: number;
  path: string[];
};

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function readTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be an object with a tasks array");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) fail("tasks must be an array");

  const ids = new Set<string>();
  const tasks: Task[] = tasksValue.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail(`tasks[${index}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    ids.add(raw.id);

    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`tasks[${index}].duration must be a finite non-negative number`);
    }
    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn) || !dependsOn.every((id) => typeof id === "string")) {
      fail(`tasks[${index}].dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      fail(`tasks[${index}].dependsOn must contain unique ids`);
    }
    if (dependsOn.includes(raw.id)) fail(`task ${raw.id} cannot depend on itself`);
    return { id: raw.id, duration: raw.duration, dependsOn: [...dependsOn] };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  return tasks;
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stack.push(id);
    for (const dependency of [...byId.get(id)!.dependsOn].sort()) {
      if (state.get(dependency) === 1) return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (state.get(dependency) !== 2) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, 2);
  }

  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!state.has(task.id)) {
      const cycle = visit(task.id);
      if (cycle) return cycle;
    }
  }
}

function insertSorted(values: string[], value: string): void {
  let index = 0;
  while (index < values.length && values[index].localeCompare(value) < 0) index++;
  values.splice(index, 0, value);
}

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!.sort()) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks, byId)!;
    fail(`cycle detected: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const schedules = new Map<string, Schedule>();
  const layers: string[][] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let predecessorPath: string[] = [];
    for (const dependency of task.dependsOn) {
      const previous = schedules.get(dependency)!;
      if (previous.finish > start || (previous.finish === start && comparePaths(previous.path, predecessorPath) < 0)) {
        start = previous.finish;
        predecessorPath = previous.path;
      }
    }
    const finish = start + task.duration;
    const path = [...predecessorPath, id];
    schedules.set(id, { start, finish, path });
    earliest[id] = { start, finish };
    const layer = task.dependsOn.length === 0 ? 0 : Math.max(...task.dependsOn.map((dependency) => layers.findIndex((items) => items.includes(dependency)) + 1));
    while (layers.length <= layer) layers.push([]);
    layers[layer].push(id);
  }
  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const schedule = schedules.get(id)!;
    if (schedule.finish > totalDuration || (schedule.finish === totalDuration && comparePaths(schedule.path, criticalPath) < 0)) {
      totalDuration = schedule.finish;
      criticalPath = schedule.path;
    }
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

function comparePaths(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "plan") {
    fail(`unknown command: ${args[0] ?? ""}`);
  }
  if (args.length !== 2 || args[1].startsWith("-")) {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }
  let input: unknown;
  try {
    input = JSON.parse(await Bun.file(args[1]).text());
  } catch (error) {
    fail(`cannot read valid JSON from ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(readTasks(input))));
}

await main();
