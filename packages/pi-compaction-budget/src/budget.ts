import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	findCutPoint,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	CHARS_PER_TOKEN,
	CONTEXT_SAFETY_TOKENS,
	HISTORY_RESERVE_RATIO,
	MIN_ANSWER_TOKENS,
	MIN_MAX_TOKENS,
	SUMMARIZATION_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
	THINKING_BUDGETS,
	TURN_PREFIX_RESERVE_RATIO,
	TURN_PREFIX_SUMMARIZATION_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
} from "./pi-internals.js";

export type ActiveModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
export type ContextMessage = ReturnType<
	typeof sessionEntryToContextMessages
>[number];

export interface CompactionPlan {
	previousSummary?: string;
	messagesToSummarize: ContextMessage[];
	turnPrefixMessages: ContextMessage[];
	isSplitTurn: boolean;
}

export type Binding =
	| "compaction.reserveTokens"
	| "model.maxTokens"
	| "context window";

export interface Budget {
	/** Estimated input tokens of the summary request (what the context clamp subtracts). */
	inputTokens: number;
	/** `contextWindow - inputTokens - 4096`, floored at `MIN_MAX_TOKENS`. */
	windowRoom: number;
	/** `ratio * reserveTokens` before the model output cap is applied. */
	requested: number;
	/** Ratio of reserveTokens this request uses: 0.8 for history, 0.5 for a turn prefix. */
	ratio: number;
	/** `model.maxTokens`, or Infinity when the model declares no output cap. */
	modelCap: number;
	/** `maxTokens` the provider request ends up with. */
	maxTokens: number;
	/** Thinking tokens reserved inside `maxTokens` (Anthropic budget-based thinking only). */
	thinkingBudget: number;
	/** `maxTokens - thinkingBudget`: what is left for the summary text. */
	textRoom: number;
	binding: Binding;
}

export interface BudgetedPlan {
	history: Budget;
	prefix?: Budget;
	budgets: Budget[];
	worst: Budget;
}

/** pi refuses to compact when the branch already ends in a compaction. */
export function isAlreadyCompacted(entries: SessionEntry[]): boolean {
	const last = entries[entries.length - 1];
	return last !== undefined && last.type === "compaction";
}

function collectMessages(entries: SessionEntry[]): ContextMessage[] {
	const messages: ContextMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction") continue;
		const message = sessionEntryToContextMessages(entry)[0];
		if (message) messages.push(message);
	}
	return messages;
}

/** Mirror of `prepareCompaction()` in `src/core/compaction/compaction.ts`. */
export function buildPlan(
	entries: SessionEntry[],
	keepRecentTokens: number,
): CompactionPlan {
	let previousCompactionIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			previousCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	const previous =
		previousCompactionIndex >= 0 ? entries[previousCompactionIndex] : undefined;
	if (previous?.type === "compaction") {
		previousSummary = previous.summary;
		const firstKeptIndex = entries.findIndex(
			(entry) => entry.id === previous.firstKeptEntryId,
		);
		boundaryStart =
			firstKeptIndex >= 0 ? firstKeptIndex : previousCompactionIndex + 1;
	}

	const cutPoint = findCutPoint(
		entries,
		boundaryStart,
		entries.length,
		keepRecentTokens,
	);
	const historyEnd = cutPoint.isSplitTurn
		? cutPoint.turnStartIndex
		: cutPoint.firstKeptEntryIndex;

	return {
		previousSummary,
		messagesToSummarize: collectMessages(
			entries.slice(boundaryStart, historyEnd),
		),
		turnPrefixMessages: cutPoint.isSplitTurn
			? collectMessages(
					entries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex),
				)
			: [],
		isSplitTurn: cutPoint.isSplitTurn,
	};
}

/** Mirror of the history prompt assembled by `generateSummaryWithUsage()`. */
export function historyPromptText(
	plan: CompactionPlan,
	customInstructions?: string,
): string {
	const conversationText = serializeConversation(
		convertToLlm(plan.messagesToSummarize),
	);
	let basePrompt = plan.previousSummary
		? UPDATE_SUMMARIZATION_PROMPT
		: SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (plan.previousSummary) {
		promptText += `<previous-summary>\n${plan.previousSummary}\n</previous-summary>\n\n`;
	}
	return promptText + basePrompt;
}

/** Mirror of the prompt assembled by `generateTurnPrefixSummary()`. */
export function turnPrefixPromptText(messages: ContextMessage[]): string {
	const conversationText = serializeConversation(convertToLlm(messages));
	return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}

/**
 * Same estimate `clampMaxTokensToContext` applies to the standalone summary
 * context: `ceil(prompt / 4) + ceil(systemPrompt / 4)`.
 */
