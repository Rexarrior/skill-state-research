import { describe, expect, test } from "bun:test"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { asSchema, jsonSchema, tool, type Tool, type ToolExecutionOptions } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SkillState } from "@/session/skill-state"

const options: ToolExecutionOptions = {
  toolCallId: "call_1",
  messages: [],
  abortSignal: new AbortController().signal,
}

describe("core SKILL.state protocol", () => {
  test("parses all runtime modes and rejects unknown values", () => {
    expect(SkillState.parseMode("baseline")).toBe("baseline")
    expect(SkillState.parseMode("paper")).toBe("paper")
    expect(SkillState.parseMode("v2")).toBe("v2")
    expect(SkillState.parseMode("v3")).toBe("v3")
    expect(() => SkillState.parseMode("unknown")).toThrow("expected baseline, paper, v2, or v3")
  })

  test("builds a single bounded model message from specification, state, and a recent observation window", () => {
    const value = SkillState.context(
      [
        message("user", [text("Implement every requirement below."), text("Requirement A\nRequirement B")]),
        message("assistant", [
          completedStep(
            1,
            { ...SkillState.initialState, completed: ["Requirement A"] },
            "wrote a.ts",
            { name: "write", input: { path: "a.ts" } },
            "Create requirement A.",
          ),
        ]),
        message("assistant", [
          completedStep(
            2,
            { ...SkillState.initialState, completed: ["A", "B"] },
            "tests passed",
            { name: "bash", input: { command: "bun test" } },
            "Verify both requirements.",
          ),
        ]),
      ],
      1,
    )

    expect(value.revision).toBe(2)
    expect(value.state.completed).toEqual(["A", "B"])
    expect(value.observations).toEqual([
      {
        revision: 2,
        action: { name: "bash", input: { command: "bun test" } },
        comment: "Verify both requirements.",
        status: "completed",
        result: "tests passed",
      },
    ])
    expect(value.specification).toContain("Requirement A")

    const prompt = SkillState.modelMessages(value)
    expect(prompt).toHaveLength(1)
    expect(prompt[0]?.role).toBe("user")
    expect(String(prompt[0]?.content)).toContain("Instructions:\nImplement every requirement below.")
    expect(String(prompt[0]?.content)).toContain("Skill Execution State:")
    expect(String(prompt[0]?.content)).toContain("Recent Observations (oldest to newest, maximum 1):")
    expect(String(prompt[0]?.content)).toContain('"command":"bun test"')
    expect(String(prompt[0]?.content)).toContain('"result":"tests passed"')
    expect(String(prompt[0]?.content)).not.toContain("wrote a.ts")
  })

  test("keeps the configured number of observations and identifies empty successful actions", () => {
    const value = SkillState.context(
      [
        message("user", [text("Implement")]),
        message("assistant", [
          completedStep(1, SkillState.initialState, "first", { name: "read", input: { filePath: "a.ts" } }),
        ]),
        message("assistant", [
          completedStep(
            2,
            SkillState.initialState,
            "",
            { name: "bash", input: { command: "python3 -m py_compile main.py" } },
            "Check syntax before smoke tests.",
          ),
        ]),
      ],
      1,
    )

    expect(value.observations).toEqual([
      {
        revision: 2,
        action: { name: "bash", input: { command: "python3 -m py_compile main.py" } },
        comment: "Check syntax before smoke tests.",
        status: "completed",
        result: "Action completed successfully without textual output.",
      },
    ])
  })

  test("keeps protocol errors visible without advancing the valid state", () => {
    const state = { ...SkillState.initialState, completed: ["created source"] }
    const value = SkillState.context(
      [
        message("user", [text("Implement")]),
        message("assistant", [completedStep(1, state, "created", { name: "write", input: { path: "main.py" } })]),
        message("assistant", [
          erroredStep(
            {
              state_patch: {},
              comment: "Compile the implementation.",
              action: { name: "bash", input: { command: "python3 -m py_compile main.py" } },
            },
            "Protocol error: expected exactly one skill_step transition",
          ),
        ]),
      ],
      2,
    )

    expect(value.revision).toBe(1)
    expect(value.state.completed).toEqual(["created source"])
    expect(value.observations.at(-1)).toEqual({
      revision: null,
      action: { name: "bash", input: { command: "python3 -m py_compile main.py" } },
      comment: "Compile the implementation.",
      status: "protocol_error",
      result: "Protocol error: expected exactly one skill_step transition",
    })
  })

  test("bounds large action inputs and results deterministically", () => {
    const value = SkillState.context([
      message("user", [text("Implement")]),
      message("assistant", [
        completedStep(1, SkillState.initialState, "o".repeat(5_000), {
          name: "apply_patch",
          input: { patchText: "p".repeat(5_000) },
        }),
      ]),
    ])
    const current = value.observations[0]

    expect(current.action?.input).toMatchObject({ truncated: true, originalBytes: 5_016 })
    expect(JSON.stringify(current.action?.input)).toContain('"sha256"')
    expect(Buffer.byteLength(current.result)).toBeLessThanOrEqual(4 * 1024)
    expect(current.result).toContain("[truncated; original bytes: 5000]")
  })

  test("applies the state patch before dispatching exactly one action", async () => {
    let calls = 0
    const action = tool({
      inputSchema: jsonSchema({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      }),
      execute(input) {
        if (!isPathInput(input)) throw new Error("expected path input")
        calls++
        return { title: "Wrote file", output: `wrote ${input.path}`, metadata: { changed: true } }
      },
    })
    const schemaTool = await Effect.runPromise(SkillState.createTool({ tools: { write: action } }))
    expect(schemaTool.execute).toBeUndefined()

    const transition = SkillState.prepare(
      {
        state_patch: {
          completed: ["created source"],
          files: { "src/index.ts": "implements the entry point" },
          next_action: "Run tests",
        },
        comment: "Create the source entry point.",
        action: { name: "write", input: { path: "src/index.ts" } },
      },
      SkillState.initialState,
      0,
    )
    expect(SkillState.metadata(transition, "pending")).toMatchObject({
      skillState: {
        protocolVersion: 2,
        revision: 1,
        action: { name: "write", input: { path: "src/index.ts" } },
        comment: "Create the source entry point.",
        actionStatus: "pending",
      },
    })

    const result = await SkillState.execute(transition, { write: action }, options)

    expect(calls).toBe(1)
    expect(result).toMatchObject({ title: "Wrote file", output: "wrote src/index.ts" })
    const restored = SkillState.context([
      message("user", [text("Implement the project")]),
      message("assistant", [stepFromResult(result)]),
    ])
    expect(restored.revision).toBe(1)
    expect(restored.state.completed).toEqual(["created source"])
    expect(restored.state.files).toEqual({ "src/index.ts": "implements the entry point" })
    expect(restored.observations.at(-1)).toMatchObject({
      action: { name: "write", input: { path: "src/index.ts" } },
      comment: "Create the source entry point.",
      status: "completed",
      result: "wrote src/index.ts",
    })
  })

  test("returns failed actions as structured observations", async () => {
    const action: Tool<{ command: string }, string> = {
      inputSchema: jsonSchema<{ command: string }>({
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      }),
      execute(input) {
        if (!isCommandInput(input)) throw new Error("expected command input")
        throw new Error("compile failed")
      },
    }
    const transition = SkillState.prepare(
      {
        state_patch: { next_action: "Fix the compile error" },
        comment: "Check whether the source compiles.",
        action: { name: "bash", input: { command: "python3 -m py_compile main.py" } },
      },
      SkillState.initialState,
      0,
    )
    const result = await SkillState.execute(transition, { bash: action }, options)
    const restored = SkillState.context([
      message("user", [text("Implement")]),
      message("assistant", [stepFromResult(result)]),
    ])

    expect(restored.observations[0]).toMatchObject({
      action: { name: "bash", input: { command: "python3 -m py_compile main.py" } },
      comment: "Check whether the source compiles.",
      status: "error",
      result: "compile failed",
    })
  })

  test("v3 exposes an unbounded action array and executes it sequentially with fail-fast", async () => {
    const order: string[] = []
    const action = (name: string, fails = false) =>
      tool({
        inputSchema: jsonSchema({
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        }),
        execute(input) {
          if (!isRecordWithString(input, "value")) throw new Error("expected value input")
          order.push(name)
          if (fails) throw new Error(`${name} failed`)
          return { title: name, output: `${name}:${input.value}`, metadata: {} }
        },
      })
    const tools = {
      first: action("first"),
      second: action("second", true),
      third: action("third"),
    }
    const wrapper = await Effect.runPromise(SkillState.createTool({ tools, mode: "v3" }))
    const schema = await Promise.resolve(asSchema(wrapper.inputSchema).jsonSchema)
    expect(schema.required).toEqual(["state_revision", "state_patch", "actions"])
    expect(schema.properties?.actions).toMatchObject({ type: "array", minItems: 1 })
    expect(schema.properties?.actions).not.toHaveProperty("maxItems")
    expect((schema.properties?.state_patch as JSONSchema7).properties?.next_action).toEqual({ type: "string" })
    expect(String(wrapper.description)).toContain("strictly sequentially")

    const transition = SkillState.prepare(
      {
        state_revision: 0,
        state_patch: { next_action: "Inspect the failed batch" },
        comment: "Run all independent checks in order.",
        actions: [
          { name: "first", input: { value: "a" } },
          { name: "second", input: { value: "b" } },
          { name: "third", input: { value: "c" } },
        ],
      },
      SkillState.initialState,
      0,
      "v3",
    )
    const result = await SkillState.execute(transition, tools, options)
    expect(order).toEqual(["first", "second"])

    const restored = SkillState.context(
      [message("user", [text("Implement")]), message("assistant", [stepFromResult(result)])],
      3,
      "v3",
    )
    expect(restored.revision).toBe(1)
    expect(restored.observations).toHaveLength(1)
    expect(restored.observations[0]).toMatchObject({
      revision: 1,
      comment: "Run all independent checks in order.",
      status: "error",
      actions: [
        { name: "first", status: "completed", result: "first:a" },
        { name: "second", status: "error", result: "second failed" },
        {
          name: "third",
          status: "skipped",
          result: "Skipped because an earlier action in this batch failed.",
        },
      ],
    })
    const prompt = String(SkillState.modelMessages(restored)[0]?.content)
    expect(prompt).toContain("strictly sequentially in the listed order")
    expect(prompt).toContain("There is no protocol limit on the number of actions")
    expect(prompt).toContain("Copy the currently shown state_revision exactly")
    expect(prompt).toContain("Recent Batch Observations")
  })

  test("v3 rejects stale revisions, empty arrays, and finish mixed with other actions", () => {
    expect(() =>
      SkillState.prepare(
        { state_revision: 4, state_patch: {}, actions: [{ name: "action", input: {} }] },
        SkillState.initialState,
        3,
        "v3",
      ),
    ).toThrow("stale state_revision 4; expected 3")
    expect(() =>
      SkillState.prepare({ state_revision: 0, state_patch: {}, actions: [] }, SkillState.initialState, 0, "v3"),
    ).toThrow("non-empty array")
    expect(() =>
      SkillState.prepare(
        {
          state_revision: 0,
          state_patch: {},
          actions: [
            { name: "action", input: {} },
            { name: "finish", input: { message: "done" } },
          ],
        },
        SkillState.initialState,
        0,
        "v3",
      ),
    ).toThrow("finish must be the sole action")
  })

  test("rejects removed verification state and invalid comments", () => {
    expect(() =>
      SkillState.prepare(
        { state_patch: { verification: ["tests passed"] }, action: { name: "action", input: {} } },
        SkillState.initialState,
        0,
      ),
    ).toThrow("Invalid resulting execution state")

    expect(() =>
      SkillState.prepare(
        { state_patch: {}, comment: "   ", action: { name: "action", input: {} } },
        SkillState.initialState,
        0,
      ),
    ).toThrow("skill_step.comment must be a non-empty string")
  })

  test("rejects an invalid resulting state before action execution", () => {
    expect(() =>
      SkillState.prepare(
        { state_patch: { next_action: null }, action: { name: "action", input: {} } },
        SkillState.initialState,
        0,
      ),
    ).toThrow("Invalid resulting execution state")
  })

  test("rejects prototype-polluting patches", () => {
    const patch = JSON.parse('{"files":{"__proto__":{"polluted":true}}}')

    expect(() =>
      SkillState.prepare({ state_patch: patch, action: { name: "action", input: {} } }, SkillState.initialState, 0),
    ).toThrow("forbidden key")
  })

  test("uses finish as an in-band terminal action", async () => {
    const transition = SkillState.prepare(
      {
        state_patch: { status: "done", next_action: "None" },
        action: { name: "finish", input: { message: "Everything is implemented and verified." } },
      },
      SkillState.initialState,
      4,
    )
    const result = await SkillState.execute(transition, {}, options)
    const part = stepFromResult(result)

    expect(SkillState.finish([part])).toBe("Everything is implemented and verified.")
    const restored = SkillState.context([message("user", [text("Implement")]), message("assistant", [part])])
    expect(restored.revision).toBe(5)
    expect(restored.state.status).toBe("done")
  })

  test("paper mode exposes only P, Sigma, and the latest result", async () => {
    const action = tool({
      inputSchema: jsonSchema({
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      }),
      execute() {
        return { title: "Probe", output: "latest-result", metadata: {} }
      },
    })
    const wrapper = await Effect.runPromise(SkillState.createTool({ tools: { bash: action }, mode: "paper" }))
    const schema = await Promise.resolve(asSchema(wrapper.inputSchema).jsonSchema)
    expect(schema.required).toEqual(["state_patch", "action"])
    expect(schema.properties).not.toHaveProperty("comment")

    const transition = SkillState.prepare(
      {
        state_patch: { facts: ["durable fact"], next_action: "Finish" },
        action: { name: "bash", input: { command: "paper-command" } },
      },
      SkillState.initialState,
      0,
      "paper",
    )
    const result = await SkillState.execute(transition, { bash: action }, options)
    expect(SkillState.metadata(transition, "pending")).toMatchObject({
      skillState: { protocolVersion: 1 },
    })
    const value = SkillState.context(
      [message("user", [text("Implement from P")]), message("assistant", [stepFromResult(result)])],
      8,
      "paper",
    )
    const prompt = String(SkillState.modelMessages(value)[0]?.content)
    expect(prompt).toContain("Instructions:\nImplement from P")
    expect(prompt).toContain('"facts":["durable fact"]')
    expect(prompt).toContain("Latest Observation:\nlatest-result")
    expect(prompt).not.toContain("paper-command")
    expect(prompt).not.toContain("Recent Observations")
    expect(prompt).not.toContain("state_revision")
    expect(prompt).not.toContain("comment")
  })

  test("paper mode supports nested null deletion and rejects v2 envelope fields", () => {
    const transition = SkillState.prepare(
      {
        state_patch: { files: { "remove.ts": null } },
        action: { name: "bash", input: { command: "pwd" } },
      },
      { ...SkillState.initialState, files: { "keep.ts": "keep", "remove.ts": "remove" } },
      0,
      "paper",
    )
    expect(transition.state.files).toEqual({ "keep.ts": "keep" })
    expect(() =>
      SkillState.prepare(
        {
          state_revision: 0,
          state_patch: {},
          action: { name: "bash", input: { command: "pwd" } },
        },
        SkillState.initialState,
        0,
        "paper",
      ),
    ).toThrow("exactly state_patch and action")
  })

  test("paper mode discards older observations even when the configured v2 window is larger", () => {
    const value = SkillState.context(
      [
        message("user", [text("Implement")]),
        message("assistant", [
          completedStep(1, SkillState.initialState, "older-result", { name: "bash", input: {} }, undefined, 1),
        ]),
        message("assistant", [
          completedStep(2, SkillState.initialState, "latest-result", { name: "bash", input: {} }, undefined, 1),
        ]),
      ],
      8,
      "paper",
    )
    const prompt = String(SkillState.modelMessages(value)[0]?.content)
    expect(prompt).toContain("Latest Observation:\nlatest-result")
    expect(prompt).not.toContain("older-result")
  })
})

