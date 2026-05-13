# opencode-rtk

[`rtk`](https://github.com/rtk-ai/rtk) (Rust Token Killer) proxies and filters shell commands to condense their output (less LLM token consumption).

Apparently, you have to get `rtk` installed and available in `$PATH`.

This OpenCode plugin automatically appends the `rtk` prefix to supported commands called by the agent. Requires no extra instructions for the LLM. This plugin has built-in `bash` and `pwsh` syntax analysis. Complex, piped, nested commands can be handled gracefully.

However, this also means the agent is not aware of the proxying, and cannot choose not to use `rtk` in case it fails (might fix in the future). Use with your own discretion. According to observation, most mid to large-sized models will be smart enough to call the original command from `/usr/bin` (or its real absolute path) if `rtk` failed.

## Installation

1. Install [`rtk`](https://github.com/rtk-ai/rtk)
2. Add the following (or similar) to your OpenCode config file:

   ```jsonc
   // opencode.json
   
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       "@4rcadia/opencode-rtk@latest"
     ]
   }
   ```
