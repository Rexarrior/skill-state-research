import type { JSONSchema7 } from "@ai-sdk/provider"
import { createHash } from "node:crypto"
import { Cause, Effect, Exit, Schema } from "effect"
import { asSchema, jsonSchema, tool, type ModelMessage, type Tool, type ToolExecutionOptions } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"

const TOOL_ID = "skill_step"
const METADATA_KEY = "skillState"
const MAX_STATE_BYTES = 32 * 1024
const DEFAULT_OBSERVATION_WINDOW = 3
const MAX_OBSERVATION_WINDOW = 8
const MAX_COMMENT_BYTES = 1024
const MAX_ACTION_INPUT_BYTES = 3 * 1024
const MAX_RESULT_BYTES = 4 * 1024

const CodingState = Schema.Struct({
  status: Schema.Literals(["working", "blocked", "done"]),
  plan: Schema.Array(Schema.String),
  completed: Schema.Array(Schema.String),
  files: Schema.Record(Schema.String, Schema.String),
  facts: Schema.Array(Schema.String),
  decisions: Schema.Array(Schema.String),
  next_action: Schema.String,
})

export type State = typeof CodingState.Type
export type Mode = "paper" | "v2" | "v3"
export type RuntimeMode = "baseline" | Mode

export const initialState: State = {
  status: "working",
  plan: [],
  completed: [],
  files: {},
  facts: [],
  decisions: [],
  next_action: "Inspect the task specification and workspace, then perform the first implementation action.",
}

type RequestedAction = {
  name: string
  input: Record<string, unknown>
}

type BatchActionResult = RequestedAction & {
  status: "completed" | "error" | "skipped"
  result: string
}

type TransitionMetadata = {
  protocolVersion: 1 | 2 | 3
  revision: number
  state: State
  patch: Record<string, unknown>
  action?: RequestedAction
  actions?: RequestedAction[]
  actionResults?: BatchActionResult[]
  comment?: string
  stateBytes: number
  actionStatus: "pending" | "completed" | "error" | "finish"
  finalMessage?: string
}

type Context = {
  mode: Mode
  specification: string
  state: State
  revision: number
  observations: Observation[]
  observationWindow: number
}

export type Observation = {
  revision: number | null
  action?: { name: string; input: unknown } | null
  actions?: Array<{ name: string; input: unknown; status: BatchActionResult["status"]; result: string }>
  comment?: string
  status: "initial" | "completed" | "error" | "interrupted" | "finish" | "protocol_error"
  result: string
}

export type Transition = {
  mode: Mode
  revision: number
  patch: Record<string, unknown>
  state: State
  action?: RequestedAction
  actions?: RequestedAction[]
  comment?: string
}

type ActionResult = {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: unknown[]
  actionError: boolean
}

const statePatchSchema: JSONSchema7 = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["working", "blocked", "done"] },
    plan: { type: "array", items: { type: "string" } },
    completed: { type: "array", items: { type: "string" } },
    files: {
      type: "object",
      additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    facts: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    next_action: { type: "string" },
  },
  additionalProperties: false,
}

const paperStatePatchSchema: JSONSchema7 = {
  type: "object",
  properties: Object.fromEntries(
    Object.entries(statePatchSchema.properties ?? {}).map(([name, schema]) => [
      name,
      { anyOf: [schema, { type: "null" }] },
    ]),
  ),
  additionalProperties: false,
}

const v2Protocol = `You are operating under the SKILL.state v2 execution protocol.

The task specification below is immutable and is included on every turn. The execution state is your only durable memory of progress. A bounded window of recent structured observations is retained; all previous reasoning, assistant text, and older observations are intentionally discarded.

On every turn you MUST call skill_step exactly once. Its state_patch and action form one atomic transition. The state_patch may preserve durable conclusions from observations you have already received, then the action chooses exactly one new environment operation. The optional comment explains why you are taking that action and what evidence it should produce; it must not claim the new action has already succeeded.

Do not repeat an action when a recent observation already reports that the same action and input completed successfully. If information must survive after its observation leaves the window, preserve only a compact durable conclusion in completed, files, facts, or decisions. Never copy raw observation text into state when a compact fact is sufficient. Do not claim a file change or successful check until the environment has confirmed it.

Use the finish action only after the implementation is complete and all available tests pass. Do not answer outside skill_step.`

