import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { NoSubmitError, runAgent, type TurnRunner } from "../../src/engine/agent.js";
import { toolDefinitions, type RepoTools } from "../../src/engine/tools.js";
import { UsageMeter } from "../../src/shared/cost.js";
import { buildConfig, type Config } from "../../src/shared/config.js";
import { validReview } from "../helpers/review.js";

function cfg(overrides: Partial<Config> = {}): Config {
  return { ...buildConfig({ anthropicApiKey: "k", githubToken: "t" }), ...overrides };
}

function fakeTools(executed: Array<{ name: string; input: unknown }> = []): RepoTools {
  return {
    definitions: toolDefinitions(),
    async execute(name, input) {
      executed.push({ name, input });
      return { content: `result of ${name}`, isError: false };
    },
    readLines: () => undefined,
  };
}

const usage = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 500,
  cache_creation_input_tokens: 100,
} as Anthropic.Usage;

function msg(content: unknown[], stop_reason = "tool_use"): Anthropic.Message {
  return { content, stop_reason, usage } as unknown as Anthropic.Message;
}

function toolUse(id: string, name: string, input: unknown) {
  return { type: "tool_use", id, name, input };
}

function thinking(text: string) {
  return { type: "thinking", thinking: text, signature: "sig" };
}

/** Scripted runner: each call shifts the next response and records the request. */
function scripted(responses: Anthropic.Message[]) {
  const requests: Array<Record<string, unknown>> = [];
  const runTurn: TurnRunner = async (params) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    const next = responses.shift();
    if (!next) throw new Error("scripted runner exhausted");
    return next;
  };
  return { runTurn, requests };
}

function deps(runTurn: TurnRunner, tools: RepoTools = fakeTools(), config: Config = cfg()) {
  return {
    runTurn,
    system: [{ type: "text" as const, text: "system prompt", cache_control: { type: "ephemeral" as const } }],
    tools,
    initialUserText: "review this PR",
    cfg: config,
    meter: new UsageMeter(config.model),
  };
}

