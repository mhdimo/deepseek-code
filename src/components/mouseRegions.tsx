/**
 * The click layer: a registry of clickable regions and one dispatcher.
 *
 * Components register their EXISTING root Box (a ref is layout-neutral) with
 * `useClickRegion`; `App` routes every left/right SGR press through
 * `createHitTester` before the transcript selection state machine sees it.
 * Activation is left-click-only: a right press on a hit region is still
 * claimed (it never leaks into the selection) but does nothing unless the
 * region opts in with `acceptRightClick` — right-click's one meaning in the
 * app is paste, which only the prompt region registers for.
 * Hit testing walks the yoga tree the same way `ChatPanel.getViewport()`
 * does — accumulating `getComputedTop()/getComputedLeft()` up to the root —
 * because stock ink gives us no DOM hit test (the reference forks ink for
 * its `hit-test.ts`; we do not).
 *
 * The same regions also carry an optional HOVER handler: a no-button pointer
 * motion report makes the row under the pointer the highlighted row — the
 * mouse and the arrow keys then drive one highlight. Hover never activates
 * (no handler decides, toggles, or runs anything), and `createHoverDispatcher`
 * is change-guarded so re-entering the same row does not re-render.
 *
 * Coordinates: 0-based screen cells in, 0-based region-local cells out.
 * The single 1-based → 0-based conversion happens in useMouseSelection.
 */
import React, { createContext, useContext, useEffect, useRef } from "react";
import { Box, type DOMElement } from "ink";

export interface RegionClickEvent {
  /** Region-local, 0-based, relative to the region rect's top-left. */
  row: number;
  col: number;
  /** 1 | 2 | 3, same 500ms window the selection hook uses. */
  clickCount: number;
  /** SGR button with modifiers stripped: 0 left, 2 right. */
  button: number;
  /** The region rect's computed size, so handlers can measure themselves. */
  width: number;
  height: number;
}

export interface RegionHoverEvent {
  /** Region-local, 0-based, relative to the region rect's top-left. */
  row: number;
  col: number;
  /** The region rect's computed size, so handlers can measure themselves. */
  width: number;
  height: number;
}

export interface ElementRect {
  top: number;
  left: number;
  width: number;
  height: number;
  /** Yoga-tree depth from the root; greater = more deeply nested. */
  depth: number;
}

export interface RegisteredMouseRegion {
  ref: React.RefObject<DOMElement | null>;
  handlerRef: React.RefObject<(ev: RegionClickEvent) => void>;
  enabledRef: React.RefObject<boolean>;
  /** Opt-in: right presses reach `handlerRef` instead of being swallowed. */
  acceptRightClickRef: React.RefObject<boolean>;
  /** Optional: null regions are transparent to the pointer (no highlight). */
  hoverHandlerRef: React.RefObject<((ev: RegionHoverEvent) => void) | null>;
  /** Optional: called when the pointer leaves this region — moved to another
   *  region or off every one — so a decoration can be cleared. Fires only
   *  for the region that was hovered, and only when the hover target
   *  actually changes. */
  hoverLeaveRef: React.RefObject<(() => void) | null>;
}

export interface MouseRegistry {
  regions: Map<number, RegisteredMouseRegion>;
  nextId: number;
}

export function createMouseRegistry(): MouseRegistry {
  return { regions: new Map(), nextId: 1 };
}

const MouseRegionContext = createContext<MouseRegistry | null>(null);

