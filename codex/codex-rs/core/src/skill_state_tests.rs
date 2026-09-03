use super::*;
use pretty_assertions::assert_eq;

fn function_tool(name: &str) -> ToolSpec {
    ToolSpec::Function(ResponsesApiTool {
        name: name.to_string(),
        description: format!("Run {name}"),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            BTreeMap::from([("command".to_string(), JsonSchema::string(None))]),
            Some(vec!["command".to_string()]),
            Some(false.into()),
        ),
        output_schema: None,
    })
}

fn request(revision: u64, action: &str) -> StepRequest {
    StepRequest {
        state_revision: revision,
        state_patch: StatePatch {
            facts: Some(vec!["workspace inspected".to_string()]),
            next_action: Some("run tests".to_string()),
            ..Default::default()
        },
        comment: Some("Inspect once before editing.".to_string()),
        action: RequestedAction {
            name: action.to_string(),
            input: serde_json::json!({"command":"pwd"}),
        },
    }
}

#[test]
fn accepts_patch_before_resolving_next_step() {
    let mut runtime = RuntimeState::default();
    let accepted = runtime
        .accept(
            Snapshot::default(),
            request(0, "exec_command"),
            &[function_tool("exec_command")],
        )
        .expect("step should be valid");

    assert_eq!(accepted.revision, 1);
    assert_eq!(accepted.state.facts, vec!["workspace inspected"]);
    assert_eq!(accepted.state.next_action, "run tests");
    assert!(matches!(accepted.action, ResolvedAction::Tool { .. }));
}

#[test]
fn rejects_stale_revision_atomically() {
    let mut runtime = RuntimeState::default();
    runtime
        .accept(
            Snapshot::default(),
            request(0, "exec_command"),
            &[function_tool("exec_command")],
        )
        .expect("first step should be valid");

    let error = runtime
        .accept(
            Snapshot::default(),
            request(0, "exec_command"),
            &[function_tool("exec_command")],
        )
        .expect_err("same response revision must not execute twice");
    assert_eq!(error, "stale state_revision 0; expected 1");
}

#[test]
fn transition_round_trips_state_and_observation() {
    let mut runtime = RuntimeState::default();
    let accepted = runtime
        .accept(
            Snapshot::default(),
            request(0, "exec_command"),
            &[function_tool("exec_command")],
        )
        .expect("step should be valid");
    let output = transition_output(
        "call-1".to_string(),
        accepted,
        ObservationStatus::Success,
        "ok".to_string(),
    );

    let restored = snapshot(&[output]);
    assert_eq!(restored.revision, 1);
    assert_eq!(restored.state.facts, vec!["workspace inspected"]);
    assert_eq!(restored.observations.len(), 1);
    assert_eq!(restored.observations[0].action, "exec_command");
    assert_eq!(restored.observations[0].result, "ok");
}

#[test]
fn accepts_large_action_but_bounds_observation_input() {
    let mut runtime = RuntimeState::default();
    let command = "x".repeat(MAX_OBSERVATION_INPUT_BYTES * 2);
    let accepted = runtime
        .accept(
            Snapshot::default(),
            StepRequest {
                action: RequestedAction {
                    name: "exec_command".to_string(),
                    input: serde_json::json!({"command": command}),
                },
                ..request(0, "exec_command")
            },
            &[function_tool("exec_command")],
        )
        .expect("code-generation actions larger than the observation budget must execute");
    let output = transition_output(
        "call-large".to_string(),
        accepted,
        ObservationStatus::Success,
        "ok".to_string(),
    );

    let restored = snapshot(&[output]);
    let input = &restored.observations[0].input;
    assert_eq!(input.get("truncated").and_then(Value::as_bool), Some(true));
    assert_eq!(
        input.get("original_bytes").and_then(Value::as_u64),
        Some((MAX_OBSERVATION_INPUT_BYTES * 2 + 14) as u64)
    );
    assert!(serde_json::to_vec(input).unwrap().len() <= MAX_OBSERVATION_INPUT_BYTES);
}

#[test]
fn provider_sees_one_message_without_transcript() {
    let task = ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::InputText {
            text: "Implement the parser".to_string(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    };
    let call = ResponseItem::FunctionCall {
        id: None,
        name: TOOL_NAME.to_string(),
        namespace: None,
        arguments: "{}".to_string(),
        encrypted_function_args: None,
        call_id: "call-1".to_string(),
        internal_chat_message_metadata_passthrough: None,
    };
    let rejected = rejected_output(
        "call-1".to_string(),
        Snapshot::default(),
        "bad patch".to_string(),
    );

    let visible = provider_input(&[task, call, rejected]);
    assert_eq!(visible.len(), 1);
    let ResponseItem::Message { role, content, .. } = &visible[0] else {
        panic!("state prompt must be a single message")
    };
    assert_eq!(role, "user");
    let ContentItem::InputText { text } = &content[0] else {
        panic!("state prompt must be textual")
    };
    assert!(text.contains("Instructions (P, immutable):"));
    assert!(text.contains("Implement the parser"));
    assert!(text.contains("bad patch"));
    assert!(!text.contains("arguments"));
}

#[test]
fn finish_forces_done_and_carries_final_message() {
    let mut runtime = RuntimeState::default();
    let accepted = runtime
        .accept(
            Snapshot::default(),
            StepRequest {
                state_revision: 0,
                state_patch: StatePatch::default(),
                comment: None,
                action: RequestedAction {
                    name: "finish".to_string(),
                    input: serde_json::json!({"message":"Implemented and tested."}),
                },
            },
            &[],
        )
        .expect("finish should be valid");
    let output = transition_output(
        "finish-1".to_string(),
        accepted,
        ObservationStatus::Success,
        "Implemented and tested.".to_string(),
    );

    let restored = snapshot(&[output]);
    assert_eq!(restored.state.status, ExecutionStatus::Done);
    assert_eq!(
        restored.final_message.as_deref(),
        Some("Implemented and tested.")
    );
}
