import { expect, test } from "bun:test";

import { TurnUsage } from "./contextUsage.js";

/* What the context bar is supposed to measure is the size of the request the
   engine is about to send — the conversation as it now stands. The engine
   reports usage per finish event, and the two kinds of finish carry different
   things: a mid-turn one (`finishReason: "tool_calls"`, the model asking for
   tools) carries that step's own usage, while the terminal one carries the
   turn's total. Measured against the binding's mock provider, a two-step turn
   reports input 20 then input 27 — 27 being 20 + the second call's 7.

   So the number the bar wants is the total minus the steps: what the last call
   actually sent, which is the whole conversation. Output is not in it at all —
   the model's own words are not part of the window they were written into. */

test("a single-step turn's context is that call's own input", () => {
  const turn = new TurnUsage();
  expect(turn.finish(1_000)).toBe(1_000);
  expect(turn.contextTokens).toBe(1_000);
});

test("a tool-using turn's context is the last call's input, not the total", () => {
  const turn = new TurnUsage();
  turn.step(20); // the model asked for a tool; the turn continues
  expect(turn.finish(27)).toBe(7); // 27 total − 20 already spent on step one
  expect(turn.contextTokens).toBe(7);
});

test("every earlier step comes off, however many there were", () => {
  const turn = new TurnUsage();
  turn.step(20);
  turn.step(30);
  turn.step(45);
  expect(turn.finish(130)).toBe(35); // 130 total − 95 spent on the three steps
});

test("a total that cannot be trusted falls back to the last step's own input", () => {
  // The steps are the only figure with a single meaning: a step is always one
  // call. A total below their sum means the engine and this arithmetic
  // disagree, and the last step's own input is still the right answer.
  const turn = new TurnUsage();
  turn.step(20);
  turn.step(30);
  expect(turn.finish(10)).toBe(30);
});

test("a total exactly equal to the steps falls back rather than reporting zero", () => {
  const turn = new TurnUsage();
  turn.step(50);
  expect(turn.finish(50)).toBe(50);
});

test("nothing is known before a turn finishes", () => {
  expect(new TurnUsage().contextTokens).toBe(0);
});

test("a fresh turn forgets the last one's steps", () => {
  const turn = new TurnUsage();
  turn.step(20);
  turn.finish(27);
  turn.reset();
  expect(turn.finish(100)).toBe(100);
});