const v3Protocol = `You are operating under the SKILL.state v3 batched execution protocol.

The task specification below is immutable and is included on every turn. The execution state is your only durable memory of progress. A bounded window of recent structured batch observations is retained; all previous reasoning, assistant text, and older observations are intentionally discarded.

On every turn you MUST call skill_step exactly once. Copy the currently shown state_revision exactly; do not increment or predict it. Supply a minimal state_patch, an optional comment, and a non-empty actions array. There is no protocol limit on the number of actions in the array. The state_patch is applied once before any action starts.

Actions are executed strictly sequentially in the listed order. Action i+1 starts only after action i has completed. If an action fails, the runtime stops the batch and marks every remaining action as skipped. You do not see any result until the whole batch has stopped. Batch only actions whose inputs are already known; when a later action depends on an unseen result from an earlier action, end the batch and choose it on the next turn.

The optional comment explains the purpose of the whole batch and must not claim that its actions have already succeeded. Do not repeat an action when a recent batch observation already reports that the same action and input completed successfully. If information must survive after its batch leaves the window, preserve only a compact durable conclusion in completed, files, facts, or decisions. Never copy raw observation text into state. Do not claim a file change or successful check until the environment has confirmed it.

Use finish only after the implementation is complete and all available tests pass. finish must be the sole action in its batch. Do not answer outside skill_step.`

const paperProtocol = `You are operating under the original SKILL.state execution protocol from the paper.

The task specification below is immutable. The execution state is the only durable memory. Every earlier observation, action, response, and reasoning trace is discarded; only the latest environment observation is available.

On every turn call skill_step exactly once with exactly two fields: state_patch and action. Use state_patch to retain only information required by future execution, using null to delete obsolete dictionary entries. Then choose exactly one environment action. The runtime validates and applies the patch before it executes the action.

Use the finish action only after the implementation is complete and all available tests pass. Do not answer outside skill_step.`

export function parseMode(value: string): RuntimeMode {
  if (value === "baseline" || value === "paper" || value === "v2" || value === "v3") return value
  throw new Error(`Invalid SKILL.state mode: ${value}; expected baseline, paper, v2, or v3`)
}

export function context(
  messages: SessionV1.WithParts[],
  requestedWindow = DEFAULT_OBSERVATION_WINDOW,
  mode: Mode = "v2",
): Context {
  const firstUser = messages.find((message) => message.info.role === "user")
  if (!firstUser) throw new Error("SKILL.state requires an initial user message")

  const specification = firstUser.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored && part.text.length > 0)
    .map((part) => part.text)
    .join("\n\n")
  if (!specification) throw new Error("SKILL.state requires a textual task specification")

  const parts = messages
    .flatMap((message) => message.parts)
    .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === TOOL_ID)
  const version = protocolVersion(mode)
  const transition = parts
    .flatMap((part) => {
      if (part.state.status !== "completed") return []
      const value = transitionMetadata(part)
      return isTransitionMetadata(value) && value.protocolVersion === version ? [value] : []
    })
    .sort((a, b) => a.revision - b.revision)
    .at(-1)
  const incompatible = parts.some((part) => {
    const value = transitionMetadata(part)
    return isTransitionMetadata(value) && value.protocolVersion !== version
  })
  if (incompatible) {
    throw new Error(`This SKILL.state session cannot be resumed in ${mode} mode because it uses another protocol`)
  }
  const observationWindow = Math.min(
    Math.max(Math.trunc(requestedWindow) || DEFAULT_OBSERVATION_WINDOW, 1),
    MAX_OBSERVATION_WINDOW,
  )
  const observations = parts.slice(-(mode === "paper" ? 1 : observationWindow)).map(observation)

  return {
    mode,
    specification,
    state: transition?.state ?? structuredClone(initialState),
    revision: transition?.revision ?? 0,
    observations: observations.length ? observations : [initialObservation],
    observationWindow,
  }
}

