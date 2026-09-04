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
        mode: ProtocolMode::V2,
        state_revision: Some(revision),
        state_patch: serde_json::json!({
            "facts": ["workspace inspected"],
            "next_action": "run tests"
        }),
        comment: Some("Inspect once before editing.".to_string()),
        actions: vec![RequestedAction {
            name: action.to_string(),
            input: serde_json::json!({"command":"pwd"}),
        }],
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
    assert!(matches!(
        accepted.actions[0].action,
        ResolvedAction::Tool { .. }
    ));
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
        vec![ActionOutcome {
            status: BatchActionStatus::Success,
            result: "ok".to_string(),
        }],
    );

    let restored = snapshot(&[output], ProtocolMode::V2);
    assert_eq!(restored.revision, 1);
    assert_eq!(restored.state.facts, vec!["workspace inspected"]);
    assert_eq!(restored.observations.len(), 1);
    let Observation::Single(observation) = &restored.observations[0] else {
        panic!("v2 should persist a single observation")
    };
    assert_eq!(observation.action, "exec_command");
    assert_eq!(observation.result, "ok");
}

#[test]
fn accepts_large_action_but_bounds_observation_input() {
    let mut runtime = RuntimeState::default();
    let command = "x".repeat(MAX_OBSERVATION_INPUT_BYTES * 2);
    let accepted = runtime
        .accept(
            Snapshot::default(),
            StepRequest {
                actions: vec![RequestedAction {
                    name: "exec_command".to_string(),
                    input: serde_json::json!({"command": command}),
                }],
                ..request(0, "exec_command")
            },
            &[function_tool("exec_command")],
        )
        .expect("code-generation actions larger than the observation budget must execute");
    let output = transition_output(
        "call-large".to_string(),
        accepted,
        vec![ActionOutcome {
            status: BatchActionStatus::Success,
            result: "ok".to_string(),
        }],
    );

    let restored = snapshot(&[output], ProtocolMode::V2);
    let Observation::Single(observation) = &restored.observations[0] else {
        panic!("v2 should persist a single observation")
    };
    let input = &observation.input;
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
        ProtocolMode::V2,
        Snapshot::default(),
        "bad patch".to_string(),
    );

    let visible = provider_input(&[task, call, rejected], ProtocolMode::V2);
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
                mode: ProtocolMode::V2,
                state_revision: Some(0),
                state_patch: empty_patch(),
                comment: None,
                actions: vec![RequestedAction {
                    name: "finish".to_string(),
                    input: serde_json::json!({"message":"Implemented and tested."}),
                }],
            },
            &[],
        )
        .expect("finish should be valid");
    let output = transition_output(
        "finish-1".to_string(),
        accepted,
        vec![ActionOutcome {
            status: BatchActionStatus::Success,
            result: "Implemented and tested.".to_string(),
        }],
    );

    let restored = snapshot(&[output], ProtocolMode::V2);
    assert_eq!(restored.state.status, ExecutionStatus::Done);
    assert_eq!(
        restored.final_message.as_deref(),
        Some("Implemented and tested.")
    );
}

#[test]
fn paper_payload_has_exactly_patch_and_action() {
    let request = decode_request(
        &serde_json::json!({
            "state_patch": {"next_action": "inspect"},
            "action": {"name": "exec_command", "input": {"command": "pwd"}}
        })
        .to_string(),
        ProtocolMode::Paper,
    )
    .expect("paper payload should decode");
    assert_eq!(request.mode, ProtocolMode::Paper);
    assert_eq!(request.state_revision, None);
    assert_eq!(request.comment, None);

    let error = decode_request(
        &serde_json::json!({
            "state_revision": 0,
            "state_patch": {},
            "action": {"name": "exec_command", "input": {"command": "pwd"}}
        })
        .to_string(),
        ProtocolMode::Paper,
    )
    .expect_err("paper payload must reject v2 fields");
    assert!(error.contains("unknown field `state_revision`"));
}