describe("runAgent", () => {
  it("returns the review from a single-turn submit", async () => {
    const { runTurn, requests } = scripted([msg([toolUse("t1", "submit_review", validReview())])]);
    const review = await runAgent(deps(runTurn));
    expect(review.verdict).toBe("REQUEST_CHANGES");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    expect(requests[0]!.tool_choice).toBeUndefined();
  });

  it("dispatches tool calls (parallel) then accepts the submit", async () => {
    const executed: Array<{ name: string; input: unknown }> = [];
    const { runTurn, requests } = scripted([
      msg([
        thinking("let me look"),
        toolUse("t1", "read_file", { path: "a.ts" }),
        toolUse("t2", "grep", { pattern: "foo" }),
      ]),
      msg([toolUse("t3", "submit_review", validReview())]),
    ]);
    const review = await runAgent(deps(runTurn, fakeTools(executed)));
    expect(review.findings).toHaveLength(1);
    expect(executed.map((e) => e.name)).toEqual(["read_file", "grep"]);

    const secondReq = requests[1]!;
    const messages = secondReq.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages).toHaveLength(3); // initial user, assistant, tool results
    const results = messages[2]!.content as Array<Record<string, unknown>>;
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
  });

  it("round-trips schema validation errors so the model can correct", async () => {
    const bad = { ...validReview(), verdict: "SHIP_IT" };
    const { runTurn, requests } = scripted([
      msg([toolUse("t1", "submit_review", bad)]),
      msg([toolUse("t2", "submit_review", validReview())]),
    ]);
    const review = await runAgent(deps(runTurn));
    expect(review.verdict).toBe("REQUEST_CHANGES");
    const results = (requests[1]!.messages as Array<{ content: unknown }>)[2]!.content as Array<
      Record<string, unknown>
    >;
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect(String(results[0]!.content)).toContain("verdict");
  });

  it("round-trips semantic errors (bad anchors)", async () => {
    const bad = validReview();
    bad.findings[0]!.line = 0;
    const { runTurn } = scripted([
      msg([toolUse("t1", "submit_review", bad)]),
      msg([toolUse("t2", "submit_review", validReview())]),
    ]);
    await expect(runAgent(deps(runTurn))).resolves.toMatchObject({ verdict: "REQUEST_CHANGES" });
  });

  it("continues through pause_turn", async () => {
    const { runTurn, requests } = scripted([
      msg([{ type: "text", text: "..." }], "pause_turn"),
      msg([toolUse("t1", "submit_review", validReview())]),
    ]);
    await runAgent(deps(runTurn));
    expect(requests).toHaveLength(2);
    expect((requests[1]!.messages as unknown[]).length).toBe(2); // initial + assistant
  });

  it("nudges after a no-tool turn, then forces submit with thinking stripped", async () => {
    const { runTurn, requests } = scripted([
      msg([thinking("hmm"), { type: "text", text: "I think this PR is fine." }], "end_turn"),
      msg([thinking("ok"), { type: "text", text: "Sure, summarizing." }], "end_turn"),
      msg([toolUse("t1", "submit_review", validReview())]),
    ]);
    await runAgent(deps(runTurn));
    expect(requests).toHaveLength(3);
    // request 2 carries the nudge but is not yet forced
    expect(requests[1]!.tool_choice).toBeUndefined();
    // request 3 is forced: tool_choice present, thinking omitted, history sanitized
    expect(requests[2]!.tool_choice).toEqual({ type: "tool", name: "submit_review" });
    expect(requests[2]!.thinking).toBeUndefined();
    const text = JSON.stringify(requests[2]!.messages);
    expect(text).not.toContain('"thinking"');
  });

  it("forces submit when the turn cap is reached", async () => {
    const config = cfg({ maxTurns: 2 });
    const { runTurn, requests } = scripted([
      msg([toolUse("t1", "read_file", { path: "a" })]),
      msg([toolUse("t2", "read_file", { path: "b" })]),
      msg([toolUse("t3", "submit_review", validReview())]),
    ]);
    await runAgent(deps(runTurn, fakeTools(), config));
    expect(requests[2]!.tool_choice).toEqual({ type: "tool", name: "submit_review" });
  });

  it("throws NoSubmitError when forced attempts are exhausted", async () => {
    const config = cfg({ maxTurns: 1 });
    const noop = () => msg([{ type: "text", text: "still chatting" }], "end_turn");
    const { runTurn } = scripted([msg([toolUse("t1", "read_file", { path: "a" })]), noop(), noop(), noop(), noop()]);
    await expect(runAgent(deps(runTurn, fakeTools(), config))).rejects.toThrow(NoSubmitError);
  });

  it("nudges to continue when output is truncated by max_tokens", async () => {
    const { runTurn, requests } = scripted([
      msg([{ type: "text", text: "partial..." }], "max_tokens"),
      msg([toolUse("t1", "submit_review", validReview())]),
    ]);
    await runAgent(deps(runTurn));
    const nudge = (requests[1]!.messages as Array<{ content: Array<{ text?: string }> }>)[2]!;
    expect(nudge.content[0]!.text).toContain("truncated");
  });

  it("slides the cache marker: newest tool_result marked, previous cleared", async () => {
    const { runTurn, requests } = scripted([
      msg([toolUse("t1", "read_file", { path: "a" })]),
      msg([toolUse("t2", "read_file", { path: "b" })]),
      msg([toolUse("t3", "submit_review", validReview())]),
    ]);
    await runAgent(deps(runTurn));
    const finalMessages = requests[2]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // messages: [initial user, asst1, results1, asst2, results2]
    const results1 = finalMessages[2]!.content;
    const results2 = finalMessages[4]!.content;
    expect(results1.some((b) => b.cache_control)).toBe(false);
    expect(results2[results2.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
    // initial user message keeps its stable breakpoint
    expect(finalMessages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds a mid-turn marker when a turn exceeds the lookback guard", async () => {
    const manyTools = Array.from({ length: 12 }, (_, i) => toolUse(`t${i}`, "read_file", { path: `f${i}` }));
    const bigAssistant = [thinking("x"), ...Array.from({ length: 8 }, (_, i) => ({ type: "text", text: `note ${i}` })), ...manyTools];
    const { runTurn, requests } = scripted([msg(bigAssistant), msg([toolUse("z", "submit_review", validReview())])]);
    await runAgent(deps(runTurn));
    const results = (requests[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>)[2]!.content;
    const marked = results.filter((b) => b.cache_control);
    expect(marked.length).toBe(2); // mid + tail
  });

  it("accumulates usage across turns", async () => {
    const d = deps(
      scripted([
        msg([toolUse("t1", "read_file", { path: "a" })]),
        msg([toolUse("t2", "submit_review", validReview())]),
      ]).runTurn,
    );
    await runAgent(d);
    const s = d.meter.summary();
    expect(s.turns).toBe(2);
    expect(s.inputTokens).toBe(2000);
    expect(s.cacheReadTokens).toBe(1000);
    expect(s.usd).toBeGreaterThan(0);
  });
});
