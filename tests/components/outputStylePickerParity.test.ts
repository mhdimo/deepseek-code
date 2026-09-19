/**
 * /output-style against Claude Code's OutputStylePicker.
 *
 * The reference titles the dialog "Preferred output style" and explains it in
 * a dim line *in the body*, above the list: "This changes how <product>
 * communicates with you". The port titled it "Select output style" and put a
 * differently-worded sentence in the subtitle slot under the heading.
 */
import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";

import OutputStylePicker from "../../src/components/OutputStylePicker.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

function frame(columns = 120): string {
  return renderToString(
    React.createElement(OutputStylePicker, { onSelect: () => {}, onCancel: () => {} }),
    { columns },
  ).replace(ANSI, "");
}

test("the dialog is headed 'Preferred output style'", () => {
  const out = frame();

  expect(out).toContain("Preferred output style");
  expect(out).not.toContain("Select output style");
});

test("the explanation is a dim body line above the list, not a subtitle", () => {
  const out = frame();

  expect(out).toContain("This changes how DeepSeek Code communicates with you");
  expect(out).not.toContain("Styles adjust how responses are framed and explained");

  // Above the list: the styles (or the loading line) come after it.
  expect(out.indexOf("This changes how DeepSeek Code communicates with you")).toBeLessThan(
    out.indexOf("Loading output styles…"),
  );
});