export function modelMessages(value: Context): ModelMessage[] {
  if (value.mode === "paper") {
    return [
      {
        role: "user",
        content: `${paperProtocol}\n\nInstructions:\n${value.specification}\n\nSkill Execution State:\n${JSON.stringify(value.state)}\n\nLatest Observation:\n${value.observations.at(-1)?.result ?? initialObservation.result}`,
      },
    ]
  }
  const protocol = value.mode === "v3" ? v3Protocol : v2Protocol
  const stateHeading =
    value.mode === "v3" ? `Skill Execution State (revision ${value.revision}):` : "Skill Execution State:"
  return [
    {
      role: "user",
      content: `${protocol}\n\nInstructions:\n${value.specification}\n\n${stateHeading}\n${JSON.stringify(value.state)}\n\nRecent ${value.mode === "v3" ? "Batch " : ""}Observations (oldest to newest, maximum ${value.observationWindow}):\n${JSON.stringify(value.observations)}`,
    },
  ]
}

export const createTool = Effect.fn("SkillState.createTool")(function* (input: {
  tools: Record<string, Tool>
  mode?: Mode
}) {
  const actions = yield* Effect.forEach(
    Object.entries(input.tools).filter(([name, item]) => name !== "invalid" && item.execute),
    ([name, item]) =>
      Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema)).pipe(
        Effect.map((schema) => ({ name, schema })),
      ),
    { concurrency: "unbounded" },
  )
  const actionSchema: JSONSchema7 = {
    oneOf: [
      ...actions.map(
        (entry): JSONSchema7 => ({
          type: "object",
          properties: {
            name: { const: entry.name },
            input: entry.schema,
          },
          required: ["name", "input"],
          additionalProperties: false,
        }),
      ),
      {
        type: "object",
        properties: {
          name: { const: "finish" },
          input: {
            type: "object",
            properties: { message: { type: "string", minLength: 1 } },
            required: ["message"],
            additionalProperties: false,
          },
        },
        required: ["name", "input"],
        additionalProperties: false,
      },
    ],
  }
  const properties: Record<string, JSONSchema7> = {
    state_patch: input.mode === "paper" ? paperStatePatchSchema : statePatchSchema,
    ...(input.mode === "v3"
      ? {
          state_revision: {
            type: "integer",
            minimum: 0,
            description: "Revision shown in the current Skill Execution State.",
          } satisfies JSONSchema7,
          actions: {
            type: "array",
            minItems: 1,
            items: actionSchema,
            description: "Actions executed strictly sequentially in the listed order.",
          } satisfies JSONSchema7,
        }
      : { action: actionSchema }),
  }
  if (input.mode !== "paper") {
    properties.comment = {
      type: "string",
      minLength: 1,
      maxLength: MAX_COMMENT_BYTES,
      description: "Optional explanation of why this action is useful and what evidence it should produce.",
    }
  }
  return tool({
    description:
      input.mode === "v3"
        ? "Submit one SKILL.state transition. The runtime applies state_patch once, then executes the non-empty actions array strictly sequentially."
        : "Submit the mandatory SKILL.state transition. The runtime validates and applies state_patch before executing exactly one action.",
    inputSchema: jsonSchema({
      type: "object",
      properties,
      required: input.mode === "v3" ? ["state_revision", "state_patch", "actions"] : ["state_patch", "action"],
      additionalProperties: false,
    }),
  })
})

export function prepare(value: unknown, state: State, revision: number, mode: Mode = "v2"): Transition {
  return prepareTransition(value, state, revision, mode)
}

