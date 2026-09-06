#!/usr/bin/env bun

type InputTask = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validate(value: unknown): InputTask[] {
  const root = asObject(value, "Input");
  if (!Array.isArray(root.tasks)) fail("tasks must be an array");

  const tasks: InputTask[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < root.tasks.length; index++) {
    const raw = asObject(root.tasks[index], `tasks[${index}]`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`tasks[${index}].duration must be a finite non-negative number`);
    }
    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      fail(`tasks[${index}].dependsOn must be an array of strings`);
    }
    const dependencies = dependsOn as string[];
    if (new Set(dependencies).size !== dependencies.length) {
      fail(`tasks[${index}].dependsOn must contain unique ids`);
    }
    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown id: ${dependency}`);
    }
  }
  return tasks;
}

function findCycle(tasks: Map<string, InputTask>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    for (const dependency of [...tasks.get(id)!.dependsOn].sort()) {
      if (state.get(dependency) === 1) return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (state.get(dependency) !== 2) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of [...tasks.keys()].sort()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
}

function plan(tasks: InputTask[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(byId);
  if (cycle) fail(`cycle detected: ${cycle.join(" -> ")}`);

  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  for (const list of dependents.values()) list.sort();

  const ready = [...tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id)].sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of dependents.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  const earliest: Plan["earliest"] = {};
  const paths: Record<string, string[]> = {};
  const taskLayers: Record<string, number> = {};
  const layers: string[][] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    const starts = task.dependsOn.map((dependency) => earliest[dependency].finish);
    const start = starts.length ? Math.max(...starts) : 0;
    earliest[id] = { start, finish: start + task.duration };
    const layer = task.dependsOn.length
      ? Math.max(...task.dependsOn.map((dependency) => taskLayers[dependency])) + 1
      : 0;
    const candidatePaths = task.dependsOn.map((dependency) => paths[dependency]);
    const bestPrefix = candidatePaths.length === 0 ? [] : candidatePaths
      .filter((path) => earliest[path[path.length - 1]].finish === start)
      .sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")))[0];
    paths[id] = [...bestPrefix, id];
    taskLayers[id] = layer;
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();
  const totalDuration = order.length ? Math.max(...order.map((id) => earliest[id].finish)) : 0;
  const criticalPath = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => paths[id])
    .sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")))[0] ?? [];
  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const [, , command, input, ...extra] = Bun.argv;
  if (command !== "plan" || !input || extra.length !== 0) {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(input).text());
  } catch (error) {
    fail(`invalid JSON or unreadable input: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(validate(parsed))));
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
