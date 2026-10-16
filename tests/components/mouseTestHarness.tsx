/**
 * Shared harness for click tests: a real ink app on fake TTY streams, driven
 * with real SGR mouse reports, with the click layer wired the way App wires
 * it (registry → hit tester → useMouseSelection intercept).
 *
 * mountWithMouse returns the registry so tests can also dispatch synthetic
 * RegionClickEvents to a specific registration — the right tool for
 * components whose on-screen row cannot be computed by hand.
 */
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createSanitizedStdin } from "../../src/components/inkStdin.js";
import {
  MouseRegionProvider,
  createHitTester,
  createHoverDispatcher,
  createMouseRegistry,
  type MouseRegistry,
} from "../../src/components/mouseRegions.js";
import {
  useMouseSelection,
  type ContentSelection,
} from "../../src/components/useMouseSelection.js";
import type { ChatPanelHandle } from "../../src/components/ChatPanel.js";

export class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

export class FakeStdout extends PassThrough {
  columns = 120;
  rows = 40;
  isTTY = true;
  getColorDepth() {
    return 1;
  }
  hasColors() {
    return false;
  }
}

export const ESC = "\x1b";
/** An SGR report exactly as a terminal writes it. */
export const report = (btn: number, col: number, row: number, final = "M") =>
  `${ESC}[<${btn};${col};${row}${final}`;

/** Pointer motion with no button held: the `?1003h` any-event report a
 *  terminal sends on every move (32|3 = motion bit, button 3 = none).
 *  `col`/`row` are 1-based, exactly as in `report`. */
export async function move(
  app: MountedMouseApp,
  col: number,
  row: number,
): Promise<void> {
  await write(app, report(35, col, row));
}

/** A chat handle with no content: unclaimed presses land on no text and the
 *  release copies nothing (so pbcopy is never spawned from a test). */
function stubChatRef(overrides: Partial<ChatPanelHandle> = {}): React.RefObject<ChatPanelHandle> {
  const handle = {
    getViewport: () => ({ topOffset: 0, scrollTop: 0, totalRows: 0, width: 100 }),
    getRowAt: () => undefined,
    copySelection: () => "",
    ...overrides,
  };
  return { current: handle } as unknown as React.RefObject<ChatPanelHandle>;
}

export interface MountedMouseApp {
  stdin: FakeStdin;
  frame: () => string;
  unmount: () => void;
  /** Every onChange the selection hook fired (null = cleared). */
  selections: Array<ContentSelection | null>;
  registry: MouseRegistry;
}

export function mountWithMouse(
  node: React.ReactElement,
  options: { chat?: Partial<ChatPanelHandle> } = {},
): MountedMouseApp {
  const registry = createMouseRegistry();
  const hitTester = createHitTester(registry);
  const hover = createHoverDispatcher(registry);
  const chatRef = stubChatRef(options.chat);
  const selections: Array<ContentSelection | null> = [];
  let out = "";
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });

  function Bridge({ children }: { children: React.ReactNode }) {
    useMouseSelection(chatRef, (sel) => selections.push(sel), hitTester, hover);
    return React.createElement(React.Fragment, null, children);
  }

  const app = render(
    React.createElement(
      MouseRegionProvider,
      { registry },
      React.createElement(Bridge, null, node),
    ),
    {
      stdin: createSanitizedStdin(stdin as unknown as NodeJS.ReadStream),
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  return { stdin, frame: () => out, unmount: app.unmount, selections, registry };
}

/** Write a chunk and let React commit before the next write. */
export async function write(app: MountedMouseApp, chunk: string): Promise<void> {
  app.stdin.write(chunk);
  await Bun.sleep(15);
}

/** Let effects from the last write settle. */
export async function settle(): Promise<void> {
  await Bun.sleep(30);
}
