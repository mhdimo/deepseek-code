// Component parity tests render through Ink's renderToString, which lays out
// at 80 columns by default while components read process.stdout.columns via
// useStdout. In a real terminal those two numbers disagree (say 120 vs 80), the
// row overflows, and Ink drops the sprite's leading whitespace — so pin the
// dimensions, and pin color off, to make rendered frames independent of the
// terminal that happens to run the suite.
//
// messageChrome.test.ts wants colors: it raises chalk.level itself, which
// still works from the level-0 starting point this gives it.
process.env.FORCE_COLOR = "0";
if (process.stdout.columns !== 80) {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
}
