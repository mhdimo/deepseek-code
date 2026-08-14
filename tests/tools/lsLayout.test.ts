import { expect, test } from "bun:test";

import { formatDirectoryTree } from "../../src/tools/LS/LSTool";

test("formats directory entries with tree branches instead of emoji icons", () => {
  expect(
    formatDirectoryTree([
      { name: "src", isDirectory: true },
      { name: "README.md", isDirectory: false },
    ]),
  ).toEqual(["├── src/", "└── README.md"]);
});
