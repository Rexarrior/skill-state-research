use super::ExecutionState;
use super::ProtocolMode;
use super::RequestedAction;
use super::StepRequest;
use codex_tools::AdditionalProperties;
use codex_tools::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PaperStepRequest {
    state_patch: Value,
    action: RequestedAction,
}

pub(super) fn decode_request(arguments: &str) -> Result<StepRequest, String> {
    serde_json::from_str::<PaperStepRequest>(arguments)
        .map(|request| StepRequest {
            mode: ProtocolMode::Paper,
            state_revision: None,
            state_patch: request.state_patch,
            comment: None,
            action: request.action,
        })
        .map_err(|err| format!("invalid paper skill_step payload: {err}"))
}

pub(super) fn prompt(task: &str, state: &ExecutionState, observation: Option<&str>) -> String {
    let state_json = serde_json::to_string(state).unwrap_or_else(|_| "{}".to_string());
    let observation = observation.unwrap_or("No environment action has run yet.");
    format!(
        "You are operating under the original SKILL.state execution protocol from the paper.\n\
The execution state is your only durable memory. Previous observations, actions, responses, and reasoning are unavailable.\n\
On every step, call skill_step exactly once with exactly two fields: state_patch and action. Use null in nested dictionaries to delete obsolete entries.\n\
The runtime validates and applies the patch before executing exactly one action. Use finish only when the task is complete.\n\
\nInstructions:\n{task}\n\
\nSkill Execution State:\n{state_json}\n\
\nLatest Observation:\n{observation}"
    )
}

pub(super) fn state_patch_schema() -> JsonSchema {
    let nullable = |schema| JsonSchema::any_of(vec![schema, JsonSchema::null(None)], None);
    let strings = || nullable(JsonSchema::array(JsonSchema::string(None), None));
    JsonSchema::object(
        BTreeMap::from([
            (
                "status".to_string(),
                nullable(JsonSchema::string_enum(
                    ["working", "blocked", "done"]
                        .into_iter()
                        .map(|value| Value::String(value.to_string()))
                        .collect(),
                    None,
                )),
            ),
            ("plan".to_string(), strings()),
            ("completed".to_string(), strings()),
            (
                "files".to_string(),
                nullable(JsonSchema::object(
                    BTreeMap::new(),
                    None,
                    Some(AdditionalProperties::Schema(Box::new(nullable(
                        JsonSchema::string(None),
                    )))),
                )),
            ),
            ("facts".to_string(), strings()),
            ("decisions".to_string(), strings()),
            (
                "next_action".to_string(),
                nullable(JsonSchema::string(None)),
            ),
        ]),
        None,
        Some(false.into()),
    )
}

pub(super) fn apply_patch(state: &mut Value, patch: Value) -> Result<(), String> {
    let Value::Object(patch) = patch else {
        return Err("state_patch must be a JSON object".to_string());
    };
    let Value::Object(state) = state else {
        return Err("execution state must be a JSON object".to_string());
    };
    for (key, value) in patch {
        if matches!(key.as_str(), "__proto__" | "prototype" | "constructor") {
            return Err(format!(
                "execution state patch contains forbidden key: {key}"
            ));
        }
        if value.is_null() {
            state.remove(&key);
        } else if value.is_object() && state.get(&key).is_some_and(Value::is_object) {
            let current = state
                .get_mut(&key)
                .ok_or_else(|| format!("execution state lost key during patch: {key}"))?;
            apply_patch(current, value)?;
        } else {
            state.insert(key, value);
        }
    }
    Ok(())
}
