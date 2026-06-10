/**
 * Accumulates token usage across agent turns and estimates cost.
 * Prices are per million tokens; cache reads bill at ~0.1x input,
 * cache writes (5-minute TTL) at ~1.25x input.
 */

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export interface UsageSummary {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** undefined when the model has no known pricing. */
  usd?: number;
}

export class UsageMeter {
  private turns = 0;
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;

  constructor(private readonly model: string) {}

  add(usage: UsageLike): void {
    this.turns += 1;
    this.input += usage.input_tokens;
    this.output += usage.output_tokens;
    this.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  }

  summary(): UsageSummary {
    const pricing = PRICING[this.model];
    let usd: number | undefined;
    if (pricing) {
      usd =
        (this.input * pricing.inputPerMTok +
          this.cacheRead * pricing.inputPerMTok * 0.1 +
          this.cacheWrite * pricing.inputPerMTok * 1.25 +
          this.output * pricing.outputPerMTok) /
        1_000_000;
    }
    return {
      turns: this.turns,
      inputTokens: this.input,
      outputTokens: this.output,
      cacheReadTokens: this.cacheRead,
      cacheWriteTokens: this.cacheWrite,
      usd,
    };
  }

  footerLine(): string {
    const s = this.summary();
    const cost = s.usd !== undefined ? ` · ~$${s.usd.toFixed(2)}` : "";
    return `${s.turns} turns · ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out (cache: ${s.cacheReadTokens.toLocaleString()} read, ${s.cacheWriteTokens.toLocaleString()} written)${cost}`;
  }
}
