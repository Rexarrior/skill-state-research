#![cfg(not(target_os = "windows"))]
#![allow(clippy::unwrap_used)]

use core_test_support::responses::ResponsesRequest;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_function_call;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex_exec::test_codex_exec;
use serde_json::Value;
use serde_json::json;

fn declared_tool_names(request: &ResponsesRequest) -> Vec<String> {
    let body = request.body_json();
    let mut names = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    names.extend(
        request
            .input()
            .iter()
            .filter_map(|item| item["tools"].as_array())
            .flatten()
            .filter_map(|namespace| namespace["tools"].as_array())
            .flatten()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned)),
    );
    names
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_rebuilds_each_request_as_p_sigma_and_bounded_observations() -> anyhow::Result<()> {
    let test = test_codex_exec();
    let server = start_mock_server().await;
    let first_step = json!({
        "state_revision": 0,
        "state_patch": {
            "plan": ["Inspect the workspace", "Finish"],
            "facts": ["The benchmark marker is skill-state-v2"],
            "next_action": "Run a harmless shell probe"
        },
        "comment": "Capture one real action and its result.",
        "action": {
            "name": "exec_command",
            "input": {"cmd": "printf skill-state-v2"}
        }
    });
    let finish = json!({
        "state_revision": 1,
        "state_patch": {
            "completed": ["Inspected the workspace"],
            "next_action": ""
        },
        "comment": "The probe succeeded, so the experiment is complete.",
        "action": {
            "name": "finish",
            "input": {"message": "SKILL.state v2 integration succeeded."}
        }
    });
    let mock = mount_sse_sequence(
        &server,
        vec![
            sse(vec![
                ev_response_created("resp-1"),
                ev_function_call("step-1", "skill_step", &first_step.to_string()),
                ev_completed("resp-1"),
            ]),
            sse(vec![
                ev_response_created("resp-2"),
                ev_function_call("step-2", "skill_step", &finish.to_string()),
                ev_completed("resp-2"),
            ]),
        ],
    )
    .await;

    let output = test
        .cmd_with_server(&server)
        .env("CODEX_SKILL_STATE_MODE", "v2")
        .arg("--skip-git-repo-check")
        .arg("-s")
        .arg("danger-full-access")
        .arg("Implement the state protocol fixture")
        .output()?;

    let requests = mock.requests();
    assert!(
        output.status.success(),
        "codex exec failed; captured {} requests\nstdout:\n{}\nstderr:\n{}\nrequest bodies:\n{:#?}",
        requests.len(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        requests
            .iter()
            .map(core_test_support::responses::ResponsesRequest::body_json)
            .collect::<Vec<_>>()
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("SKILL.state v2 integration succeeded.")
    );
    assert_eq!(requests.len(), 2);
    for request in &requests {
        let input = request.input();
        assert_eq!(request.message_input_text_groups("user").len(), 1);
        assert!(request.message_input_text_groups("assistant").is_empty());
        let replayed_items = input
            .iter()
            .filter(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("function_call" | "function_call_output" | "reasoning")
                )
            })
            .collect::<Vec<_>>();
        assert!(
            replayed_items.is_empty(),
            "transcript must not be replayed: {replayed_items:#?}"
        );

        // Responses Lite transports tool declarations in an AdditionalTools
        // developer item instead of the top-level `tools` array.
        let declared_tools = input
            .iter()
            .filter_map(|item| item["tools"].as_array())
            .flatten()
            .filter_map(|namespace| namespace["tools"].as_array())
            .flatten()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(declared_tools, vec!["skill_step"]);
    }

    let first_prompt = requests[0].message_input_text_groups("user")[0].join("\n");
    assert!(first_prompt.contains("Instructions (P, immutable):"));
    assert!(first_prompt.contains("Implement the state protocol fixture"));
    assert!(first_prompt.contains("revision 0"));

    let second_prompt = requests[1].message_input_text_groups("user")[0].join("\n");
    assert!(second_prompt.contains("revision 1"));
    assert!(second_prompt.contains("The benchmark marker is skill-state-v2"));
    assert!(second_prompt.contains("exec_command"));
    assert!(second_prompt.contains("printf skill-state-v2"));
    assert!(second_prompt.contains("Capture one real action and its result."));
    assert!(second_prompt.contains("skill-state-v2"));
    let second_input: Vec<Value> = requests[1].input();
    assert!(second_input.iter().all(|item| {
        !matches!(
            item["type"].as_str(),
            Some("function_call" | "function_call_output" | "reasoning")
        )
    }));

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_baseline_mode_keeps_the_native_transcript_loop() -> anyhow::Result<()> {
    let test = test_codex_exec();
    let server = start_mock_server().await;
    let mock = mount_sse_sequence(
        &server,
        vec![
            sse(vec![
                ev_response_created("baseline-resp-1"),
                ev_function_call(
                    "baseline-step-1",
                    "exec_command",
                    &json!({"cmd": "pwd"}).to_string(),
                ),
                ev_completed("baseline-resp-1"),
            ]),
            sse(vec![
                ev_response_created("baseline-resp-2"),
                ev_assistant_message("baseline-message", "Baseline integration succeeded."),
                ev_completed("baseline-resp-2"),
            ]),
        ],
    )
    .await;

    let output = test
        .cmd_with_server(&server)
        .env("CODEX_SKILL_STATE_MODE", "baseline")
        .arg("--skip-git-repo-check")
        .arg("--dangerously-bypass-approvals-and-sandbox")
        .arg("Implement the baseline fixture")
        .output()?;

    assert!(
        output.status.success(),
        "codex exec failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    let first_tools = declared_tool_names(&requests[0]);
    assert!(first_tools.iter().all(|name| name != "skill_step"));
    let second_input: Vec<Value> = requests[1].input();
    assert!(
        second_input
            .iter()
            .any(|item| item["type"] == "function_call")
    );
    assert!(
        second_input
            .iter()
            .any(|item| item["type"] == "function_call_output")
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_defaults_to_the_native_transcript_loop() -> anyhow::Result<()> {
    let test = test_codex_exec();
    let server = start_mock_server().await;
    let mock = mount_sse_sequence(
        &server,
        vec![sse(vec![
            ev_response_created("default-resp"),
            ev_assistant_message("default-message", "Default baseline succeeded."),
            ev_completed("default-resp"),
        ])],
    )
    .await;

    let output = test
        .cmd_with_server(&server)
        .env_remove("CODEX_SKILL_STATE_MODE")
        .arg("--skip-git-repo-check")
        .arg("--dangerously-bypass-approvals-and-sandbox")
        .arg("Implement the default baseline fixture")
        .output()?;

    assert!(
        output.status.success(),
        "codex exec failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    let first_tools = declared_tool_names(&requests[0]);
    assert!(first_tools.iter().all(|name| name != "skill_step"));
    assert!(!requests[0].body_contains_text("Skill Execution State:"));
    assert!(!requests[0].body_contains_text("Recent Observations"));

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_paper_mode_sends_only_p_sigma_and_latest_observation() -> anyhow::Result<()> {
    let test = test_codex_exec();
    let expected_observation = test.cwd_path().display().to_string();
    let server = start_mock_server().await;
    let first_step = json!({
        "state_patch": {
            "facts": ["paper-state-marker"],
            "next_action": "Run a harmless probe"
        },
        "action": {
            "name": "exec_command",
            "input": {"cmd": "pwd"}
        }
    });
    let finish = json!({
        "state_patch": {
            "completed": ["Ran the probe"],
            "next_action": ""
        },
        "action": {
            "name": "finish",
            "input": {"message": "SKILL.state paper integration succeeded."}
        }
    });
    let mock = mount_sse_sequence(
        &server,
        vec![
            sse(vec![
                ev_response_created("paper-resp-1"),
                ev_function_call("paper-step-1", "skill_step", &first_step.to_string()),
                ev_completed("paper-resp-1"),
            ]),
            sse(vec![
                ev_response_created("paper-resp-2"),
                ev_function_call("paper-step-2", "skill_step", &finish.to_string()),
                ev_completed("paper-resp-2"),
            ]),
        ],
    )
    .await;

    let output = test
        .cmd_with_server(&server)
        .env("CODEX_SKILL_STATE_MODE", "paper")
        .arg("--skip-git-repo-check")
        .arg("--dangerously-bypass-approvals-and-sandbox")
        .arg("Implement the paper protocol fixture")
        .output()?;

    assert!(
        output.status.success(),
        "codex exec failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("SKILL.state paper integration succeeded.")
    );
    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    for request in &requests {
        assert_eq!(request.message_input_text_groups("user").len(), 1);
        assert!(request.message_input_text_groups("assistant").is_empty());
        let input: Vec<Value> = request.input();
        assert!(input.iter().all(|item| {
            !matches!(
                item["type"].as_str(),
                Some("function_call" | "function_call_output" | "reasoning")
            )
        }));
        let wrapper = input
            .iter()
            .filter_map(|item| item["tools"].as_array())
            .flatten()
            .filter_map(|namespace| namespace["tools"].as_array())
            .flatten()
            .find(|tool| tool["name"] == "skill_step")
            .expect("paper request must declare skill_step");
        let mut fields = wrapper["parameters"]["properties"]
            .as_object()
            .expect("skill_step properties")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        fields.sort_unstable();
        assert_eq!(fields, vec!["action", "state_patch"]);
        assert_eq!(
            wrapper["parameters"]["required"],
            json!(["state_patch", "action"])
        );
    }

    let first_prompt = requests[0].message_input_text_groups("user")[0].join("\n");
    assert!(first_prompt.contains("Skill Execution State:"));
    assert!(first_prompt.contains("Latest Observation:"));
    assert!(!first_prompt.contains("state_revision"));
    assert!(!first_prompt.contains("Recent Observations"));

    let second_prompt = requests[1].message_input_text_groups("user")[0].join("\n");
    assert!(second_prompt.contains("paper-state-marker"));
    assert!(
        second_prompt.contains(&expected_observation),
        "second paper prompt did not contain the latest observation:\n{second_prompt}"
    );
    assert!(!second_prompt.contains("\"cmd\":\"pwd\""));
    assert!(!second_prompt.contains("state_revision"));
    assert!(!second_prompt.contains("comment"));

    Ok(())
}
