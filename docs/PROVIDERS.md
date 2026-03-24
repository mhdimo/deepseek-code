# Provider architecture

DeepSeek Code uses Vercel AI SDK with a DeepSeek adapter in [src/provider/registry.ts](../src/provider/registry.ts).

## Design

- DeepSeek uses an OpenAI-compatible API endpoint
- The adapter handles authentication and request formatting
- Simple, focused implementation for DeepSeek only

---

## Supported models

- `deepseek-chat` — General-purpose coding assistant
- `deepseek-reasoner` — Advanced reasoning with extended thinking

---

## Configuration

### Basic setup

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiKey": "env:DEEPSEEK_API_KEY"
}
```

### With custom endpoint (proxy)

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiKey": "env:DEEPSEEK_API_KEY",
  "baseURL": "https://your-proxy.com/v1"
}
```

### Using DeepSeek Reasoner

```json
{
  "provider": "deepseek",
  "model": "deepseek-reasoner",
  "apiKey": "env:DEEPSEEK_API_KEY"
}
```

---

## Environment variables

- `DEEPSEEK_API_KEY` — Your DeepSeek API key
- `DEEPSEEK_MODEL` — Model to use (default: `deepseek-chat`)
- `DEEPSEEK_BASE_URL` — Custom endpoint URL (optional)

---

## How it works

`registry.ts` defines:

- `createModel(config)` — Creates an AI SDK LanguageModel
- Uses `@ai-sdk/openai` with DeepSeek's base URL
- Forces Chat Completions API via `provider.chat(modelId)`
