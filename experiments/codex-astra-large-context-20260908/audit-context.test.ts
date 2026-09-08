import { expect, test } from "bun:test"
import { auditContext } from "./audit-context"

test("audit counts batch bytes and truncation without exposing content", () => {
  const raw = [
    { type: "turn_context", payload: { model: "gpt-6-astra" } },
    { type: "token_usage_record", payload: { usage: { input_tokens: 19, output_tokens: 7 } } },
    { type: "response_item", payload: { type: "function_call_output", name: "skill_step",
      output: JSON.stringify({ state: { facts: ["private-fixture"] },
        observation: { actions: [{ input: { cmd: "private-fixture" }, result: "я".repeat(9000) },
          { input: { truncated: true }, result: "Output truncated [truncated by SKILL.state]" }] } }) } },
    { type: "response_item", payload: { type: "function_call_output", name: "skill_step", output: "broken" } },
  ].map(row => JSON.stringify(row)).join("\n")
  const result = auditContext(raw)
  expect(result.models).toEqual(["gpt-6-astra"])
  expect([result.calls, result.input, result.output, result.transitions, result.malformedTransitions])
    .toEqual([1, 19, 7, 2, 1])
  expect([result.inputPreviews, result.skillResultTruncations, result.earlierToolTruncationMarkers])
    .toEqual([1, 1, 1])
  expect(result.maxResultBytes).toBe(18000)
  expect(JSON.stringify(result)).not.toContain("private-fixture")
})
