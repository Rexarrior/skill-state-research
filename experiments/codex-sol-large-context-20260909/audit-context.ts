// Numeric-only diagnostics. Raw tool output and prompt text stay private.
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function auditContext(raw: string) {
  const models = new Set<string>()
  const counters = { calls: 0, input: 0, output: 0, transitions: 0, malformedTransitions: 0,
    maxStateBytes: 0, maxInputBytes: 0, maxResultBytes: 0, maxTransitionBytes: 0,
    inputPreviews: 0, skillResultTruncations: 0, earlierToolTruncationMarkers: 0 }
  for (const line of raw.split("\n").filter(Boolean)) {
    const event = object(JSON.parse(line))
    const payload = object(event.payload)
    if (event.type === "turn_context" && typeof payload.model === "string") models.add(payload.model)
    if (event.type === "token_usage_record") {
      const usage = object(payload.usage)
      counters.calls++
      counters.input += Number(usage.input_tokens ?? 0)
      counters.output += Number(usage.output_tokens ?? 0)
    }
    if (event.type !== "response_item" || payload.type !== "function_call_output" ||
        payload.name !== "skill_step") continue
    counters.transitions++
    if (typeof payload.output !== "string") { counters.malformedTransitions++; continue }
    counters.maxTransitionBytes = Math.max(counters.maxTransitionBytes, Buffer.byteLength(payload.output))
    let transition: Record<string, unknown>
    try { transition = object(JSON.parse(payload.output)) }
    catch { counters.malformedTransitions++; continue }
    counters.maxStateBytes = Math.max(counters.maxStateBytes,
      Buffer.byteLength(JSON.stringify(transition.state ?? {})))
    const observation = object(transition.observation)
    const actions = Array.isArray(observation.actions) ? observation.actions.map(object) : [observation]
    if (typeof observation.error === "string") actions.push({ result: observation.error })
    for (const action of actions) {
      counters.maxInputBytes = Math.max(counters.maxInputBytes,
        Buffer.byteLength(JSON.stringify(action.input ?? null)))
      if (object(action.input).truncated === true) counters.inputPreviews++
      const result = typeof action.result === "string" ? action.result : ""
      counters.maxResultBytes = Math.max(counters.maxResultBytes, Buffer.byteLength(result))
      if (result.includes("[truncated by SKILL.state]")) counters.skillResultTruncations++
      if (/Output truncated|tokens truncated|output.{0,20}omitted|omitted.{0,20}bytes/i.test(result))
        counters.earlierToolTruncationMarkers++
    }
  }
  return { models: [...models], ...counters,
    scope: "Persisted main rollout, not a packet capture. Earlier truncation markers are heuristic, not proof of exact bytes lost." }
}
