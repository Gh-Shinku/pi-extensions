import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type {
	ActiveModel,
	Budget,
	BudgetedPlan,
	CompactionPlan,
} from "../src/budget.js";
import { formatReport, REPORT_TITLE, verdictFor } from "../src/report.js";
import type { CompactionSettings } from "../src/settings.js";

const MODEL = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
} as unknown as ActiveModel;

const SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

const PLAN: CompactionPlan = {
	messagesToSummarize: [],
	turnPrefixMessages: [],
	isSplitTurn: false,
};

function budget(overrides: Partial<Budget> = {}): Budget {
	return {
		inputTokens: 44_326,
		windowRoom: 151_678,
		requested: 13_107,
		ratio: 0.8,
		modelCap: 64_000,
		maxTokens: 13_107,
		thinkingBudget: 0,
		textRoom: 13_107,
		binding: "compaction.reserveTokens",
		...overrides,
	};
}

function planWith(history: Budget, prefix?: Budget): BudgetedPlan {
	const budgets = prefix ? [history, prefix] : [history];
	const worst = budgets.reduce((a, b) => (b.textRoom < a.textRoom ? b : a));
	return { history, prefix, budgets, worst };
}

function report(
	budgets: BudgetedPlan,
	options: {
		contextTokens?: number | null;
		thinkingLevel?: "off" | "high";
		model?: ActiveModel;
	} = {},
) {
	return formatReport({
		model: options.model ?? MODEL,
		settings: SETTINGS,
		settingsSource: "live",
		thinkingLevel: options.thinkingLevel,
		contextTokens:
			options.contextTokens === undefined ? 152_340 : options.contextTokens,
		plan: PLAN,
		budgets,
	});
}

describe("verdictFor", () => {
	it("fails when the window leaves no room", () => {
		expect(
			verdictFor(budget({ windowRoom: 1, maxTokens: 1, textRoom: 1 })),
		).toBe("fail");
	});

	it("warns while the text room is small", () => {
		expect(verdictFor(budget({ textRoom: 2_048 }))).toBe("warn");
	});

	it("passes with enough text room", () => {
		expect(verdictFor(budget({ textRoom: 4_096 }))).toBe("ok");
	});
});

describe("formatReport", () => {
	it("renders a slim report for a healthy budget", () => {
		const result = report(planWith(budget()));

		expect(result.title).toBe(REPORT_TITLE);
		expect(result.title).toContain("chars/4 estimate");
		expect(result.verdict).toBe("ok");
		expect(result.lines).toHaveLength(9);
		expect(result.lines.map((line) => line.text).join("\n")).not.toMatch(
			/required:|Estimates use|model cap/,
		);
	});

	it("keeps every previously reported setting visible", () => {
		const text = report(planWith(budget()))
			.lines.map((line) => line.text)
			.join("\n");

		expect(text).toContain("anthropic/test-model");
		expect(text).toContain("window 200,000");
		expect(text).toContain("maxTokens 64,000");
		expect(text).toContain("compaction enabled");
		expect(text).toContain("reserveTokens 16,384");
		expect(text).toContain("keepRecentTokens 20,000");
		expect(text).toContain("settings live");
		expect(text).toContain("binding: compaction.reserveTokens");
		expect(text).toContain("verdict: OK");
	});

	it("reports two lines plus the binding per summarization request", () => {
		const lines = report(planWith(budget())).lines.map((line) => line.text);

		expect(lines).toContain("history summary: 0 messages");
		expect(lines.filter((line) => line.includes("text room"))).toHaveLength(1);
	});

	it("shows unknown context usage as unknown", () => {
		const text = report(planWith(budget()), { contextTokens: null })
			.lines.map((line) => line.text)
			.join("\n");

		expect(text).toContain("context unknown");
	});

	it("hints at keepRecentTokens when the window is the limit", () => {
		const tight = budget({
			inputTokens: 150_000,
			windowRoom: 1,
			maxTokens: 1,
			textRoom: 1,
			binding: "context window",
		});
		const result = report(planWith(tight));

		expect(result.verdict).toBe("fail");
		expect(result.lines.some((line) => line.tone === "fail")).toBe(true);
		const text = result.lines.map((line) => line.text).join("\n");
		expect(text).toContain("verdict: FAIL (summary will be truncated)");
		expect(text).toContain("Raise keepRecentTokens (currently 20,000)");
	});

	it("hints at the model output cap", () => {
		const capped = budget({
			maxTokens: 3_000,
			textRoom: 3_000,
			modelCap: 3_000,
			binding: "model.maxTokens",
		});
		const text = report(planWith(capped))
			.lines.map((line) => line.text)
			.join("\n");

		expect(text).toContain("model.maxTokens (3,000) caps the summary");
		expect(text).toContain("verdict: TIGHT");
	});

	it("hints at reserveTokens and names both ratios", () => {
		const history = budget({
			textRoom: 2_048,
			requested: 3_276,
			maxTokens: 3_276,
		});
		const prefix = budget({
			ratio: 0.5,
			requested: 2_048,
			maxTokens: 2_048,
			textRoom: 2_048,
		});
		const text = report(planWith(history, prefix))
			.lines.map((line) => line.text)
			.join("\n");

		expect(text).toContain("turn prefix summary: 0 messages");
		expect(text).toContain("0.8 / 0.5x reserveTokens is the cap");
		expect(text).toContain("compaction.reserveTokens to >= 8,192");
	});

	it("mentions the thinking reservation when it shrinks the text room", () => {
		const thinking = budget({
			maxTokens: 20_000,
			modelCap: 20_000,
			thinkingBudget: 16_384,
			textRoom: 3_616,
			binding: "model.maxTokens",
		});
		const text = report(planWith(thinking), { thinkingLevel: "high" })
			.lines.map((line) => line.text)
			.join("\n");

		expect(text).toContain("thinking high");
		expect(text).toContain(
			"thinking level high reserves 16,384 tokens from the same cap",
		);
	});

	it("notes shared reasoning budgets for non-Anthropic providers", () => {
		const reasoning = {
			...MODEL,
			api: "openai-completions",
			reasoning: true,
		} as unknown as ActiveModel;
		const text = report(planWith(budget()), {
			model: reasoning,
			thinkingLevel: "high",
		})
			.lines.map((line) => line.text)
			.join("\n");

		expect(text).toContain("reasoning tokens share maxTokens on this provider");
	});
});

describe("report typing", () => {
	it("accepts the extension context model type", () => {
		const active: NonNullable<ExtensionContext["model"]> = MODEL;
		expect(active.contextWindow).toBe(200_000);
	});
});
