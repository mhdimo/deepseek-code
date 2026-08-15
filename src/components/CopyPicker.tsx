import React, { useRef, useState } from "react";
import { useInput } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import { loadSettings, saveSettings } from "../state/storage.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import stringWidth from "string-width";
import type { Message } from "../types/index.js";

export interface CopyPickerProps {
  messages: Message[];
  /** Receives the chosen content (full response or a fenced code block). */
  onCopy: (content: string) => void;
  /** Optional — reports a "w" write-to-file result so App can display it. */
  onWrite?: (result: string) => void;
  onClose: () => void;
}

/** Scratch dir for the copy fallback + "w" write shortcut. */
const COPY_DIR = join(homedir(), ".cache", "deepseek-code", "copy");
const RESPONSE_FILENAME = "response.md";
const MAX_LOOKBACK = 20;

export interface CodeBlock {
  code: string;
  lang?: string;
}

/** Extract ```-fenced code blocks (with language) from markdown text. */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(markdown)) !== null) {
    blocks.push({
      code: (match[2] ?? "").replace(/\n$/, ""),
      lang: match[1]?.trim() || undefined,
    });
  }
  return blocks;
}

/** Sanitized extension for a fence language ("python" → ".python", plaintext → ".txt"). */
export function fileExtension(lang: string | undefined): string {
  if (lang) {
    // Sanitize to prevent path traversal (a ```../../etc/passwd fence).
    const sanitized = lang.replace(/[^a-zA-Z0-9]/g, "");
    if (sanitized && sanitized !== "plaintext") return `.${sanitized}`;
  }
  return ".txt";
}

/** Truncate the first line to `maxLen` display columns, appending an ellipsis. */
export function truncateLine(text: string, maxLen: number): string {
  const firstLine = text.split("\n")[0] ?? "";
  if (stringWidth(firstLine) <= maxLen) return firstLine;
  let result = "";
  let width = 0;
  const targetWidth = maxLen - 1;
  for (const char of firstLine) {
    const charWidth = stringWidth(char);
    if (width + charWidth > targetWidth) break;
    result += char;
    width += charWidth;
  }
  return `${result}…`;
}

/** Write text to the copy scratch dir; returns the absolute path. */
async function writeToFile(text: string, filename: string): Promise<string> {
  mkdirSync(COPY_DIR, { recursive: true });
  const filePath = join(COPY_DIR, filename);
  await Bun.write(filePath, text);
  return filePath;
}

interface ContentSelection {
  text: string;
  filename: string;
}

/**
 * Interactive /copy picker (Claude Code CopyDialog equivalent). Two stages:
 * 1) choose an assistant response (numbering matches `/copy N`), then 2)
 * choose "Full response", one option per fenced code block, or "Always copy
 * full response" (persists copyFullResponse). "w" writes the focused
 * option's content to the copy scratch dir.
 */
export default function CopyPicker({ messages, onCopy, onWrite, onClose }: CopyPickerProps): React.ReactElement {
  const [stage, setStage] = useState<1 | 2>(1);
  const [chosenIndex, setChosenIndex] = useState(0);
  const focusedRef = useRef<string>("1");

  const assistantMessages = messages.filter((m) => m.role === "assistant" && !m.isError && m.content);
  const newestFirst = [...assistantMessages].reverse();

  const messageOptions = newestFirst.slice(0, MAX_LOOKBACK).map((message, i) => {
    const lineCount = message.content.split("\n").length;
    return {
      label: truncateLine(message.content, 60),
      value: String(i + 1),
      description: `${lineCount} line${lineCount === 1 ? "" : "s"} · ${message.content.length.toLocaleString()} chars`,
    };
  });

  const fullText = newestFirst[chosenIndex]?.content ?? "";
  const codeBlocks = extractCodeBlocks(fullText);

  const contentOptions = [
    {
      label: "Full response",
      value: "full",
      description: `${fullText.length} chars, ${fullText.split("\n").length} lines`,
    },
    ...codeBlocks.map((block, i) => {
      const blockLines = block.code.split("\n").length;
      return {
        label: truncateLine(block.code, 60),
        value: `block:${i}`,
        description:
          [block.lang, blockLines > 1 ? `${blockLines} lines` : undefined].filter(Boolean).join(", ") || undefined,
      };
    }),
    {
      label: "Always copy full response",
      value: "always",
      description: "Skip this picker in the future (revert via /config)",
    },
  ];

  const getSelectionContent = (selected: string): ContentSelection => {
    if (selected === "full" || selected === "always") {
      return { text: fullText, filename: RESPONSE_FILENAME };
    }
    const block = codeBlocks[Number(selected.slice("block:".length))];
    if (!block) return { text: "", filename: "copy.txt" };
    return { text: block.code, filename: `copy${fileExtension(block.lang)}` };
  };

  const handleSelect = (selected: string) => {
    focusedRef.current = selected;
    const content = getSelectionContent(selected);
    if (selected === "always") {
      try {
        if (!loadSettings().copyFullResponse) saveSettings({ copyFullResponse: true });
      } catch {}
    }
    onCopy(content.text);
  };

  const handleWrite = async (selected: string) => {
    let text: string;
    let filename: string;
    if (stage === 1) {
      const message = newestFirst[Number(selected) - 1];
      if (!message) return;
      text = message.content;
      filename = RESPONSE_FILENAME;
    } else {
      const content = getSelectionContent(selected);
      text = content.text;
      filename = content.filename;
    }
    try {
      const filePath = await writeToFile(text, filename);
      if (onWrite) onWrite(`Written to ${filePath}`);
      else onClose();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (onWrite) onWrite(`Failed to write file: ${detail}`);
      else onClose();
    }
  };

  // "w" writes the focused option's content to the copy scratch dir.
  useInput((input, key) => {
    if (key.ctrl || key.escape || key.return) return;
    if (input === "w") void handleWrite(focusedRef.current);
  });

  const selectMessage = (value: string) => {
    const index = Number(value) - 1;
    if (!newestFirst[index]) return;
    setChosenIndex(index);
    focusedRef.current = "full";
    setStage(2);
  };

  return (
    <Dialog
      title="Copy response"
      subtitle={
        stage === 1
          ? "Copy an assistant response to the clipboard"
          : `Response [${chosenIndex + 1}] — full text or a code block`
      }
      onCancel={onClose}
      footer={
        stage === 1
          ? "↑↓ to choose · enter to copy · esc to cancel"
          : "↑↓ to choose · enter to copy · w to write to file · esc to go back"
      }
    >
      <Select
        key={stage}
        options={stage === 1 ? messageOptions : contentOptions}
        defaultValue={stage === 1 ? "1" : "full"}
        enableNumberKeys
        visibleOptionCount={8}
        onFocus={(focused) => {
          focusedRef.current = focused;
        }}
        onChange={stage === 1 ? selectMessage : handleSelect}
        onCancel={stage === 2 ? () => setStage(1) : onClose}
      />
    </Dialog>
  );
}
