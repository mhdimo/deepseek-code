# Provider architecture

z-code uses Vercel AI SDK and an adapter registry in [src/provider/registry.ts](../src/provider/registry.ts).

## Design goals

- Keep provider logic isolated from agent logic
- Support multiple vendors with one runtime abstraction
- Make OpenAI-compatible endpoints first-class
- Allow future extension without rewriting the agent loop

---

## Supported provider types

`ProviderType` currently includes:

- `openai` — means **OpenAI-compatible** endpoint
- `anthropic`

### OpenAI-compatible

The `openai` adapter works with:

- OpenAI
- Z.AI/GLM
- DeepSeek
- Groq
- Together
- Mistral
- self-hosted OpenAI-compatible gateways

z-code forces Chat Completions via `provider.chat(modelId)` for broad compatibility.

---

## How modularity works

`registry.ts` defines:

- `ProviderAdapter` interface
- `PROVIDER_ADAPTERS` map keyed by provider type
- `createModel(config)` lookup + delegation
- `registerProviderAdapter(type, adapter)` extension point

This means provider-specific behavior is now plug-in style.

---

## Add a new provider adapter (current model)

1. Implement a `ProviderAdapter` (`createModel(config) => LanguageModel`).
2. Register it in the adapter map (or via `registerProviderAdapter`).
3. Add config/env/docs for users.

If you need brand-new provider types beyond current union values, extend `ProviderType` in [src/core/types.ts](../src/core/types.ts).

---

## Configuration examples

### OpenAI

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": "env:OPENAI_API_KEY"
}
```

### Z.AI / GLM

```json
{
  "provider": "openai",
  "model": "glm-4.7",
  "apiKey": "env:GLM_API_KEY",
  "baseURL": "https://api.z.ai/api/coding/paas/v4"
}
```

### Anthropic

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "apiKey": "env:ANTHROPIC_API_KEY"
}
```
