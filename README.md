# opencode-rtk

[`rtk`](https://github.com/rtk-ai/rtk) (Rust Token Killer) is a filter for shell commands that reduces their output length (less LLM token consumption).

This OpenCode plugin automatically appends the `rtk` prefix to supported commands called by the agent. Requires no extra instructions for the LLM. However, this also means the agent is not aware of the proxy process, and cannot choose not to use `rtk` in case it fails (might fix in the future). Use with your own discretion.