export function metadata(
  transition: Transition,
  actionStatus: TransitionMetadata["actionStatus"],
  options: { finalMessage?: string; actionResults?: BatchActionResult[] } = {},
) {
  return {
    [METADATA_KEY]: {
      protocolVersion: protocolVersion(transition.mode),
      revision: transition.revision,
      state: transition.state,
      patch: transition.patch,
      ...(transition.action ? { action: structuredClone(transition.action) } : {}),
      ...(transition.actions ? { actions: structuredClone(transition.actions) } : {}),
      ...(options.actionResults ? { actionResults: structuredClone(options.actionResults) } : {}),
      ...(transition.comment ? { comment: transition.comment } : {}),
      stateBytes: Buffer.byteLength(JSON.stringify(transition.state)),
      actionStatus,
      ...(options.finalMessage ? { finalMessage: options.finalMessage } : {}),
    } satisfies TransitionMetadata,
  }
}

export async function execute(transition: Transition, tools: Record<string, Tool>, options: ToolExecutionOptions) {
  if (transition.mode === "v3") return executeBatch(transition, tools, options)
  if (!transition.action) throw new Error("single-action SKILL.state transition is missing action")
  const action = transition.action
  if (action.name === "finish") {
    const message = action.input.message
    if (typeof message !== "string" || !message.trim()) throw new Error("finish.message must be a non-empty string")
    return {
      title: "Finished",
      output: message,
      metadata: metadata(transition, "finish", { finalMessage: message }),
    }
  }

  const selected = tools[action.name]
  if (!selected?.execute) throw new Error(`Unknown or non-executable action: ${action.name}`)
  const result = await Promise.resolve()
    .then(() => selected.execute!(action.input, options))
    .then(
      resolveToolResult,
      (error): ActionResult => ({
        title: `${action.name} failed`,
        output: errorMessage(error),
        metadata: {},
        actionError: true,
      }),
    )
  return {
    title: result.title,
    output: result.output,
    metadata: { ...result.metadata, ...metadata(transition, result.actionError ? "error" : "completed") },
    ...(result.attachments ? { attachments: result.attachments } : {}),
  }
}

async function executeBatch(transition: Transition, tools: Record<string, Tool>, options: ToolExecutionOptions) {
  if (!transition.actions?.length) throw new Error("v3 SKILL.state transition is missing actions")
  const finish = transition.actions.find((action) => action.name === "finish")
  if (finish) {
    const message = finish.input.message
    if (transition.actions.length !== 1) throw new Error("finish must be the sole action in a v3 batch")
    if (typeof message !== "string" || !message.trim()) throw new Error("finish.message must be a non-empty string")
    const actionResults: BatchActionResult[] = [{ ...finish, status: "completed", result: message }]
    return {
      title: "Finished",
      output: JSON.stringify(actionResults),
      metadata: metadata(transition, "finish", { finalMessage: message, actionResults }),
    }
  }

  const unknown = transition.actions.find((action) => !tools[action.name]?.execute)
  if (unknown) throw new Error(`Unknown or non-executable action: ${unknown.name}`)

  const actionResults: BatchActionResult[] = []
  const attachments: unknown[] = []
  const toolMetadata: Record<string, unknown> = {}
  for (const [index, action] of transition.actions.entries()) {
    const selected = tools[action.name]
    if (!selected?.execute) throw new Error(`Unknown or non-executable action: ${action.name}`)
    const result = await Promise.resolve()
      .then(() =>
        selected.execute!(action.input, {
          ...options,
          toolCallId: `${options.toolCallId}:action:${index}`,
        }),
      )
      .then(
        resolveToolResult,
        (error): ActionResult => ({
          title: `${action.name} failed`,
          output: errorMessage(error),
          metadata: {},
          actionError: true,
        }),
      )
    Object.assign(toolMetadata, result.metadata)
    if (result.attachments) attachments.push(...result.attachments)
    actionResults.push({
      ...action,
      status: result.actionError ? "error" : "completed",
      result: boundedText(result.output || observationFallback(result.actionError), MAX_RESULT_BYTES),
    })
    if (result.actionError) {
      actionResults.push(
        ...transition.actions.slice(index + 1).map((skipped) => ({
          ...skipped,
          status: "skipped" as const,
          result: "Skipped because an earlier action in this batch failed.",
        })),
      )
      break
    }
  }
  const failed = actionResults.some((result) => result.status === "error")
  return {
    title: failed ? "Batch stopped after an action failed" : `Completed ${actionResults.length} actions`,
    output: JSON.stringify(actionResults),
    metadata: { ...toolMetadata, ...metadata(transition, failed ? "error" : "completed", { actionResults }) },
    ...(attachments.length ? { attachments } : {}),
  }
}

