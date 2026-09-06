#!/usr/bin/env bun

type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Input = { tasks: Task[] };

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

function validate(value: unknown): Input {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("Input must be an object with a tasks array.");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.tasks)) fail("tasks must be an array.");

  const ids = new Set<string>();
  const tasks: Task[] = candidate.tasks.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`tasks[${index}] must be an object.`);
    }
    const task = raw as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      fail(`tasks[${index}].id must be a non-empty string.`);
    }
    if (ids.has(task.id)) fail(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      fail(`tasks[${index}].duration must be a finite non-negative number.`);
    }
    const dependsOn = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      fail(`tasks[${index}].dependsOn must be an array of strings.`);
    }
    const dependencies = dependsOn as string[];
    if (new Set(dependencies).size !== dependencies.length) {
      fail(`tasks[${index}].dependsOn must contain unique ids.`);
    }
    if (dependencies.includes(task.id)) fail(`Task ${task.id} cannot depend on itself.`);
    return { id: task.id, duration: task.duration, dependsOn: dependencies };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`Task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  return { tasks };
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
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
    return undefined;
  };
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (state.get(task.id) === undefined) {
      const cycle = visit(task.id);
      if (cycle) return cycle;
    }
  }
}

function plan(input: Input): Plan {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const dependents = new Map(input.tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map<string, number>();
  for (const task of input.tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort();

  const ready = input.tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== input.tasks.length) {
    const cycle = findCycle(input.tasks, byId);
    fail(`Cycle detected: ${(cycle ?? []).join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Plan["earliest"] = {};
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    const dependencyLayers = task.dependsOn.map((dependency) => layerById.get(dependency)!);
    const layer = dependencyLayers.length === 0 ? 0 : Math.max(...dependencyLayers) + 1;
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    let start = 0;
    let predecessorPath: string[] | undefined;
    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const candidatePath = pathById.get(dependency)!;
      if (predecessorPath === undefined || finish > start || (finish === start && comparePaths(candidatePath, predecessorPath) < 0)) {
        start = finish;
        predecessorPath = candidatePath;
      }
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    const taskPath = [...(predecessorPath ?? []), id];
    pathById.set(id, taskPath);
    if (criticalPath.length === 0 || finish > totalDuration || (finish === totalDuration && comparePaths(taskPath, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = taskPath;
    }
  }
  for (const layer of layers) layer.sort();
  return { order, layers, earliest, totalDuration, criticalPath };
}

function comparePaths(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function selfTest(): void {
  const result = plan(validate({ tasks: [
    { id: "build", duration: 3, dependsOn: ["lint"] },
    { id: "lint", duration: 2 },
    { id: "test", duration: 3, dependsOn: ["lint"] },
    { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
  ] }));
  const expected = { order: ["lint", "build", "test", "deploy"], layers: [["lint"], ["build", "test"], ["deploy"]], totalDuration: 6, criticalPath: ["lint", "build", "deploy"] };
  if (JSON.stringify({ order: result.order, layers: result.layers, totalDuration: result.totalDuration, criticalPath: result.criticalPath }) !== JSON.stringify(expected)) {
    fail("Self-test failed: unexpected plan output.");
  }
  try { plan(validate({ tasks: [{ id: "a", duration: 0, dependsOn: ["b"] }, { id: "b", duration: 0, dependsOn: ["a"] }] })); } catch (error) {
    if (error instanceof Error && error.message === "Cycle detected: a -> b -> a") return;
  }
  fail("Self-test failed: cycle was not detected deterministically.");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && args[0] === "self-test") return selfTest();
  if (args.length !== 2 || args[0] !== "plan") fail("Usage: bun run src/cli.ts plan INPUT.json");
  if (args[1].startsWith("-")) fail(`Unknown flag: ${args[1]}`);
  let text: string;
  try { text = await Bun.file(args[1]).text(); } catch { fail(`Unable to read input file: ${args[1]}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("Invalid JSON input."); }
  console.log(JSON.stringify(plan(validate(parsed))));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
