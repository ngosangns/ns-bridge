# ns-dsh-llm-grok

> Development of this package has stopped. The maintained package is [@ngosangns/ns-bridge](https://www.npmjs.com/package/@ngosangns/ns-bridge).

DeepSeek Harness (dsh) LLM adapter that adds Grok as a model provider. The
model list is the catalog file Pi already keeps at
`~/.pi/agent/cache/ns-pi-provider/grok.models.json`, including a file past its
15-minute TTL. Streaming spawns the local `grok` CLI. There is no HTTP client
in this package.

```yaml
- id: llm-grok
  name: 'ns-dsh-llm-grok'
  config:
    provider: grok
```

The CLI is asked for one turn (`--max-turns 1`) and is not given
`--always-approve`, so tool calls come back to the harness. Part of
[ns-bridge](https://github.com/ngosangns/ns-bridge). Development of this package has stopped.
