/**
 * A language server that is exactly as obedient as a test needs it to be.
 *
 * The point of a real subprocess rather than a stubbed client is that the
 * things worth testing here are the wire facts: which notification is sent,
 * what `version` it carries, and whether a server that is not running is
 * contacted at all. A stub can only confirm what the manager *believes* it
 * sent. This one records what actually arrived.
 *
 * Every notification is appended as one JSON line to `FAKE_LSP_LOG`, so a test
 * asserts on the observed sequence rather than on internal state. Diagnostics
 * are derived from the text the server was given — every line containing
 * `BROKEN` becomes an error — which makes them a function of the document, so
 * a stale buffer shows up as diagnostics for text the file no longer contains.
 */
import { appendFileSync } from "fs";

const logPath = process.env.FAKE_LSP_LOG;

interface LoggedEvent {
  event: string;
  uri?: string;
  version?: number;
  text?: string;
}

function record(event: LoggedEvent): void {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function send(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
}

const DIAGNOSTIC_CODE = 9001;

function diagnosticsFor(uri: string, text: string): unknown[] {
  const out: unknown[] = [];
  text.split("\n").forEach((line, index) => {
    const at = line.indexOf("BROKEN");
    if (at === -1) return;
    out.push({
      range: {
        start: { line: index, character: at },
        end: { line: index, character: at + "BROKEN".length },
      },
      severity: 1,
      source: "fake-lsp",
      code: DIAGNOSTIC_CODE,
      message: "fake: BROKEN on this line",
    });
  });
  return out;
}

function publishDiagnostics(uri: string, text: string): void {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: diagnosticsFor(uri, text) },
  });
}

let buffer = Buffer.alloc(0);

function handle(message: {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}): void {
  const params = message.params ?? {};

  if (message.id !== undefined) {
    switch (message.method) {
      case "initialize":
        send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
        return;
      case "shutdown":
        send({ jsonrpc: "2.0", id: message.id, result: null });
        return;
      default:
        // Unknown request: answer rather than hang, so a test that asks for
        // something unexpected fails on its assertion and not on a timeout.
        send({ jsonrpc: "2.0", id: message.id, result: null });
        return;
    }
  }

  const doc = params.textDocument as { uri?: string; version?: number } | undefined;
  const uri = doc?.uri;

  switch (message.method) {
    case "textDocument/didOpen": {
      const text = (params.textDocument as { text?: string } | undefined)?.text ?? "";
      record({ event: "didOpen", uri, version: doc?.version, text });
      publishDiagnostics(uri!, text);
      return;
    }
    case "textDocument/didChange": {
      const changes = params.contentChanges as Array<{ text?: string }> | undefined;
      const text = changes?.[0]?.text ?? "";
      record({ event: "didChange", uri, version: doc?.version, text });
      publishDiagnostics(uri!, text);
      return;
    }
    case "textDocument/didClose":
      record({ event: "didClose", uri });
      return;
    case "textDocument/didSave":
      record({ event: "didSave", uri });
      return;
    case "exit":
      process.exit(0);
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf-8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
    buffer = buffer.subarray(bodyStart + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // Malformed frame: drop it. A test asserting on the log will see the
      // gap, which is more useful than a crash that looks like a spawn error.
    }
  }
});

process.stdin.on("end", () => process.exit(0));
