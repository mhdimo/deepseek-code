/**
 * The click layer's core: rect arithmetic over the yoga tree, region
 * registration, and press resolution (innermost wins).
 *
 * No terminal here — the yoga nodes are stubs whose getters return fixed
 * numbers, so the geometry under test is exactly the numbers in the test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { Text, render } from "ink";
import type { DOMElement } from "ink";
import {
  ClickRegionBox,
  MouseRegionProvider,
  createHitTester,
  createMouseRegistry,
  elementRect,
  type RegionClickEvent,
  type RegisteredMouseRegion,
} from "../../src/components/mouseRegions.js";

type FakeNode = {
  yogaNode: {
    getComputedTop: () => number;
    getComputedLeft: () => number;
    getComputedWidth: () => number;
    getComputedHeight: () => number;
  };
  parentNode?: FakeNode;
};

function fakeNode(
  box: { top: number; left: number; width: number; height: number },
  parent?: FakeNode,
): FakeNode {
  return {
    yogaNode: {
      getComputedTop: () => box.top,
      getComputedLeft: () => box.left,
      getComputedWidth: () => box.width,
      getComputedHeight: () => box.height,
    },
    parentNode: parent,
  };
}

const asElement = (node: FakeNode): DOMElement => node as unknown as DOMElement;

function register(
  registry: ReturnType<typeof createMouseRegistry>,
  node: FakeNode | null,
  handler: (ev: RegionClickEvent) => void,
  enabled = true,
): void {
  const id = registry.nextId++;
  registry.regions.set(id, {
    ref: { current: node ? asElement(node) : null },
    handlerRef: { current: handler },
    enabledRef: { current: enabled },
  } as RegisteredMouseRegion);
}

describe("elementRect", () => {
  test("accumulates parent offsets and counts depth", () => {
    const root = fakeNode({ top: 2, left: 3, width: 100, height: 40 });
    const child = fakeNode({ top: 1, left: 4, width: 20, height: 3 }, root);
    const leaf = fakeNode({ top: 0, left: 1, width: 4, height: 1 }, child);
    expect(elementRect(asElement(leaf))).toEqual({
      top: 3,
      left: 8,
      width: 4,
      height: 1,
      depth: 3,
    });
  });

  test("an unlaid-out node is a miss, not a throw", () => {
    expect(elementRect(undefined)).toBeUndefined();
    expect(elementRect(null)).toBeUndefined();
    expect(elementRect({} as DOMElement)).toBeUndefined();
  });
});

describe("createHitTester", () => {
  test("innermost region wins and receives region-local coordinates", () => {
    const registry = createMouseRegistry();
    const calls: Array<[string, RegionClickEvent]> = [];
    // Outer: rows 0-4, cols 0-9. Inner: row 2, cols 2-4.
    register(registry, fakeNode({ top: 0, left: 0, width: 10, height: 5 }), (ev) =>
      calls.push(["outer", ev]),
    );
    register(registry, fakeNode({ top: 2, left: 2, width: 3, height: 1 }), (ev) =>
      calls.push(["inner", ev]),
    );
    const hit = createHitTester(registry);

    expect(hit(2, 3, 1, 0)).toBe(true);
    expect(calls).toEqual([
      ["inner", { row: 0, col: 1, clickCount: 1, button: 0, width: 3, height: 1 }],
    ]);

    expect(hit(4, 9, 1, 0)).toBe(true);
    expect(calls[1]![0]).toBe("outer");
    expect(calls[1]![1]).toMatchObject({ row: 4, col: 9 });

    expect(hit(9, 9, 1, 0)).toBe(false);
  });

  test("a disabled region is skipped; the enabled ancestor under it wins", () => {
    const registry = createMouseRegistry();
    const calls: string[] = [];
    register(registry, fakeNode({ top: 0, left: 0, width: 10, height: 5 }), () =>
      calls.push("outer"),
    );
    register(registry, fakeNode({ top: 1, left: 1, width: 3, height: 1 }), () =>
      calls.push("inner"),
    false);
    expect(createHitTester(registry)(1, 1, 1, 0)).toBe(true);
    expect(calls).toEqual(["outer"]);
  });

  test("unmounted regions (null ref) are skipped", () => {
    const registry = createMouseRegistry();
    register(registry, null, () => {});
    expect(createHitTester(registry)(0, 0, 1, 0)).toBe(false);
  });

  test("passes clickCount and button through; refuses other buttons", () => {
    const registry = createMouseRegistry();
    const events: RegionClickEvent[] = [];
    register(registry, fakeNode({ top: 0, left: 0, width: 5, height: 1 }), (ev) =>
      events.push(ev),
    );
    const hit = createHitTester(registry);
    expect(hit(0, 0, 2, 2)).toBe(true);
    expect(events[0]).toMatchObject({ clickCount: 2, button: 2 });
    for (const btn of [1, 3, 32, 64]) expect(hit(0, 0, 1, btn)).toBe(false);
  });

  test("a throwing handler is a miss, not a crash", () => {
    const registry = createMouseRegistry();
    register(registry, fakeNode({ top: 0, left: 0, width: 5, height: 1 }), () => {
      throw new Error("boom");
    });
    expect(createHitTester(registry)(0, 0, 1, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contributed components: registration follows mount, refs, and enabled
// ---------------------------------------------------------------------------

let mounted: { unmount: () => void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

test("ClickRegionBox registers on mount, disappears on unmount, honours enabled", async () => {
  const registry = createMouseRegistry();
  const hit = createHitTester(registry);
  const events: RegionClickEvent[] = [];
  const app = render(
    React.createElement(
      MouseRegionProvider,
      { registry },
      React.createElement(
        ClickRegionBox,
        {
          onClickRegion: (ev: RegionClickEvent) => events.push(ev),
        },
        React.createElement(Text, null, "x"),
      ),
    ),
    { patchConsole: false },
  );
  mounted = app;
  await Bun.sleep(5);
  expect(registry.regions.size).toBe(1);
  expect(hit(0, 0, 1, 0)).toBe(true);
  expect(events.length).toBe(1);

  app.unmount();
  mounted = null;
  await Bun.sleep(5);
  expect(registry.regions.size).toBe(0);
  expect(hit(0, 0, 1, 0)).toBe(false);
});

test("ClickRegionBox without a provider renders and no-ops", async () => {
  const events: RegionClickEvent[] = [];
  const app = render(
    React.createElement(ClickRegionBox, {
      onClickRegion: (ev: RegionClickEvent) => events.push(ev),
    }),
    { patchConsole: false },
  );
  mounted = app;
  await Bun.sleep(5);
  expect(events.length).toBe(0);
});
