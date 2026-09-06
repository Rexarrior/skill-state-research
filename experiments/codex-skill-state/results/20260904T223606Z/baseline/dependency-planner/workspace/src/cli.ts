#!/usr/bin/env bun

import { readFileSync } from "node:fs";

export type Task = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the input document and return a normalized task list. */
export function parseTasks(value: unknown): Task[] {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    fail("schema error: expected an object with a tasks array");
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`schema error: ${location} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`schema error: ${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`schema error: duplicate task id ${JSON.stringify(raw.id)}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`schema error: ${location}.duration must be a finite non-negative number`);
    }

    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => typeof dependency !== "string")) {
      fail(`schema error: ${location}.dependsOn must be an array of strings`);
    }
    const dependencies = dependsOn as string[];
    if (new Set(dependencies).size !== dependencies.length) {
      fail(`schema error: ${location}.dependsOn must not contain duplicates`);
    }
    if (dependencies.includes(raw.id)) {
      fail(`schema error: ${location}.dependsOn cannot contain its own id`);
    }
    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: [...dependencies] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`schema error: task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`);
      }
    }
  }
  return tasks;
}

function lexicalCompare(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

/** Return a deterministic cycle, traversing task -> dependency edges. */
export function findCycle(tasks: Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    path.push(id);
    for (const dependency of [...byId.get(id)!.dependsOn].sort()) {
      if (state.get(dependency) === 1) {
        return [...path.slice(path.indexOf(dependency)), dependency];
      }
      if (state.get(dependency) !== 2) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    path.pop();
    state.set(id, 2);
    return undefined;
  };

  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!state.has(task.id)) {
      const cycle = visit(task.id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  for (const list of dependents.values()) list.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
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
  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle?.join(" -> ") ?? "unknown cycle"}`);
  }

  const earliest: Plan["earliest"] = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let predecessorPath: string[] = [];
    for (const dependency of task.dependsOn) {
      const timing = earliest[dependency];
      start = Math.max(start, timing.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const candidate = pathById.get(dependency)!;
      if (timing.finish > (predecessorPath.length ? earliest[predecessorPath.at(-1)!].finish : -Infinity) ||
          (timing.finish === (predecessorPath.length ? earliest[predecessorPath.at(-1)!].finish : -Infinity) && lexicalCompare(candidate, predecessorPath) < 0)) {
        predecessorPath = candidate;
      }
    }
    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    pathById.set(id, [...predecessorPath, id]);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || finish > totalDuration || (finish === totalDuration && lexicalCompare(candidate, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = candidate;
    }
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(args[1], "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read or parse input: ${detail}`);
  }
  console.log(JSON.stringify(createPlan(parseTasks(input))));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`);
    process.exitCode = 1;
  }
}