#[test]
fn paper_prompt_exposes_only_latest_result() {
    let task = ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::InputText {
            text: "Implement the parser".to_string(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    };
    let mut runtime = RuntimeState::default();
    let first = runtime
        .accept(
            Snapshot::default(),
            StepRequest {
                mode: ProtocolMode::Paper,
                state_revision: None,
                state_patch: serde_json::json!({"facts":["first fact"]}),
                comment: None,
                actions: vec![RequestedAction {
                    name: "exec_command".to_string(),
                    input: serde_json::json!({"command":"first-command"}),
                }],
            },
            &[function_tool("exec_command")],
        )
        .expect("first paper step should be valid");
    let first = transition_output(
        "paper-1".to_string(),
        first,
        vec![ActionOutcome {
            status: BatchActionStatus::Success,
            result: "first-result".to_string(),
        }],
    );
    let persisted = snapshot(std::slice::from_ref(&first), ProtocolMode::Paper);
    let second = runtime
        .accept(
            persisted,
            StepRequest {
                mode: ProtocolMode::Paper,
                state_revision: None,
                state_patch: serde_json::json!({"facts":["first fact", "second fact"]}),
                comment: None,
                actions: vec![RequestedAction {
                    name: "exec_command".to_string(),
                    input: serde_json::json!({"command":"second-command"}),
                }],
            },
            &[function_tool("exec_command")],
        )
        .expect("second paper step should be valid");
    let second = transition_output(
        "paper-2".to_string(),
        second,
        vec![ActionOutcome {
            status: BatchActionStatus::Success,
            result: "second-result".to_string(),
        }],
    );

    let visible = provider_input(&[task, first, second], ProtocolMode::Paper);
    let ResponseItem::Message { content, .. } = &visible[0] else {
        panic!("paper prompt must be one message")
    };
    let ContentItem::InputText { text } = &content[0] else {
        panic!("paper prompt must be textual")
    };
    assert!(text.contains("Skill Execution State:"));
    assert!(text.contains("second fact"));
    assert!(text.contains("Latest Observation:\nsecond-result"));
    assert!(!text.contains("first-result"));
    assert!(!text.contains("first-command"));
    assert!(!text.contains("second-command"));
    assert!(!text.contains("state_revision"));
    assert!(!text.contains("comment"));
}

#[test]
fn paper_patch_supports_nested_null_deletion() {
    let state = ExecutionState {
        files: BTreeMap::from([
            ("keep.rs".to_string(), "keep".to_string()),
            ("remove.rs".to_string(), "remove".to_string()),
        ]),
        ..ExecutionState::default()
    };
    let mut runtime = RuntimeState::default();
    let accepted = runtime
        .accept(
            Snapshot {
                state,
                ..Snapshot::default()
            },
            StepRequest {
                mode: ProtocolMode::Paper,
                state_revision: None,
                state_patch: serde_json::json!({"files":{"remove.rs":null}}),
                comment: None,
                actions: vec![RequestedAction {
                    name: "exec_command".to_string(),
                    input: serde_json::json!({"command":"pwd"}),
                }],
            },
            &[function_tool("exec_command")],
        )
        .expect("nested deletion should preserve a valid state");
    assert_eq!(
        accepted.state.files,
        BTreeMap::from([("keep.rs".to_string(), "keep".to_string())])
    );
}

#[test]
fn v3_schema_uses_a_non_empty_unbounded_action_array() {
    let ToolSpec::Function(wrapper) =
        wrapper_spec(&[function_tool("exec_command")], ProtocolMode::V3)
    else {
        panic!("skill_step should be a function tool")
    };
    let actions = wrapper
        .parameters
        .properties
        .as_ref()
        .and_then(|properties| properties.get("actions"))
        .expect("v3 schema should expose actions");

    assert_eq!(actions.min_items, Some(1));
    assert_eq!(actions.items.is_some(), true);
    let serialized = serde_json::to_value(actions).expect("schema should serialize");
    assert_eq!(serialized.get("maxItems"), None);
    assert_eq!(
        wrapper.parameters.required,
        Some(vec![
            "state_revision".to_string(),
            "state_patch".to_string(),
            "actions".to_string(),
        ])
    );
}

#[test]
fn v3_accepts_an_unbounded_batch_and_persists_it_as_one_observation() {
    let actions = (0..12)
        .map(|index| RequestedAction {
            name: "exec_command".to_string(),
            input: serde_json::json!({"command": format!("command-{index}")}),
        })
        .collect::<Vec<_>>();
    let mut runtime = RuntimeState::default();
    let accepted = runtime
        .accept(
            Snapshot::default(),
            StepRequest {
                mode: ProtocolMode::V3,
                state_revision: Some(0),
                state_patch: serde_json::json!({"next_action":"inspect batch results"}),
                comment: Some("Run independent probes in order.".to_string()),
                actions,
            },
            &[function_tool("exec_command")],
        )
        .expect("v3 should not impose a batch length limit");
    assert_eq!(accepted.actions.len(), 12);
    let output = transition_output(
        "v3-batch".to_string(),
        accepted,
        (0..12)
            .map(|index| ActionOutcome {
                status: BatchActionStatus::Success,
                result: format!("result-{index}"),
            })
            .collect(),
    );

    let restored = snapshot(&[output], ProtocolMode::V3);
    assert_eq!(restored.revision, 1);
    assert_eq!(restored.observations.len(), 1);
    let Observation::Batch(observation) = &restored.observations[0] else {
        panic!("v3 should persist one batch observation")
    };
    assert_eq!(observation.actions.len(), 12);
    assert_eq!(observation.actions[0].action, "exec_command");
    assert_eq!(observation.actions[11].result, "result-11");
}

#[test]
fn v3_rejects_empty_batches_and_mixed_finish_batches() {
    let empty = decode_request(
        &serde_json::json!({
            "state_revision": 0,
            "state_patch": {},
            "actions": []
        })
        .to_string(),
        ProtocolMode::V3,
    )
    .expect_err("empty v3 actions should be rejected");
    assert!(empty.contains("non-empty array"));

    let mut runtime = RuntimeState::default();
    let mixed = runtime
        .accept(
            Snapshot::default(),
            StepRequest {
                mode: ProtocolMode::V3,
                state_revision: Some(0),
                state_patch: empty_patch(),
                comment: None,
                actions: vec![
                    RequestedAction {
                        name: "exec_command".to_string(),
                        input: serde_json::json!({"command":"pwd"}),
                    },
                    RequestedAction {
                        name: "finish".to_string(),
                        input: serde_json::json!({"message":"done"}),
                    },
                ],
            },
            &[function_tool("exec_command")],
        )
        .expect_err("finish cannot follow another action in the same batch");
    assert_eq!(mixed, "finish must be the sole action in a v3 batch");
}

#[test]
fn v3_prompt_explicitly_requires_sequential_execution() {
    let prompt = provider_input(
        &[ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: "Implement the parser".to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        ProtocolMode::V3,
    );
    let ResponseItem::Message { content, .. } = &prompt[0] else {
        panic!("v3 prompt should be a message")
    };
    let ContentItem::InputText { text } = &content[0] else {
        panic!("v3 prompt should be textual")
    };
    assert!(text.contains("strictly sequentially in listed order"));
    assert!(text.contains("There is no protocol limit on the number of actions"));
    assert!(text.contains("each batch is one observation"));
}
