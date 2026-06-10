import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../shared/config.js";
import { log } from "../shared/log.js";
import type { UsageMeter } from "../shared/cost.js";
import { SubmitReviewSchema, formatZodIssues, validateSemantics, type ReviewResult } from "./schema.js";
import type { SystemBlock } from "./prompt.js";
import type { RepoTools } from "./tools.js";

/** One API turn: stream the request, return the final accumulated message. */
export type TurnRunner = (params: Record<string, unknown>) => Promise<Anthropic.Message>;

export function anthropicTurnRunner(client: Anthropic): TurnRunner {
  return (params) => client.messages.stream(params as never).finalMessage();
}

export class NoSubmitError extends Error {
  constructor(detail: string) {
    super(`The review agent did not produce a valid submit_review call: ${detail}`);
    this.name = "NoSubmitError";
  }
}

interface AgentDeps {
  runTurn: TurnRunner;
  system: SystemBlock[];
  tools: RepoTools;
  initialUserText: string;
  cfg: Config;
  meter: UsageMeter;
}

type Block = Record<string, unknown>;
const FORCED_ATTEMPT_LIMIT = 3;
/**
 * Cache breakpoints look back at most 20 content blocks; when one turn
 * appends more than this, an extra mid-turn marker keeps the chain intact.
 */
const LOOKBACK_GUARD = 18;

export async function runAgent(deps: AgentDeps): Promise<ReviewResult> {
  const { runTurn, system, tools, cfg, meter } = deps;

  const initialMessage = {
    role: "user" as const,
    content: [
      {
        type: "text",
        text: deps.initialUserText,
        cache_control: { type: "ephemeral" },
      } as Block,
    ],
  };
  const messages: Array<{ role: "user" | "assistant"; content: Block[] | string }> = [initialMessage];

  let slidingBlocks: Block[] = [];
  let forcedSubmit = false;
  let forcedAttempts = 0;
  let nudged = false;

  for (let turn = 1; ; turn++) {
    if (turn > cfg.maxTurns && !forcedSubmit) {
      log.warn(`turn cap (${cfg.maxTurns}) reached — forcing submit_review`);
      forcedSubmit = true;
    }
    if (forcedSubmit && forcedAttempts >= FORCED_ATTEMPT_LIMIT) {
      throw new NoSubmitError(`no valid submission after ${FORCED_ATTEMPT_LIMIT} forced attempts`);
    }

    const params: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: cfg.maxTokensPerTurn,
      system,
      tools: tools.definitions,
      messages: forcedSubmit ? stripThinking(messages) : messages,
    };
    if (forcedSubmit) {
      forcedAttempts += 1;
      params.tool_choice = { type: "tool", name: "submit_review" };
      // Omit `thinking` entirely on the forced call (valid on opus-4-8) to
      // avoid thinking/forced-tool interactions.
    } else {
      params.thinking = { type: "adaptive" };
      params.output_config = { effort: cfg.effort };
    }

    const msg = await runTurn(params);
    meter.add(msg.usage);
    const usage = msg.usage;
    log.info(
      `turn ${turn}: stop=${msg.stop_reason} tools=[${msg.content
        .filter((b) => b.type === "tool_use")
        .map((b) => (b as Anthropic.ToolUseBlock).name)
        .join(",")}] in=${usage.input_tokens} out=${usage.output_tokens} cacheRead=${usage.cache_read_input_tokens ?? 0} cacheWrite=${usage.cache_creation_input_tokens ?? 0}`,
    );

    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content as unknown as Block[] });
      continue;
    }

    const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      if (msg.stop_reason === "max_tokens") {
        messages.push({ role: "assistant", content: msg.content as unknown as Block[] });
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "[harness] Output was truncated by the token limit. Continue more concisely, and call submit_review when ready.",
            },
          ],
        });
        continue;
      }
      if (forcedSubmit) throw new NoSubmitError("model ended its turn without calling submit_review despite tool_choice");
      if (nudged) {
        forcedSubmit = true;
      }
      nudged = true;
      messages.push({ role: "assistant", content: ensureNonEmpty(msg.content as unknown as Block[]) });
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "[harness] You must finish by calling submit_review exactly once. Continue the review and call it when done.",
          },
        ],
      });
      continue;
    }

    messages.push({ role: "assistant", content: msg.content as unknown as Block[] });

    // submit_review wins the turn if valid; other tool calls run otherwise.
    const results: Block[] = [];
    let submitted: ReviewResult | undefined;
    for (const tu of toolUses) {
      if (tu.name === "submit_review") {
        const structural = SubmitReviewSchema.safeParse(tu.input);
        if (!structural.success) {
          results.push(toolResult(tu.id, formatZodIssues(structural.error), true));
          continue;
        }
        const semantic = validateSemantics(structural.data);
        if (!semantic.ok) {
          results.push(
            toolResult(
              tu.id,
              `submit_review input is invalid. Fix these fields and call submit_review again:\n${semantic.errors.map((e) => `- ${e}`).join("\n")}`,
              true,
            ),
          );
          continue;
        }
        submitted = semantic.review;
        results.push(toolResult(tu.id, "Review received.", false));
      }
    }
    if (submitted) return submitted;

    const otherResults = await Promise.all(
      toolUses
        .filter((tu) => tu.name !== "submit_review")
        .map(async (tu) => {
          const r = await tools.execute(tu.name, tu.input);
          return toolResult(tu.id, r.content, r.isError);
        }),
    );
    // Preserve tool_use order: submit errors were pushed first only if they
    // came first; rebuild in original order instead.
    const byId = new Map<string, Block>();
    for (const r of [...results, ...otherResults]) byId.set(r.tool_use_id as string, r);
    const ordered = toolUses.map((tu) => byId.get(tu.id)).filter((b): b is Block => b !== undefined);

    // Slide the cache marker: clear last turn's, mark this turn's tail (and a
    // mid-block when the turn was large enough to overrun the lookback).
    for (const b of slidingBlocks) delete b.cache_control;
    slidingBlocks = [];
    const tail = ordered[ordered.length - 1];
    if (tail) {
      tail.cache_control = { type: "ephemeral" };
      slidingBlocks.push(tail);
    }
    if (msg.content.length + ordered.length > LOOKBACK_GUARD && ordered.length > 2) {
      const mid = ordered[Math.floor(ordered.length / 2)];
      if (mid && mid !== tail) {
        mid.cache_control = { type: "ephemeral" };
        slidingBlocks.push(mid);
      }
    }

    messages.push({ role: "user", content: ordered });
  }
}

function toolResult(toolUseId: string, content: string, isError: boolean): Block {
  return { type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

function ensureNonEmpty(content: Block[]): Block[] {
  return content.length > 0 ? content : [{ type: "text", text: "(continuing)" }];
}

/**
 * History sent with the forced (thinking-omitted) call must not carry
 * thinking blocks from earlier adaptive-thinking turns.
 */
function stripThinking(
  messages: Array<{ role: "user" | "assistant"; content: Block[] | string }>,
): Array<{ role: "user" | "assistant"; content: Block[] | string }> {
  return messages.map((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    const filtered = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    return { ...m, content: ensureNonEmpty(filtered) };
  });
}