export function estimateInputTokens(promptText: string): number {
	return (
		Math.ceil(promptText.length / CHARS_PER_TOKEN) +
		Math.ceil(SUMMARIZATION_SYSTEM_PROMPT.length / CHARS_PER_TOKEN)
	);
}

/** Mirror of `clampMaxTokensToContext` in `packages/ai/src/api/simple-options.ts`. */
export function clampToWindow(
	contextWindow: number,
	inputTokens: number,
	requested: number,
): number {
	if (contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, requested);
	const available = contextWindow - inputTokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(requested, Math.max(MIN_MAX_TOKENS, available));
}

/** Forced-adaptive-thinking models do not reserve a separate thinking budget. */
export function usesAdaptiveThinking(model: ActiveModel): boolean {
	const compat: unknown = model.compat;
	if (typeof compat !== "object" || compat === null) return false;
	return (compat as Record<string, unknown>).forceAdaptiveThinking === true;
}

/**
 * Reproduce the final `maxTokens` of a summarization request.
 *
 * pi asks for `min(0.8 * reserveTokens, model.maxTokens)` output tokens, the
 * provider clamps that to `contextWindow - input - 4096`, and budget-based
 * thinking adds its budget on top before both limits are applied again.
 */
export function computeBudget(
	model: ActiveModel,
	thinkingLevel: ThinkingLevel | undefined,
	promptText: string,
	reserveRequest: number,
	ratio: number,
): Budget {
	const inputTokens = estimateInputTokens(promptText);
	const modelCap =
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	const windowRoom =
		model.contextWindow > 0
			? Math.max(
					MIN_MAX_TOKENS,
					model.contextWindow - inputTokens - CONTEXT_SAFETY_TOKENS,
				)
			: Number.POSITIVE_INFINITY;
	const base = clampToWindow(
		model.contextWindow,
		inputTokens,
		Math.min(reserveRequest, modelCap),
	);

	let maxTokens = base;
	let thinkingBudget = 0;
	const level =
		thinkingLevel === "xhigh" || thinkingLevel === "max"
			? "high"
			: thinkingLevel;
	const reservedThinking =
		model.reasoning &&
		model.api === "anthropic-messages" &&
		!usesAdaptiveThinking(model) &&
		level !== undefined &&
		level !== "off"
			? (THINKING_BUDGETS[level] ?? 0)
			: 0;
	if (reservedThinking > 0) {
		// adjustMaxTokensForThinking() grows the cap, then clamps to the context window again.
		const adjusted = Math.min(base + reservedThinking, modelCap);
		let adjustedBudget =
			adjusted <= reservedThinking
				? Math.min(reservedThinking, Math.max(0, adjusted - MIN_ANSWER_TOKENS))
				: reservedThinking;
		maxTokens = clampToWindow(model.contextWindow, inputTokens, adjusted);
		adjustedBudget = Math.min(
			adjustedBudget,
			Math.max(0, maxTokens - MIN_ANSWER_TOKENS),
		);
		thinkingBudget = adjustedBudget;
	}

	const totalRequest = reserveRequest + reservedThinking;
	const binding: Binding =
		maxTokens === windowRoom && windowRoom < totalRequest
			? "context window"
			: maxTokens === modelCap && modelCap < totalRequest
				? "model.maxTokens"
				: "compaction.reserveTokens";

	return {
		inputTokens,
		windowRoom,
		requested: reserveRequest,
		ratio,
		modelCap,
		maxTokens,
		thinkingBudget,
		textRoom: maxTokens - thinkingBudget,
		binding,
	};
}

/** Budgets for every summarization request a compaction of this plan would issue. */
export function computeBudgets(
	model: ActiveModel,
	thinkingLevel: ThinkingLevel | undefined,
	plan: CompactionPlan,
	reserveTokens: number,
	customInstructions?: string,
): BudgetedPlan {
	const history = computeBudget(
		model,
		thinkingLevel,
		historyPromptText(plan, customInstructions),
		Math.floor(HISTORY_RESERVE_RATIO * reserveTokens),
		HISTORY_RESERVE_RATIO,
	);
	const prefix =
		plan.isSplitTurn && plan.turnPrefixMessages.length > 0
			? computeBudget(
					model,
					thinkingLevel,
					turnPrefixPromptText(plan.turnPrefixMessages),
					Math.floor(TURN_PREFIX_RESERVE_RATIO * reserveTokens),
					TURN_PREFIX_RESERVE_RATIO,
				)
			: undefined;
	const budgets = prefix ? [history, prefix] : [history];
	const worst = budgets.reduce((a, b) => (b.textRoom < a.textRoom ? b : a));
	return { history, prefix, budgets, worst };
}