export function MouseRegionProvider({
  registry,
  children,
}: {
  registry: MouseRegistry;
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement(MouseRegionContext.Provider, { value: registry }, children);
}

/**
 * Absolute rect of a laid-out node. Width/height live on the node itself;
 * top/left accumulate up the tree (a yoga node's own top/left is relative to
 * its parent). An unlaid-out node returns undefined — a miss, not a throw.
 */
export function elementRect(el: DOMElement | null | undefined): ElementRect | undefined {
  const yoga = el?.yogaNode;
  if (!el || !yoga) return undefined;
  const width = yoga.getComputedWidth();
  const height = yoga.getComputedHeight();
  let top = 0;
  let left = 0;
  let depth = 0;
  let node: DOMElement | undefined = el;
  while (node?.yogaNode) {
    top += node.yogaNode.getComputedTop();
    left += node.yogaNode.getComputedLeft();
    depth++;
    node = node.parentNode as DOMElement | undefined;
  }
  return { top, left, width, height, depth };
}

/**
 * Resolve one press. Returns true when a region claimed it (the caller must
 * then swallow the press). Innermost region wins — greatest yoga depth; ties
 * go to the last registered.
 *
 * Activation is left-click-only. A right press over a region that did not
 * opt in (`acceptRightClick`) is still claimed — it must not fall through to
 * the transcript — but the handler is not called: the press does nothing.
 */
export function createHitTester(
  registry: MouseRegistry,
): (row: number, col: number, clickCount: number, button: number) => boolean {
  return (row, col, clickCount, button) => {
    if (button !== 0 && button !== 2) return false;
    let hit: RegisteredMouseRegion | null = null;
    let hitRect: ElementRect | null = null;
    for (const region of registry.regions.values()) {
      if (!region.enabledRef.current) continue;
      const rect = elementRect(region.ref.current);
      if (!rect) continue;
      if (row < rect.top || row >= rect.top + rect.height) continue;
      if (col < rect.left || col >= rect.left + rect.width) continue;
      if (!hitRect || rect.depth >= hitRect.depth) {
        hit = region;
        hitRect = rect;
      }
    }
    if (!hit || !hitRect) return false;
    // Claimed but inert: the right press is swallowed here so it cannot start
    // a transcript selection, and no handler runs.
    if (button === 2 && !hit.acceptRightClickRef.current) return true;
    try {
      hit.handlerRef.current({
        row: row - hitRect.top,
        col: col - hitRect.left,
        clickCount,
        button,
        width: hitRect.width,
        height: hitRect.height,
      });
    } catch {
      // A throwing handler must never kill the input loop.
      return false;
    }
    return true;
  };
}

/**
 * Resolve one pointer position for hover. Same innermost-wins walk as the hit
 * tester, but: regions without a hover handler and disabled regions are
 * transparent, nothing is ever "claimed" (the pointer is not a gesture), and
 * dispatch is change-guarded on `region:row` — one call per row transition,
 * so moving within a row (or across inert chrome) re-renders nothing. Leaving
 * every region resets the guard, so coming back to the same row re-fires.
 *
 * A transition away from a region (to another region, or off every one)
 * notifies the region left via `hoverLeaveRef`: a decoration that lives only
 * while the pointer is inside — the arrival pill's and the sticky row's
 * background — has no other way to learn the pointer is gone.
 */
export function createHoverDispatcher(
  registry: MouseRegistry,
): (row: number, col: number) => void {
  let lastKey: string | null = null;
  let lastId = -1;
  return (row, col) => {
    let hit: RegisteredMouseRegion | null = null;
    let hitId = -1;
    let hitRect: ElementRect | null = null;
    for (const [id, region] of registry.regions) {
      if (!region.hoverHandlerRef.current) continue;
      if (!region.enabledRef.current) continue;
      const rect = elementRect(region.ref.current);
      if (!rect) continue;
      if (row < rect.top || row >= rect.top + rect.height) continue;
      if (col < rect.left || col >= rect.left + rect.width) continue;
      if (!hitRect || rect.depth >= hitRect.depth) {
        hit = region;
        hitId = id;
        hitRect = rect;
      }
    }
    const key = hit ? `${hitId}:${row}` : null;
    if (key === lastKey) return;
    const leftId = lastId;
    lastKey = key;
    lastId = hitId;
    // The pointer left the region it was in — tell it before the new one is
    // told the pointer arrived, so exactly one region is ever "hovered".
    if (leftId !== -1 && leftId !== hitId) {
      try {
        registry.regions.get(leftId)?.hoverLeaveRef.current?.();
      } catch {
        // Same contract as the handlers: never kill the input loop.
      }
    }
    if (!hit || !hitRect) return;
    try {
      hit.hoverHandlerRef.current?.({
        row: row - hitRect.top,
        col: col - hitRect.left,
        width: hitRect.width,
        height: hitRect.height,
      });
    } catch {
      // A throwing handler must never kill the input loop.
    }
  };
}

/**
 * Register the calling component's root Box as a click region. Returns the
 * ref to attach. No provider → no-op (components stay usable in isolation).
 * `acceptRightClick` opts the region into right presses; without it a right
 * press is swallowed unhandled (activation is left-click-only). `onHover`
 * adds a pointer highlight — same region, and it never fires the click.
 */
export function useClickRegion(
  handler: (ev: RegionClickEvent) => void,
  enabled = true,
  acceptRightClick = false,
  onHover?: (ev: RegionHoverEvent) => void,
  onHoverLeave?: () => void,
): React.RefObject<DOMElement | null> {
  const registry = useContext(MouseRegionContext);
  const ref = useRef<DOMElement | null>(null);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const acceptRightClickRef = useRef(acceptRightClick);
  acceptRightClickRef.current = acceptRightClick;
  const hoverHandlerRef = useRef<((ev: RegionHoverEvent) => void) | null>(onHover ?? null);
  hoverHandlerRef.current = onHover ?? null;
  const hoverLeaveRef = useRef<(() => void) | null>(onHoverLeave ?? null);
  hoverLeaveRef.current = onHoverLeave ?? null;

  useEffect(() => {
    if (!registry) return;
    const id = registry.nextId++;
    registry.regions.set(id, {
      ref,
      handlerRef,
      enabledRef,
      acceptRightClickRef,
      hoverHandlerRef,
      hoverLeaveRef,
    });
    return () => {
      registry.regions.delete(id);
    };
  }, [registry]);

  return ref;
}

export interface ClickRegionBoxProps extends Omit<React.ComponentProps<typeof Box>, "ref"> {
  onClickRegion: (ev: RegionClickEvent) => void;
  clickEnabled?: boolean;
  /** Opt in to right presses; default false (left-click-only activation). */
  acceptRightClick?: boolean;
  /** Highlight-only pointer handler; never activates the row. */
  onHoverRegion?: (ev: RegionHoverEvent) => void;
  /** The pointer left this region; clears a hover-only decoration. */
  onHoverLeaveRegion?: () => void;
}

/**
 * The drop-in Box replacement for regions that are created inside a `.map`
 * (hooks cannot be called there). Attaching a ref changes no layout.
 */
export function ClickRegionBox({
  onClickRegion,
  clickEnabled = true,
  acceptRightClick = false,
  onHoverRegion,
  onHoverLeaveRegion,
  children,
  ...boxProps
}: ClickRegionBoxProps): React.ReactElement {
  const ref = useClickRegion(
    onClickRegion,
    clickEnabled,
    acceptRightClick,
    onHoverRegion,
    onHoverLeaveRegion,
  );
  return (
    <Box {...boxProps} ref={ref}>
      {children}
    </Box>
  );
}
