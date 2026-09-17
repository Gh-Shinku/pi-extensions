import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type ActiveModel,
	buildPlan,
	type ContextMessage,
	computeBudget,
	computeBudgets,
	estimateInputTokens,
	historyPromptText,
	isAlreadyCompacted,
	turnPrefixPromptText,
} from "../src/budget.js";
import {
	HISTORY_RESERVE_RATIO,
	SUMMARIZATION_SYSTEM_PROMPT,
	TURN_PREFIX_RESERVE_RATIO,
} from "../src/pi-internals.js";

type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

function model(options: {
	contextWindow: number;
	maxTokens: number;
	reasoning?: boolean;
	api?: string;
	forceAdaptiveThinking?: boolean;
}): ActiveModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: options.api ?? "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.com",
		reasoning: options.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow,
		maxTokens: options.maxTokens,
		...(options.forceAdaptiveThinking === undefined
			? {}
			: { compat: { forceAdaptiveThinking: options.forceAdaptiveThinking } }),
	} as unknown as ActiveModel;
}

function budgetFor(
	options: {
		contextWindow: number;
		maxTokens: number;
		reasoning?: boolean;
		api?: string;
		forceAdaptiveThinking?: boolean;
	},
	reserveTokens: number,
	conversationChars: number,
	thinkingLevel?: "off" | "high",
) {
	return computeBudget(
		model(options),
		thinkingLevel,
		`<conversation>\n${"x".repeat(conversationChars)}\n</conversation>\n\n`,
		Math.floor(HISTORY_RESERVE_RATIO * reserveTokens),
		HISTORY_RESERVE_RATIO,
	);
}

function userMessage(text: string, timestamp: number): AppendableMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	} as AppendableMessage;
}

function assistantMessage(text: string, timestamp: number): AppendableMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as AppendableMessage;
}

describe("computeBudget", () => {
	it("reports the context window as the binding ceiling", () => {
		const budget = budgetFor(
			{ contextWindow: 20_000, maxTokens: 64_000 },
			16_384,
			80_000,
		);

		expect(budget.windowRoom).toBe(1);
		expect(budget.maxTokens).toBe(1);
		expect(budget.textRoom).toBe(1);
		expect(budget.binding).toBe("context window");
	});

	it("reports model.maxTokens as the binding ceiling", () => {
		const budget = budgetFor(
			{ contextWindow: 500_000, maxTokens: 8_192 },
			16_384,
			1_000,
		);

		expect(budget.requested).toBe(13_107);
		expect(budget.maxTokens).toBe(8_192);
		expect(budget.textRoom).toBe(8_192);
		expect(budget.binding).toBe("model.maxTokens");
	});

	it("reports a reserveTokens bound budget", () => {
		const budget = budgetFor(
			{ contextWindow: 500_000, maxTokens: 64_000 },
			16_384,
			1_000,
		);

		expect(budget.maxTokens).toBe(13_107);
		expect(budget.binding).toBe("compaction.reserveTokens");
	});

	it("follows a larger simulated reserveTokens", () => {
		const budget = budgetFor(
			{ contextWindow: 500_000, maxTokens: 64_000 },
			32_768,
			1_000,
		);

		expect(budget.requested).toBe(26_214);
		expect(budget.maxTokens).toBe(26_214);
		expect(budget.textRoom).toBe(26_214);
	});

	it("adds the thinking budget on top of the reserve cap", () => {
		const budget = budgetFor(
			{ contextWindow: 500_000, maxTokens: 64_000, reasoning: true },
			16_384,
			1_000,
			"high",
		);

		expect(budget.maxTokens).toBe(29_491);
		expect(budget.thinkingBudget).toBe(16_384);
		expect(budget.textRoom).toBe(13_107);
		expect(budget.binding).toBe("compaction.reserveTokens");
	});

	it("treats a small model cap as binding when thinking is reserved", () => {
		const budget = budgetFor(
			{ contextWindow: 500_000, maxTokens: 20_000, reasoning: true },
			16_384,
			1_000,
			"high",
		);

		expect(budget.maxTokens).toBe(20_000);
		expect(budget.thinkingBudget).toBe(16_384);
		expect(budget.textRoom).toBe(3_616);
		expect(budget.binding).toBe("model.maxTokens");
	});

	it("applies the model cap to the requested reserve", () => {
		const budget = budgetFor(
			{ contextWindow: 1_000_000, maxTokens: 64_000 },
			500_000,
			1_000,
		);

		expect(budget.maxTokens).toBe(64_000);
		expect(budget.binding).toBe("model.maxTokens");
	});

	it("does not reserve thinking for non-Anthropic providers", () => {
		const budget = budgetFor(
			{
				contextWindow: 500_000,
				maxTokens: 64_000,
				reasoning: true,
				api: "openai-completions",
			},
			16_384,
			1_000,
			"high",
		);

		expect(budget.thinkingBudget).toBe(0);
		expect(budget.maxTokens).toBe(13_107);
	});

	it("does not reserve thinking for adaptive thinking models", () => {
		const budget = budgetFor(
			{
				contextWindow: 500_000,
				maxTokens: 64_000,
				reasoning: true,
				forceAdaptiveThinking: true,
			},
			16_384,
			1_000,
			"high",
		);

		expect(budget.thinkingBudget).toBe(0);
		expect(budget.maxTokens).toBe(13_107);
	});

	it("skips the window clamp when the model has no context window", () => {
		const budget = budgetFor(
			{ contextWindow: 0, maxTokens: 64_000 },
			16_384,
			1_000,
		);

		expect(budget.windowRoom).toBe(Number.POSITIVE_INFINITY);
		expect(budget.maxTokens).toBe(13_107);
	});

	it("estimates more input tokens for the update prompt", () => {
		const initial = estimateInputTokens(
			historyPromptText({
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
			}),
		);
		const update = estimateInputTokens(
			historyPromptText({
				previousSummary: "# Previous summary",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
			}),
		);

		expect(update).toBeGreaterThan(initial);
	});

	it("counts the summarization system prompt", () => {
		expect(estimateInputTokens("")).toBe(
			Math.ceil(SUMMARIZATION_SYSTEM_PROMPT.length / 4),
		);
	});
});