function message(role: "user" | "assistant", parts: SessionV1.Part[]) {
  return { info: { role }, parts } as SessionV1.WithParts
}

function text(value: string) {
  return { type: "text", text: value } as SessionV1.TextPart
}

function completedStep(
  revision: number,
  state: SkillState.State,
  output: string,
  action: { name: string; input: Record<string, unknown> },
  comment?: string,
  protocolVersion: 1 | 2 = 2,
) {
  return {
    type: "tool",
    tool: "skill_step",
    state: {
      status: "completed",
      input: {},
      output,
      title: "Action",
      time: { start: 1, end: 2 },
      metadata: {
        skillState: {
          protocolVersion,
          revision,
          state,
          patch: {},
          action,
          ...(comment ? { comment } : {}),
          stateBytes: JSON.stringify(state).length,
          actionStatus: "completed",
        },
      },
    },
  } as unknown as SessionV1.ToolPart
}

function erroredStep(input: Record<string, unknown>, error: string) {
  return {
    type: "tool",
    tool: "skill_step",
    state: {
      status: "error",
      input,
      error,
      time: { start: 1, end: 2 },
    },
  } as unknown as SessionV1.ToolPart
}

function stepFromResult(result: unknown) {
  if (!isResult(result)) throw new Error("expected a structured tool result")
  return {
    type: "tool",
    tool: "skill_step",
    state: {
      status: "completed",
      input: {},
      output: result.output,
      title: result.title,
      time: { start: 1, end: 2 },
      metadata: result.metadata,
    },
  } as unknown as SessionV1.ToolPart
}

function isPathInput(value: unknown): value is { path: string } {
  return typeof value === "object" && value !== null && "path" in value && typeof value.path === "string"
}

function isCommandInput(value: unknown): value is { command: string } {
  return typeof value === "object" && value !== null && "command" in value && typeof value.command === "string"
}

function isRecordWithString(value: unknown, key: string): value is Record<string, string> {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[key] === "string"
}

function isResult(value: unknown): value is {
  title: string
  output: string
  metadata: Record<string, unknown>
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "title" in value &&
    typeof value.title === "string" &&
    "output" in value &&
    typeof value.output === "string" &&
    "metadata" in value &&
    typeof value.metadata === "object" &&
    value.metadata !== null
  )
}