export function finish(messages: SessionV1.Part[]) {
  return messages
    .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === TOOL_ID)
    .flatMap((part) => {
      if (part.state.status !== "completed") return []
      const value = part.state.metadata?.[METADATA_KEY]
      if (!isTransitionMetadata(value) || value.actionStatus !== "finish" || !value.finalMessage) return []
      return [value.finalMessage]
    })
    .at(-1)
}

function prepareTransition(value: unknown, state: State, revision: number, mode: Mode): Transition {
  if (!isRecord(value) || !isRecord(value.state_patch)) throw new Error("skill_step requires object state_patch")
  const actions = mode === "v3" ? prepareActions(value.actions) : undefined
  const action = mode === "v3" ? undefined : prepareAction(value.action, "skill_step.action")
  if (mode === "paper" && Object.keys(value).some((key) => key !== "state_patch" && key !== "action")) {
    throw new Error("paper mode accepts exactly state_patch and action")
  }
  if (mode === "v3") {
    if (value.state_revision !== revision) {
      throw new Error(`stale state_revision ${String(value.state_revision)}; expected ${revision}`)
    }
    if (Object.keys(value).some((key) => !["state_revision", "state_patch", "comment", "actions"].includes(key))) {
      throw new Error("v3 mode accepts exactly state_revision, state_patch, optional comment, and actions")
    }
    if (actions?.some((item) => item.name === "finish") && actions.length !== 1) {
      throw new Error("finish must be the sole action in a v3 batch")
    }
  }
  const comment = mode === "paper" ? undefined : prepareComment(value.comment)
  assertSafePatch(value.state_patch)
  const next = applyPatch(state, value.state_patch)
  const decoded = Schema.decodeUnknownExit(CodingState)(next, {
    errors: "all",
    onExcessProperty: "error",
  })
  if (Exit.isFailure(decoded)) throw new Error(`Invalid resulting execution state: ${Cause.pretty(decoded.cause)}`)
  const bytes = Buffer.byteLength(JSON.stringify(decoded.value))
  if (bytes > MAX_STATE_BYTES) {
    throw new Error(`Execution state uses ${bytes} bytes; the limit is ${MAX_STATE_BYTES}`)
  }
  return {
    mode,
    revision: revision + 1,
    patch: structuredClone(value.state_patch),
    state: decoded.value,
    ...(action ? { action } : {}),
    ...(actions ? { actions } : {}),
    ...(comment ? { comment } : {}),
  }
}

function prepareActions(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("skill_step.actions must be a non-empty array")
  return value.map((action, index) => prepareAction(action, `skill_step.actions[${index}]`))
}

function prepareAction(value: unknown, label: string): RequestedAction {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.input)) {
    throw new Error(`${label} requires string name and object input`)
  }
  return { name: value.name, input: structuredClone(value.input) }
}

function applyPatch(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const result = structuredClone(current)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key]
      continue
    }
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = applyPatch(result[key], value)
      continue
    }
    result[key] = structuredClone(value)
  }
  return result
}

function assertSafePatch(value: Record<string, unknown>) {
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error(`Execution state patch contains forbidden key: ${key}`)
    }
    if (isRecord(item)) assertSafePatch(item)
  }
}

const initialObservation: Observation = {
  revision: 0,
  action: null,
  status: "initial",
  result: "No environment action has run yet.",
}

