/**
 * The window a pointer-driven selection shows.
 *
 * Pickers derive their scroll window from the selection (centred, for parity
 * with the keyboard), which is right for a keystroke and wrong for a hover:
 * recentring on a pointer move slides the list out from under the cursor, so
 * the row that lights up is no longer the row being pointed at. A hover pins
 * the window instead — and the pin lapses the moment anything else moves the
 * selection, so the keyboard keeps its own behaviour exactly.
 */
import { describe, expect, test } from "bun:test";
import { pinnedWindowStart } from "../../src/components/hoverPin.js";

describe("pinnedWindowStart", () => {
  test("uses the automatic window when the pointer is not what moved the selection", () => {
    expect(
      pinnedWindowStart({ pinned: null, selectedIndex: 10, count: 20, size: 6, auto: 7 }),
    ).toBe(7);
  });

  test("a keyboard move away from the pinned row releases the pin", () => {
    expect(
      pinnedWindowStart({
        pinned: { index: 3, start: 0 },
        selectedIndex: 4,
        count: 20,
        size: 6,
        auto: 1,
      }),
    ).toBe(1);
  });

  test("keeps the pinned window while the selection is still the pointed row", () => {
    expect(
      pinnedWindowStart({
        pinned: { index: 3, start: 0 },
        selectedIndex: 3,
        count: 20,
        size: 6,
        auto: 1,
      }),
    ).toBe(0);
  });

  test("a pinned window is still clamped so the selection stays visible", () => {
    // Pinned at the top, but the (hovered) selection is near the bottom of the
    // list: the window slides just enough to keep the highlight on screen.
    expect(
      pinnedWindowStart({
        pinned: { index: 9, start: 0 },
        selectedIndex: 9,
        count: 20,
        size: 6,
        auto: 6,
      }),
    ).toBe(4);
    // …and never past the last full window.
    expect(
      pinnedWindowStart({
        pinned: { index: 19, start: 19 },
        selectedIndex: 19,
        count: 20,
        size: 6,
        auto: 14,
      }),
    ).toBe(14);
    // A window larger than the list always starts at 0.
    expect(
      pinnedWindowStart({
        pinned: { index: 0, start: 5 },
        selectedIndex: 0,
        count: 3,
        size: 6,
        auto: 0,
      }),
    ).toBe(0);
  });

  test("an automatic window passes through untouched", () => {
    // The keyboard's centred window already shows the selection — the clamps
    // must not perturb it.
    for (const selected of [0, 1, 5, 9, 10, 19]) {
      const auto = Math.max(0, Math.min(selected - 3, 14));
      expect(
        pinnedWindowStart({ pinned: null, selectedIndex: selected, count: 20, size: 6, auto }),
      ).toBe(auto);
    }
  });
});
