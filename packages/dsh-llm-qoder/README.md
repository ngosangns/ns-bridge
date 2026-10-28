# ns-dsh-llm-qoder

DeepSeek Harness (dsh) LLM adapter that adds Qoder as a model provider. The
model list is the catalog file at
`~/.pi/agent/cache/ns-pi-provider/qoder.models.json`, including a file past
its TTL. `NS_QODER_CATALOG_CACHE_DIR` points a deployment elsewhere.
`ns-bridge models refresh qoder` writes that file. Streaming runs one
`@qoder-ai/qoder-agent-sdk` query per host turn. Auth is `qodercli login` or
`QODER_PERSONAL_ACCESS_TOKEN`. The host executes tools. This package does not.

```yaml
- id: llm-qoder
  name: 'ns-dsh-llm-qoder'
  config:
    provider: qoder
```

Part of [ns-bridge](https://github.com/ngosangns/ns-bridge).