function observation(part: SessionV1.ToolPart): Observation {
  const stored = transitionMetadata(part)
  if (isTransitionMetadata(stored)) {
    if (stored.protocolVersion === 3) return batchObservation(part, stored)
    if (!stored.action) throw new Error("single-action transition metadata is missing action")
    return {
      revision: stored.revision,
      action: {
        name: stored.action.name,
        input: boundedValue(stored.action.input, MAX_ACTION_INPUT_BYTES),
      },
      ...(stored.comment ? { comment: boundedText(stored.comment, MAX_COMMENT_BYTES) } : {}),
      status:
        stored.actionStatus === "pending"
          ? "interrupted"
          : stored.actionStatus === "finish"
            ? "finish"
            : stored.actionStatus,
      result: observationResult(part, stored.actionStatus),
    }
  }

  const input = isRecord(part.state.input) ? part.state.input : {}
  if (Array.isArray(input.actions)) {
    return {
      revision: null,
      actions: input.actions.map((action, index) => {
        const prepared = prepareAction(action, `skill_step.actions[${index}]`)
        return {
          name: prepared.name,
          input: boundedValue(prepared.input, MAX_ACTION_INPUT_BYTES),
          status: "skipped" as const,
          result: "The transition ended before this action produced a result.",
        }
      }),
      ...(typeof input.comment === "string" && input.comment.trim()
        ? { comment: boundedText(input.comment.trim(), MAX_COMMENT_BYTES) }
        : {}),
      status: part.state.status === "error" ? "protocol_error" : "interrupted",
      result:
        part.state.status === "error"
          ? boundedText(part.state.error, MAX_RESULT_BYTES)
          : "The transition was interrupted before its batch produced results.",
    }
  }
  const requested = isRecord(input.action) ? input.action : undefined
  const requestedName = requested && typeof requested.name === "string" ? requested.name : undefined
  const requestedInput = requested && isRecord(requested.input) ? requested.input : {}
  return {
    revision: null,
    action: requestedName
      ? {
          name: requestedName,
          input: boundedValue(requestedInput, MAX_ACTION_INPUT_BYTES),
        }
      : { name: TOOL_ID, input: boundedValue(input, MAX_ACTION_INPUT_BYTES) },
    ...(typeof input.comment === "string" && input.comment.trim()
      ? { comment: boundedText(input.comment.trim(), MAX_COMMENT_BYTES) }
      : {}),
    status: part.state.status === "error" ? "protocol_error" : "interrupted",
    result:
      part.state.status === "error"
        ? boundedText(part.state.error, MAX_RESULT_BYTES)
        : "The transition was interrupted before its action produced a result.",
  }
}

function batchObservation(part: SessionV1.ToolPart, stored: TransitionMetadata): Observation {
  const results =
    stored.actionResults ??
    (stored.actions ?? []).map((action) => ({
      ...action,
      status: "skipped" as const,
      result: "The transition was interrupted before this action produced a result.",
    }))
  return {
    revision: stored.revision,
    actions: results.map((result) => ({
      name: result.name,
      input: boundedValue(result.input, MAX_ACTION_INPUT_BYTES),
      status: result.status,
      result: boundedText(result.result, MAX_RESULT_BYTES),
    })),
    ...(stored.comment ? { comment: boundedText(stored.comment, MAX_COMMENT_BYTES) } : {}),
    status:
      stored.actionStatus === "pending"
        ? "interrupted"
        : stored.actionStatus === "finish"
          ? "finish"
          : stored.actionStatus,
    result:
      part.state.status === "error"
        ? boundedText(part.state.error, MAX_RESULT_BYTES)
        : stored.actionStatus === "error"
          ? "The batch stopped after an action failed."
          : stored.actionStatus === "finish"
            ? "The session finished."
            : `The batch completed ${results.length} action${results.length === 1 ? "" : "s"}.`,
  }
}

function transitionMetadata(part: SessionV1.ToolPart) {
  if (!("metadata" in part.state)) return undefined
  return part.state.metadata?.[METADATA_KEY]
}

function observationResult(part: SessionV1.ToolPart, status: TransitionMetadata["actionStatus"]) {
  if (status === "pending") return "The action was interrupted before producing a result."
  if (part.state.status === "error") return boundedText(part.state.error, MAX_RESULT_BYTES)
  if (part.state.status !== "completed") return "The action was interrupted before producing a result."
  if (part.state.output) return boundedText(part.state.output, MAX_RESULT_BYTES)
  if (status === "error") return "Action failed without textual error output."
  if (status === "finish") return "The session finished without a textual final message."
  return "Action completed successfully without textual output."
}

