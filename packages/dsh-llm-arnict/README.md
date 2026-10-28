# ns-dsh-llm-arnict

DeepSeek Harness (dsh) LLM adapter that adds Arnict as a model provider. The
model list is the catalog file at
`~/.pi/agent/cache/ns-pi-provider/arnict.models.json`, including a file past
its TTL; `NS_ARNICT_CATALOG_CACHE_DIR` points a deployment elsewhere.
`ns-bridge models refresh arnict` writes that file. Streaming posts one
`/v1/chat/completions` call to `api.arnict.com` with the stored API key
(`ARNICT_API_KEY` or `~/.ns-bridge/arnict.json`). There is no other HTTP
client in this package.

```yaml
- id: llm-arnict
  name: 'ns-dsh-llm-arnict'
  config:
    provider: arnict
```

GLM 5.3 models resolve in the 400,000-token standard window so the Harness
compacts near 383,616 tokens, while the usage ledger records the native
1,048,576-token window Arnict serves. Tool calls come back to the harness as
tool cards. Part of [ns-bridge](https://github.com/ngosangns/ns-bridge).
