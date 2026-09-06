import { readFileSync } from "node:fs";

type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

export function validateInput(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("Input must be an object with a tasks array.");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    fail("tasks must be an array.");
  }

  const ids = new Set<string>();
  const tasks: Task[] = tasksValue.map((value, index) => {
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`${label} must be an object.`);
    }

    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string.`);
    }
    if (ids.has(raw.id)) {
      fail(`Duplicate task id: ${raw.id}.`);
    }
    ids.add(raw.id);

    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number.`);
    }

    const dependsValue = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsValue) || dependsValue.some((dependency) => typeof dependency !== "string")) {
      fail(`${label}.dependsOn must be an array of strings.`);
    }
    const dependsOn = dependsValue as string[];
    if (new Set(dependsOn).size !== dependsOn.length) {
      fail(`${label}.dependsOn must not contain duplicate ids.`);
    }
    if (dependsOn.includes(raw.id)) {
      fail(`${label}.dependsOn cannot contain its own id.`);
    }

    return { id: raw.id, duration: raw.duration, dependsOn };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`Task ${task.id} depends on unknown task: ${dependency}.`);
      }
    }
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] | undefined {
  const states = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    states.set(id, "visiting");
    stack.push(id);
    const task = tasksById.get(id)!;

    for (const dependency of [...task.dependsOn].sort()) {
      if (states.get(dependency) === "visiting") {
        return [...stack.slice(stack.indexOf(dependency)), dependency];
      }
      if (!states.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    states.set(id, "done");
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort()) {
    if (!states.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

function compareSequences(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

export function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasksById);
  if (cycle) {
    fail(`Dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!.sort()) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  const earliest: Plan["earliest"] = {};
  const paths = new Map<string, string[]>();
  const layers: string[][] = [];
  for (const id of order) {
    const task = tasksById.get(id)!;
    const dependencyFinishes = task.dependsOn.map((dependency) => earliest[dependency].finish);
    const start = dependencyFinishes.length === 0 ? 0 : Math.max(...dependencyFinishes);
    earliest[id] = { start, finish: start + task.duration };

    const layer = task.dependsOn.length === 0
      ? 0
      : Math.max(...task.dependsOn.map((dependency) => {
        for (let index = 0; index < layers.length; index += 1) {
          if (layers[index].includes(dependency)) return index;
        }
        return -1;
      })) + 1;
    (layers[layer] ??= []).push(id);

    const criticalDependencies = task.dependsOn.filter(
      (dependency) => earliest[dependency].finish === start,
    );
    const prefix = criticalDependencies.length === 0
      ? []
      : criticalDependencies.map((dependency) => paths.get(dependency)!).sort(compareSequences)[0];
    paths.set(id, [...prefix, id]);
  }

  for (const layer of layers) layer.sort();
  const totalDuration = order.length === 0 ? 0 : Math.max(...order.map((id) => earliest[id].finish));
  const criticalPath = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => paths.get(id)!)
    .sort(compareSequences)[0] ?? [];

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function run(args: string[]): Plan {
  if (args.length !== 2 || args[0] !== "plan") {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(args[1], "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read or parse ${args[1]}: ${detail}`);
  }
  return createPlan(validateInput(input));
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(run(Bun.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
