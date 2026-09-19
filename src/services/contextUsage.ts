/**
 * How much of the context window the conversation currently occupies.
 *
 * The engine reports usage on each `finish` event, and there are two kinds in a
 * turn. A mid-turn one — `finishReason: "tool_calls"`, the model asking for
 * tools — reports that step's own usage. The terminal one reports the turn's
 * total across every step it took. Measured against the binding's mock
 * provider, a two-step turn reports input 20 and then 27, 27 being 20 plus the
 * second call's 7.
 *
 * The bar wants neither number on its own. What it measures is the request the
 * engine is about to send — the conversation as it now stands — and that is the
 * *last* call's input: the total minus the steps that came before it. Output
 * plays no part. The model's own words are not part of the window they were
 * written into, and adding them (which is what the bar used to do, from
 * `input + output`) inflates the reading most on exactly the turns that produce
 * the most text.
 *
 * Output is also the reason a turn's total can be smaller than its steps: the
 * engine's figures come from the provider, and a provider that reports an
 * uncached total while the steps counted cached reads is describing the same
 * request two ways. When that happens the steps — each one a single call, the
 * only figure with a single meaning — are the ones to keep.
 */
export class TurnUsage {
  /** Input tokens each completed step of the current turn reported. */
  private stepInputs: number[] = [];
  private latest = 0;

  /** A mid-turn `finish`: the model asked for tools and the loop continues.
   *  That step is now behind us, and its input is counted in the total that
   *  the terminal finish will report. */
  step(inputTokens: number): void {
    this.stepInputs.push(inputTokens);
  }

  /** The terminal `finish`. `aggregateInputTokens` is the turn's total, so
   *  what this turn leaves in the window is that total less everything already
   *  spent on steps. Returns the figure and remembers it. */
  finish(aggregateInputTokens: number): number {
    const spent = this.stepInputs.reduce((sum, input) => sum + input, 0);
    const lastStep = this.stepInputs.at(-1);
    const remaining = aggregateInputTokens - spent;
    this.latest =
      remaining > 0
        ? remaining
        : // Only steps, or a total the steps contradict: the last call's own
          // input is what was actually sent either way.
          (lastStep ?? aggregateInputTokens);
    return this.latest;
  }

  /** Input tokens the most recent turn's last call sent. 0 until one has. */
  get contextTokens(): number {
    return this.latest;
  }

  /** Forget the turn. Steps are per-turn: the next turn's total starts from
   *  nothing, and carrying these over would subtract them twice. */
  reset(): void {
    this.stepInputs = [];
    this.latest = 0;
  }
}
