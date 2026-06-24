// Live proof: deepseek-code's query() now drives a persistent C++ memory-session
// (C++ owns history + memory + auto-compact). Run: DEEPSEEK_API_KEY=... bun run swap-smoke.ts
import { getOrCreateMemorySession } from "./src/services/agent/agentSession.ts";
import { query } from "./src/services/query.ts";
import type { AgentConfig, ProviderConfig } from "./src/types/index.ts";

const providerConfig: ProviderConfig = {
  type: "deepseek",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
};
const agentConfig: AgentConfig = {
  name: "code", displayName: "code", description: "",
  systemPrompt: "Be terse.", maxSteps: 5,
  permissions: { allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: true },
};

(async () => {
  const { session } = getOrCreateMemorySession({
    providerConfig, agentConfig, workingDir: process.cwd(),
    memoryDir: "/tmp/dsc-mem", maxContextTokens: 8000,
  });

  process.stdout.write("turn1: ");
  for await (const ev of query({
    session, config: agentConfig, userMessage: "Reply with exactly: pong",
    workingDir: process.cwd(), abortController: new AbortController(),
  })) {
    if (ev.type === "text-delta") process.stdout.write(ev.text);
    else if (ev.type === "finish") console.log(" [finish] usage:", ev.usage);
    else if (ev.type === "error") { console.error("\n[error]", ev.error); process.exit(1); }
  }
  console.log("MEMORY SESSION (C++ owns history) OK");
})().catch((e) => { console.error("FAIL:", String(e).split("\n")[0]); process.exit(1); });
