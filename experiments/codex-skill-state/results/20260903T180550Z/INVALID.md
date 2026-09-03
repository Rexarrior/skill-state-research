# Invalid harness preflight

This suite is not benchmark evidence. All ten CLI processes exited during argument parsing before any model sample was
made (`samples=0`, `input_tokens=0`). The initial runner combined `--approve-for-me` with an explicit sandbox; the
installed baseline did not support the flag and the research CLI rejected that combination.

The raw stderr and zero-usage summaries are retained as an audit trail. A follow-up preflight established that the
managed host policy forces file approvals which non-interactive `codex exec` cannot service. The runner was corrected to
use the same explicit non-interactive approval/sandbox bypass in both modes, with each model confined by task instruction
to a fresh temporary project directory. Results must come from a later suite.