function observationFallback(failed: boolean) {
  return failed
    ? "Action failed without textual error output."
    : "Action completed successfully without textual output."
}

function prepareComment(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error("skill_step.comment must be a non-empty string")
  const result = value.trim()
  const bytes = Buffer.byteLength(result)
  if (bytes > MAX_COMMENT_BYTES) {
    throw new Error(`skill_step.comment uses ${bytes} bytes; the limit is ${MAX_COMMENT_BYTES}`)
  }
  return result
}

function boundedValue(value: unknown, limit: number) {
  const text = JSON.stringify(value) ?? "null"
  const bytes = Buffer.byteLength(text)
  if (bytes <= limit) return structuredClone(value)
  return {
    truncated: true,
    originalBytes: bytes,
    sha256: createHash("sha256").update(text).digest("hex"),
    preview: boundedText(text, limit - 160),
  }
}

function boundedText(value: string, limit: number) {
  const bytes = Buffer.byteLength(value)
  if (bytes <= limit) return value
  const marker = `\n...[truncated; original bytes: ${bytes}]`
  const budget = Math.max(0, limit - Buffer.byteLength(marker))
  let end = Math.min(value.length, budget)
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > budget) end--
  return value.slice(0, end) + marker
}

async function resolveToolResult(value: unknown): Promise<ActionResult> {
  const result = isAsyncIterable(value) ? await last(value) : value
  if (typeof result === "string") {
    return { title: "Action completed", output: result, metadata: {}, actionError: false }
  }
  if (!isRecord(result)) {
    return {
      title: "Action completed",
      output: JSON.stringify(result) ?? "",
      metadata: {},
      actionError: false,
    }
  }
  return {
    title: typeof result.title === "string" ? result.title : "Action completed",
    output: typeof result.output === "string" ? result.output : (JSON.stringify(result.output) ?? ""),
    metadata: isRecord(result.metadata) ? result.metadata : {},
    attachments: Array.isArray(result.attachments) ? result.attachments : undefined,
    actionError: false,
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && Symbol.asyncIterator in value
}

async function last(value: AsyncIterable<unknown>) {
  let result: unknown
  for await (const item of value) result = item
  return result
}

function isTransitionMetadata(value: unknown): value is TransitionMetadata {
  if (!isRecord(value)) return false
  const single =
    value.protocolVersion !== 3 &&
    isRecord(value.action) &&
    typeof value.action.name === "string" &&
    isRecord(value.action.input)
  const batch =
    value.protocolVersion === 3 &&
    Array.isArray(value.actions) &&
    value.actions.length > 0 &&
    value.actions.every((action) => isRecord(action) && typeof action.name === "string" && isRecord(action.input)) &&
    (value.actionResults === undefined ||
      (Array.isArray(value.actionResults) &&
        value.actionResults.every(
          (result) =>
            isRecord(result) &&
            typeof result.name === "string" &&
            isRecord(result.input) &&
            ["completed", "error", "skipped"].includes(String(result.status)) &&
            typeof result.result === "string",
        )))
  return (
    (value.protocolVersion === 1 || value.protocolVersion === 2 || value.protocolVersion === 3) &&
    typeof value.revision === "number" &&
    Number.isInteger(value.revision) &&
    value.revision > 0 &&
    Schema.is(CodingState)(value.state) &&
    isRecord(value.patch) &&
    (single || batch) &&
    (value.comment === undefined || typeof value.comment === "string") &&
    typeof value.stateBytes === "number" &&
    ["pending", "completed", "error", "finish"].includes(String(value.actionStatus))
  )
}

function protocolVersion(mode: Mode) {
  if (mode === "paper") return 1
  if (mode === "v2") return 2
  return 3
}

export * as SkillState from "./skill-state"
