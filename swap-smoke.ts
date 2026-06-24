// Live proof that deepseek-code's engine now runs on the C++ binding:
// registry (binding model) -> query() (binding streamText + event map) -> DeepSeek.
import { createModel } from "./src/services/provider/registry.ts";
import { query } from "./src/services/query.ts";
import type { AgentConfig } from "./src/types/index.ts";

const config: AgentConfig = {
  name: "code",
  displayName: "code",
  description: "",
  systemPrompt: "Be terse.",
  maxSteps: 5,
  permissions: { allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: true },
};

const model = createModel({
  type: "deepseek",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
});

(async () => {
  process.stdout.write("reply: ");
  for await (const ev of query({
    model,
    config,
    userMessage: "Reply with exactly one word: pong",
    history: [],
    workingDir: process.cwd(),
    abortController: new AbortController(),
  })) {
    if (ev.type === "text-delta") process.stdout.write(ev.text);
    else if (ev.type === "tool-call-start") console.log("\n[tool]", ev.toolName);
    else if (ev.type === "tool-call-result") console.log("\n[result]", ev.result.slice(0, 50));
    else if (ev.type === "finish") console.log("\n[finish] usage:", ev.usage);
    else if (ev.type === "error") { console.error("\n[error]", ev.error); process.exit(1); }
  }
  console.log("SWAP OK");
})().catch((e) => { console.error("FAIL:", String(e).split("\n")[0]); process.exit(1); });
