export const BRIEF_TOOL_NAME = "Brief";

export const DESCRIPTION = `Deliver a deliberate, user-facing notification (a "brief") — distinct from casual streaming output. Use this when you need the user to actually see something: a completion bulletin, a blocker, a decision, an unsolicited status update, or a question that needs their attention.

The brief is surfaced as a highlighted card in the TUI. Ordinary assistant text may scroll past; the brief is meant to be read. Do NOT use this for routine narration ("running tests...") — use it only when the content earns the user's attention.

Usage:
- \`message\`: The body of the brief. Supports markdown.
- \`title\`: Optional short headline for the card.
- \`status\`: Labels intent. Use 'proactive' when you are surfacing something the user did not ask for (a background task finished, you hit a blocker, an unsolicited status update). Use 'normal' when replying to something they just said. Set it honestly — the TUI may route or style by it.
- \`priority\`: Optional. 'high' for time-sensitive / blocking items, 'normal' otherwise. Defaults to 'normal'.

Keep briefs tight: the decision, the file:line, the next step. Address the user in the second person ("your config"), never the third.`;