describe("prompt assembly", () => {
	it("wraps the conversation and appends the base prompt", () => {
		const prompt = historyPromptText({
			messagesToSummarize: [
				{ role: "user", content: "hello", timestamp: 1 },
			] as unknown as ContextMessage[],
			turnPrefixMessages: [],
			isSplitTurn: false,
		});

		expect(prompt.startsWith("<conversation>\n")).toBe(true);
		expect(prompt).toContain("</conversation>\n\n");
		expect(prompt).toContain("Create a structured context checkpoint summary");
		expect(prompt).not.toContain("<previous-summary>");
	});

	it("adds the previous summary block and custom instructions", () => {
		const prompt = historyPromptText(
			{
				previousSummary: "earlier work",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
			},
			"focus on tests",
		);

		expect(prompt).toContain(
			"<previous-summary>\nearlier work\n</previous-summary>",
		);
		expect(prompt).toContain("Additional focus: focus on tests");
		expect(prompt).toContain("PRESERVE all existing information");
	});

	it("uses the turn prefix prompt for the split turn prefix", () => {
		const prompt = turnPrefixPromptText([]);

		expect(prompt).toContain("This is the PREFIX of a turn");
	});
});

describe("buildPlan", () => {
	function sessionManager(): SessionManager {
		const manager = SessionManager.inMemory("/tmp/pi-compaction-budget-test");
		manager.appendMessage(userMessage("first request", 1));
		manager.appendMessage(assistantMessage("x".repeat(4_000), 2));
		manager.appendMessage(userMessage("second request", 3));
		manager.appendMessage(assistantMessage("done", 4));
		return manager;
	}

	it("summarizes everything before the kept tail", () => {
		const entries = sessionManager().getBranch();
		const plan = buildPlan(entries, 1);

		expect(plan.previousSummary).toBeUndefined();
		expect(plan.isSplitTurn).toBe(true);
		expect(plan.messagesToSummarize).toHaveLength(2);
		expect(plan.turnPrefixMessages).toHaveLength(1);
	});

	it("keeps recent tokens out of the summary", () => {
		const entries = sessionManager().getBranch();
		const plan = buildPlan(entries, 10_000);

		expect(plan.messagesToSummarize.length).toBeLessThan(2);
	});

	it("uses the previous compaction as the boundary", () => {
		const manager = sessionManager();
		const entries = manager.getBranch();
		const firstKeptEntryId = entries[2].id as string;
		manager.appendCompaction("previous summary", firstKeptEntryId, 123);
		for (const entry of manager.getBranch()) {
			if (entry.type === "compaction") {
				expect(entry.summary).toBe("previous summary");
			}
		}
	});

	it("detects a branch that already ends in a compaction", () => {
		const manager = sessionManager();
		const entries = manager.getBranch();
		expect(isAlreadyCompacted(entries)).toBe(false);

		manager.appendCompaction("previous summary", entries[0].id as string, 123);
		expect(isAlreadyCompacted(manager.getBranch())).toBe(true);
	});
});

describe("computeBudgets", () => {
	it("budgets the history and the turn prefix separately", () => {
		const budgets = computeBudgets(
			model({ contextWindow: 500_000, maxTokens: 64_000 }),
			undefined,
			{
				messagesToSummarize: [],
				turnPrefixMessages: [
					{ role: "user", content: "prefix", timestamp: 1 },
				] as unknown as ContextMessage[],
				isSplitTurn: true,
			},
			16_384,
		);

		expect(budgets.history.ratio).toBe(HISTORY_RESERVE_RATIO);
		expect(budgets.prefix?.ratio).toBe(TURN_PREFIX_RESERVE_RATIO);
		expect(budgets.budgets).toHaveLength(2);
		expect(budgets.worst.textRoom).toBeGreaterThan(0);
	});

	it("omits the turn prefix budget for whole-turn compactions", () => {
		const budgets = computeBudgets(
			model({ contextWindow: 500_000, maxTokens: 64_000 }),
			undefined,
			{ messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false },
			16_384,
		);

		expect(budgets.prefix).toBeUndefined();
		expect(budgets.budgets).toHaveLength(1);
	});
});

describe("types", () => {
	it("exposes the active model type from the extension context", () => {
		const active: NonNullable<ExtensionContext["model"]> = model({
			contextWindow: 1_000,
			maxTokens: 100,
		});
		expect(active.id).toBe("test-model");
	});
});
