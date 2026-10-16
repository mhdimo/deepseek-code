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
 * Register the calling component's root Box as a click region. Returns the
 * ref to attach. No provider → no-op (components stay usable in isolation).
 * `acceptRightClick` opts the region into right presses; without it a right
 * press is swallowed unhandled (activation is left-click-only).
 */
export function useClickRegion(
  handler: (ev: RegionClickEvent) => void,
  enabled = true,
  acceptRightClick = false,
): React.RefObject<DOMElement | null> {
  const registry = useContext(MouseRegionContext);
  const ref = useRef<DOMElement | null>(null);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const acceptRightClickRef = useRef(acceptRightClick);
  acceptRightClickRef.current = acceptRightClick;

  useEffect(() => {
    if (!registry) return;
    const id = registry.nextId++;
    registry.regions.set(id, { ref, handlerRef, enabledRef, acceptRightClickRef });
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
}

/**
 * The drop-in Box replacement for regions that are created inside a `.map`
 * (hooks cannot be called there). Attaching a ref changes no layout.
 */
export function ClickRegionBox({
  onClickRegion,
  clickEnabled = true,
  acceptRightClick = false,
  children,
  ...boxProps
}: ClickRegionBoxProps): React.ReactElement {
  const ref = useClickRegion(onClickRegion, clickEnabled, acceptRightClick);
  return (
    <Box {...boxProps} ref={ref}>
      {children}
    </Box>
  );
}
