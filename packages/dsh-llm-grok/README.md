# ns-dsh-llm-grok

> Development of this package has stopped. The maintained package is [@ngosangns/ns-bridge](https://www.npmjs.com/package/@ngosangns/ns-bridge).

The last npm release is `ns-dsh-llm-grok@0.1.1`. Install it with
`ns-bridge install dsh --profile <profile>`.

DeepSeek Harness (dsh) LLM adapter that adds Grok as a model provider. The
model list is the catalog file at
`~/.pi/agent/cache/ns-pi-provider/grok.models.json`, including a file past its
15-minute TTL. `ns-bridge models refresh grok` writes that file.
Streaming spawns the local `grok` CLI. There is no HTTP client in this package.

```yaml
- id: llm-grok
  name: 'ns-dsh-llm-grok'
  config:
    provider: grok
```

The CLI is asked for one turn (`--max-turns 1`) via `--prompt-file` and is not
given `--always-approve`, so tool calls come back to the harness. CLI tool
names (`read_file`, `list_dir`, `run_terminal_command`, `search_replace`,
`grep`, `write`) are rewritten onto harness tools before that, and those
calls are the harness tool cards. `list_dir` becomes `bash` `ls`. `glob`,
web search, and web fetch stay text: the harness has no tool for them, and
it would run a display-only call. Images are ACP blocks in the same
prompt file. The adapter advertises image input even when the catalog file
lists text only. Part of [ns-bridge](https://github.com/ngosangns/ns-bridge).
