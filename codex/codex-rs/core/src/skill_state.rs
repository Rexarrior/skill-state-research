//! Kernel-level SKILL.state paper and v2 prompt and transition protocols.
//!
//! The rollout keeps the ordinary Codex transcript for audit and resume.  The
//! provider-visible request is rebuilt from that transcript as `(P, Sigma, O)`:
//! one immutable task, one mutable execution state, and a bounded observation
//! window.  The model can only call `skill_step`; the runtime validates and
//! applies its patch before dispatching the nested Codex tool action.

use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::SessionSource;
use codex_tools::AdditionalProperties;
use codex_tools::JsonSchema;
use codex_tools::ResponsesApiNamespaceTool;
use codex_tools::ResponsesApiTool;
use codex_tools::ToolName;
use codex_tools::ToolSpec;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

#[path = "skill_state_paper.rs"]
mod paper;

pub(crate) const TOOL_NAME: &str = "skill_step";
pub const V2_SESSION_SOURCE: &str = "codex";
const V2_PROTOCOL: &str = "skill.state/v2";
const PAPER_PROTOCOL: &str = "skill.state/paper";
const DEFAULT_OBSERVATION_WINDOW: usize = 3;
const MAX_OBSERVATION_WINDOW: usize = 8;
const MAX_STATE_BYTES: usize = 32 * 1024;
const MAX_COMMENT_BYTES: usize = 1024;
const MAX_ACTION_REQUEST_BYTES: usize = 64 * 1024;
const MAX_OBSERVATION_INPUT_BYTES: usize = 3 * 1024;
const MAX_RESULT_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionStatus {
    Working,
    Blocked,
    Done,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExecutionState {
    pub(crate) status: ExecutionStatus,
    pub(crate) plan: Vec<String>,
    pub(crate) completed: Vec<String>,
    pub(crate) files: BTreeMap<String, String>,
    pub(crate) facts: Vec<String>,
    pub(crate) decisions: Vec<String>,
    pub(crate) next_action: String,
}

impl Default for ExecutionState {
    fn default() -> Self {
        Self {
            status: ExecutionStatus::Working,
            plan: Vec::new(),
            completed: Vec::new(),
            files: BTreeMap::new(),
            facts: Vec::new(),
            decisions: Vec::new(),
            next_action: "Inspect the task and choose the first concrete action.".to_string(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProtocolMode {
    Paper,
    V2,
}

#[derive(Clone, Debug)]
pub(crate) struct StepRequest {
    pub(crate) mode: ProtocolMode,
    pub(crate) state_revision: Option<u64>,
    pub(crate) state_patch: Value,
    pub(crate) comment: Option<String>,
    pub(crate) action: RequestedAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct V2StepRequest {
    state_revision: u64,
    #[serde(default = "empty_patch")]
    state_patch: Value,
    #[serde(default)]
    comment: Option<String>,
    action: RequestedAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RequestedAction {
    pub(crate) name: String,
    pub(crate) input: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Observation {
    pub(crate) revision: u64,
    pub(crate) action: String,
    pub(crate) input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) comment: Option<String>,
    pub(crate) status: ObservationStatus,
    pub(crate) result: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ObservationStatus {
    Success,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedTransition {
    protocol: String,
    revision: u64,
    state: ExecutionState,
    observation: Observation,
    #[serde(skip_serializing_if = "Option::is_none")]
    final_message: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Snapshot {
    pub(crate) revision: u64,
    pub(crate) state: ExecutionState,
    pub(crate) observations: Vec<Observation>,
    pub(crate) final_message: Option<String>,
}

#[derive(Default)]
pub(crate) struct RuntimeState {
    current: Option<Snapshot>,
}

#[derive(Clone, Debug)]
pub(crate) enum ResolvedAction {
    Finish {
        message: String,
    },
    Tool {
        tool_name: ToolName,
        input: Value,
        custom: bool,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct AcceptedStep {
    pub(crate) mode: ProtocolMode,
    pub(crate) revision: u64,
    pub(crate) state: ExecutionState,
    pub(crate) comment: Option<String>,
    pub(crate) action_name: String,
    pub(crate) action_input: Value,
    pub(crate) action: ResolvedAction,
}

impl RuntimeState {
    pub(crate) fn accept(
        &mut self,
        persisted: Snapshot,
        request: StepRequest,
        tools: &[ToolSpec],
    ) -> Result<AcceptedStep, String> {
        let current = self.current.get_or_insert(persisted);
        if request.mode == ProtocolMode::V2 && request.state_revision != Some(current.revision) {
            return Err(format!(
                "stale state_revision {}; expected {}",
                request.state_revision.unwrap_or(u64::MAX),
                current.revision
            ));
        }
        validate_comment(request.comment.as_deref())?;
        validate_json_size(
            "action.input",
            &request.action.input,
            MAX_ACTION_REQUEST_BYTES,
        )?;
        let action = resolve_action(&request.action, tools)?;
        let mut next = serde_json::to_value(&current.state)
            .map_err(|err| format!("failed to serialize execution state: {err}"))?;
        apply_patch(&mut next, request.state_patch, request.mode)?;
        let mut next = serde_json::from_value::<ExecutionState>(next)
            .map_err(|err| format!("invalid resulting execution state: {err}"))?;
        if matches!(action, ResolvedAction::Finish { .. }) {
            next.status = ExecutionStatus::Done;
            next.next_action.clear();
        } else if next.status == ExecutionStatus::Done {
            return Err("status may be set to done only with the finish action".to_string());
        }
        validate_state(&next)?;
        let revision = current.revision.saturating_add(1);
        current.revision = revision;
        current.state = next.clone();
        current.final_message = match &action {
            ResolvedAction::Finish { message } => Some(message.clone()),
            ResolvedAction::Tool { .. } => None,
        };
        Ok(AcceptedStep {
            mode: request.mode,
            revision,
            state: next,
            comment: request.comment,
            action_name: request.action.name,
            action_input: request.action.input,
            action,
        })
    }
}

pub(crate) fn mode(source: &SessionSource) -> Option<ProtocolMode> {
    match source {
        // Keep the ordinary Codex identity for both protocols. Command policy
        // and approval routing consume this source, so overloading it as a
        // protocol discriminator would change tool execution semantics.
        SessionSource::Custom(name) if name == V2_SESSION_SOURCE => {
            match std::env::var("CODEX_SKILL_STATE_MODE").as_deref() {
                Ok("paper") => Some(ProtocolMode::Paper),
                Ok("v2") | Err(std::env::VarError::NotPresent) => Some(ProtocolMode::V2),
                _ => None,
            }
        }
        _ => None,
    }
}

pub(crate) fn decode_request(arguments: &str, mode: ProtocolMode) -> Result<StepRequest, String> {
    match mode {
        ProtocolMode::Paper => paper::decode_request(arguments),
        ProtocolMode::V2 => serde_json::from_str::<V2StepRequest>(arguments)
            .map(|request| StepRequest {
                mode,
                state_revision: Some(request.state_revision),
                state_patch: request.state_patch,
                comment: request.comment,
                action: request.action,
            })
            .map_err(|err| format!("invalid v2 skill_step payload: {err}")),
    }
}

pub(crate) fn wrapper_spec(tools: &[ToolSpec], mode: ProtocolMode) -> ToolSpec {
    let mut variants = action_variants(tools);
    variants.push(finish_action_schema());
    let action = JsonSchema::one_of(
        variants,
        Some("Exactly one concrete runtime action.".to_string()),
    );
    let parameters = match mode {
        ProtocolMode::Paper => JsonSchema::object(
            BTreeMap::from([
                ("state_patch".to_string(), paper::state_patch_schema()),
                ("action".to_string(), action),
            ]),
            Some(vec!["state_patch".to_string(), "action".to_string()]),
            Some(false.into()),
        ),
        ProtocolMode::V2 => JsonSchema::object(
            BTreeMap::from([
                (
                    "state_revision".to_string(),
                    JsonSchema::integer(Some(
                        "Revision shown in the current Skill Execution State.".to_string(),
                    )),
                ),
                ("state_patch".to_string(), state_patch_schema()),
                (
                    "comment".to_string(),
                    JsonSchema::string(Some(
                        "Optional concise explanation of why this action is useful.".to_string(),
                    )),
                ),
                ("action".to_string(), action),
            ]),
            Some(vec![
                "state_revision".to_string(),
                "state_patch".to_string(),
                "action".to_string(),
            ]),
            Some(false.into()),
        ),
    };
    ToolSpec::Function(ResponsesApiTool {
        name: TOOL_NAME.to_string(),
        description: "Atomically patch SKILL.state and execute exactly one Codex action. This is the only tool you may call.".to_string(),
        strict: false,
        defer_loading: None,
        parameters,
        output_schema: None,
    })
}

pub(crate) fn provider_input(input: &[ResponseItem], mode: ProtocolMode) -> Vec<ResponseItem> {
    let snapshot = snapshot(input, mode);
    let task = immutable_task(input);
    let text = match mode {
        ProtocolMode::Paper => paper::prompt(
            &task,
            &snapshot.state,
            snapshot
                .observations
                .last()
                .map(|value| value.result.as_str()),
        ),
        ProtocolMode::V2 => v2_prompt(&task, &snapshot),
    };
    vec![ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::InputText { text }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }]
}

fn v2_prompt(task: &str, snapshot: &Snapshot) -> String {
    let observations = snapshot
        .observations
        .iter()
        .rev()
        .take(observation_window())
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let state_json =
        serde_json::to_string_pretty(&snapshot.state).unwrap_or_else(|_| "{}".to_string());
    let observation_json =
        serde_json::to_string_pretty(&observations).unwrap_or_else(|_| "[]".to_string());
    format!(
        "You are operating under the SKILL.state v2 execution protocol.\n\
The execution state is your only durable memory. Previous messages and reasoning are not available.\n\
On every step, call skill_step exactly once. Supply the shown state_revision, a minimal state_patch, an optional comment, and one action.\n\
The patch updates durable state before the action runs. Preserve facts needed later in state; do not use state as a transcript.\n\
Large action inputs may be executed, but only a bounded preview is retained in observations.\n\
Use finish only when the task is complete, with a concise final message in action.input.message.\n\
\nInstructions (P, immutable):\n{task}\n\
\nSkill Execution State (Sigma, revision {}):\n{state_json}\n\
\nRecent Observations (O[n..n-k], oldest first):\n{observation_json}",
        snapshot.revision,
    )
}

pub(crate) fn snapshot(input: &[ResponseItem], mode: ProtocolMode) -> Snapshot {
    let mut current = Snapshot::default();
    for item in input {
        let Some(text) = skill_step_output_text(item) else {
            continue;
        };
        let Ok(transition) = serde_json::from_str::<PersistedTransition>(text) else {
            continue;
        };
        if transition.protocol != protocol(mode) || transition.revision < current.revision {
            continue;
        }
        current.revision = transition.revision;
        current.state = transition.state;
        current.observations.push(transition.observation);
        current.final_message = transition.final_message;
    }
    current
}

pub(crate) fn transition_output(
    call_id: String,
    accepted: AcceptedStep,
    status: ObservationStatus,
    result: String,
) -> ResponseItem {
    let final_message = match &accepted.action {
        ResolvedAction::Finish { message } => Some(message.clone()),
        ResolvedAction::Tool { .. } => None,
    };
    let transition = PersistedTransition {
        protocol: protocol(accepted.mode).to_string(),
        revision: accepted.revision,
        state: accepted.state,
        observation: Observation {
            revision: accepted.revision,
            action: accepted.action_name,
            input: bounded_action_input(accepted.action_input),
            comment: accepted.comment,
            status,
            result: truncate_utf8(result, MAX_RESULT_BYTES),
        },
        final_message,
    };
    let output = serde_json::to_string(&transition).unwrap_or_else(|err| {
        format!(
            "{{\"protocol\":\"{}\",\"error\":\"{err}\"}}",
            protocol(accepted.mode)
        )
    });
    ResponseItem::FunctionCallOutput {
        id: None,
        call_id: Some(call_id),
        name: Some(TOOL_NAME.to_string()),
        namespace: None,
        output: FunctionCallOutputPayload {
            body: FunctionCallOutputBody::Text(output),
            success: Some(matches!(status, ObservationStatus::Success)),
        },
        internal_chat_message_metadata_passthrough: None,
    }
}

pub(crate) fn rejected_output(
    call_id: String,
    mode: ProtocolMode,
    snapshot: Snapshot,
    message: String,
) -> ResponseItem {
    let transition = PersistedTransition {
        protocol: protocol(mode).to_string(),
        revision: snapshot.revision,
        state: snapshot.state,
        observation: Observation {
            revision: snapshot.revision,
            action: TOOL_NAME.to_string(),
            input: Value::Null,
            comment: Some("The proposed step was rejected before execution.".to_string()),
            status: ObservationStatus::Error,
            result: truncate_utf8(message, MAX_RESULT_BYTES),
        },
        final_message: snapshot.final_message,
    };
    let output = serde_json::to_string(&transition).unwrap_or_else(|err| {
        format!(
            "{{\"protocol\":\"{}\",\"error\":\"{err}\"}}",
            protocol(mode)
        )
    });
    ResponseItem::FunctionCallOutput {
        id: None,
        call_id: Some(call_id),
        name: Some(TOOL_NAME.to_string()),
        namespace: None,
        output: FunctionCallOutputPayload {
            body: FunctionCallOutputBody::Text(output),
            success: Some(false),
        },
        internal_chat_message_metadata_passthrough: None,
    }
}

fn immutable_task(input: &[ResponseItem]) -> String {
    let first_step = input
        .iter()
        .position(is_skill_step_call)
        .unwrap_or(input.len());
    let mut sections = Vec::new();
    for item in &input[..first_step] {
        let ResponseItem::Message { role, content, .. } = item else {
            continue;
        };
        if role == "assistant" {
            continue;
        }
        let text = content
            .iter()
            .map(|part| match part {
                ContentItem::InputText { text } | ContentItem::OutputText { text } => text.as_str(),
                ContentItem::InputImage { .. } => "[image omitted by SKILL.state]",
                ContentItem::InputAudio { .. } => "[audio omitted by SKILL.state]",
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            sections.push(format!("[{role}]\n{text}"));
        }
    }
    if sections.is_empty() {
        "No textual task specification was found.".to_string()
    } else {
        sections.join("\n\n")
    }
}

fn skill_step_output_text(item: &ResponseItem) -> Option<&str> {
    match item {
        // History normalization may drop `name` once a call_id is present.
        // The parser below still requires the private protocol discriminator,
        // so inspecting all textual function outputs cannot adopt a foreign
        // tool result as state.
        ResponseItem::FunctionCallOutput { output, .. } => output.text_content(),
        _ => None,
    }
}

fn is_skill_step_call(item: &ResponseItem) -> bool {
    matches!(item, ResponseItem::FunctionCall { name, .. } if name == TOOL_NAME)
}

fn observation_window() -> usize {
    std::env::var("CODEX_SKILL_STATE_OBSERVATION_WINDOW")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_OBSERVATION_WINDOW)
        .clamp(1, MAX_OBSERVATION_WINDOW)
}

fn action_variants(tools: &[ToolSpec]) -> Vec<JsonSchema> {
    let mut variants = Vec::new();
    for tool in tools {
        match tool {
            ToolSpec::Function(tool) => variants.push(action_schema(
                &tool.name,
                tool.parameters.clone(),
                &tool.description,
            )),
            ToolSpec::Freeform(tool) => variants.push(action_schema(
                &tool.name,
                JsonSchema::string(Some("Freeform tool input.".to_string())),
                &tool.description,
            )),
            ToolSpec::Namespace(namespace) => {
                for tool in &namespace.tools {
                    match tool {
                        ResponsesApiNamespaceTool::Function(tool) => variants.push(action_schema(
                            &format!("{}::{}", namespace.name, tool.name),
                            tool.parameters.clone(),
                            &tool.description,
                        )),
                        ResponsesApiNamespaceTool::Custom(tool) => variants.push(action_schema(
                            &format!("{}::{}", namespace.name, tool.name),
                            JsonSchema::string(Some("Freeform tool input.".to_string())),
                            &tool.description,
                        )),
                    }
                }
            }
            ToolSpec::ToolSearch { .. } | ToolSpec::WebSearch { .. } => {}
        }
    }
    variants
}

fn action_schema(name: &str, input: JsonSchema, description: &str) -> JsonSchema {
    JsonSchema::object(
        BTreeMap::from([
            (
                "name".to_string(),
                JsonSchema::string_enum(
                    vec![Value::String(name.to_string())],
                    Some(description.to_string()),
                ),
            ),
            ("input".to_string(), input),
        ]),
        Some(vec!["name".to_string(), "input".to_string()]),
        Some(false.into()),
    )
}

fn finish_action_schema() -> JsonSchema {
    action_schema(
        "finish",
        JsonSchema::object(
            BTreeMap::from([(
                "message".to_string(),
                JsonSchema::string(Some("Final user-facing result.".to_string())),
            )]),
            Some(vec!["message".to_string()]),
            Some(false.into()),
        ),
        "Finish the task and return the final user-facing message.",
    )
}

fn state_patch_schema() -> JsonSchema {
    let strings = || JsonSchema::array(JsonSchema::string(None), None);
    JsonSchema::object(
        BTreeMap::from([
            (
                "status".to_string(),
                JsonSchema::string_enum(
                    ["working", "blocked", "done"]
                        .into_iter()
                        .map(|value| Value::String(value.to_string()))
                        .collect(),
                    None,
                ),
            ),
            ("plan".to_string(), strings()),
            ("completed".to_string(), strings()),
            (
                "files".to_string(),
                JsonSchema::object(
                    BTreeMap::new(),
                    None,
                    Some(AdditionalProperties::Schema(Box::new(JsonSchema::string(
                        None,
                    )))),
                ),
            ),
            ("facts".to_string(), strings()),
            ("decisions".to_string(), strings()),
            ("next_action".to_string(), JsonSchema::string(None)),
        ]),
        None,
        Some(false.into()),
    )
}

fn resolve_action(action: &RequestedAction, tools: &[ToolSpec]) -> Result<ResolvedAction, String> {
    if action.name == "finish" {
        let message = action
            .input
            .get("message")
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .ok_or_else(|| "finish action requires non-empty input.message".to_string())?;
        return Ok(ResolvedAction::Finish {
            message: message.to_string(),
        });
    }
    for tool in tools {
        match tool {
            ToolSpec::Function(tool) if action.name == tool.name => {
                return Ok(ResolvedAction::Tool {
                    tool_name: ToolName::plain(&tool.name).with_default_namespace(),
                    input: action.input.clone(),
                    custom: false,
                });
            }
            ToolSpec::Freeform(tool) if action.name == tool.name => {
                require_string_input(action)?;
                return Ok(ResolvedAction::Tool {
                    tool_name: ToolName::plain(&tool.name).with_default_namespace(),
                    input: action.input.clone(),
                    custom: true,
                });
            }
            ToolSpec::Namespace(namespace) => {
                let Some(name) = action.name.strip_prefix(&format!("{}::", namespace.name)) else {
                    continue;
                };
                for nested in &namespace.tools {
                    match nested {
                        ResponsesApiNamespaceTool::Function(tool) if name == tool.name => {
                            return Ok(ResolvedAction::Tool {
                                tool_name: ToolName::namespaced(&namespace.name, &tool.name),
                                input: action.input.clone(),
                                custom: false,
                            });
                        }
                        ResponsesApiNamespaceTool::Custom(tool) if name == tool.name => {
                            require_string_input(action)?;
                            return Ok(ResolvedAction::Tool {
                                tool_name: ToolName::namespaced(&namespace.name, &tool.name),
                                input: action.input.clone(),
                                custom: true,
                            });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Err(format!(
        "action {:?} is not available in this step's tool plan",
        action.name
    ))
}

fn require_string_input(action: &RequestedAction) -> Result<(), String> {
    if action.input.is_string() {
        Ok(())
    } else {
        Err(format!("action {:?} requires a string input", action.name))
    }
}

fn apply_patch(state: &mut Value, patch: Value, mode: ProtocolMode) -> Result<(), String> {
    if mode == ProtocolMode::Paper {
        return paper::apply_patch(state, patch);
    }
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
            continue;
        }
        state.insert(key, value);
    }
    Ok(())
}

fn empty_patch() -> Value {
    serde_json::json!({})
}

fn protocol(mode: ProtocolMode) -> &'static str {
    match mode {
        ProtocolMode::Paper => PAPER_PROTOCOL,
        ProtocolMode::V2 => V2_PROTOCOL,
    }
}

fn validate_comment(comment: Option<&str>) -> Result<(), String> {
    if comment.is_some_and(|comment| comment.len() > MAX_COMMENT_BYTES) {
        Err(format!("comment exceeds {MAX_COMMENT_BYTES} bytes"))
    } else {
        Ok(())
    }
}

fn validate_state(state: &ExecutionState) -> Result<(), String> {
    validate_json_size("execution state", state, MAX_STATE_BYTES)
}

fn validate_json_size(label: &str, value: &impl Serialize, limit: usize) -> Result<(), String> {
    let size = serde_json::to_vec(value)
        .map_err(|err| format!("failed to serialize {label}: {err}"))?
        .len();
    if size > limit {
        Err(format!("{label} is {size} bytes; limit is {limit}"))
    } else {
        Ok(())
    }
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value.push_str("\n…[truncated by SKILL.state v2]");
    value
}

fn bounded_action_input(value: Value) -> Value {
    let Ok(serialized) = serde_json::to_vec(&value) else {
        return serde_json::json!({"truncated": true, "reason": "serialization failed"});
    };
    if serialized.len() <= MAX_OBSERVATION_INPUT_BYTES {
        return value;
    }
    let original_bytes = serialized.len();
    let preview = truncate_utf8(
        String::from_utf8_lossy(&serialized).into_owned(),
        MAX_OBSERVATION_INPUT_BYTES.saturating_sub(1024),
    );
    serde_json::json!({
        "truncated": true,
        "original_bytes": original_bytes,
        "preview": preview,
    })
}

pub(crate) fn tool_specs(wrapper: ToolSpec) -> Arc<[ToolSpec]> {
    Arc::from(vec![wrapper])
}

#[cfg(test)]
#[path = "skill_state_tests.rs"]
mod tests;
