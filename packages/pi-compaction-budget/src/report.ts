import type {
	ActiveModel,
	Budget,
	BudgetedPlan,
	CompactionPlan,
	ThinkingLevel,
} from "./budget.js";
import { MIN_MAX_TOKENS, SAFE_TEXT_ROOM_TOKENS } from "./pi-internals.js";
import type { CompactionSettings, SettingsSource } from "./settings.js";

export type Tone = "ok" | "warn" | "fail";

export interface ReportLine {
	text: string;
	tone?: Tone;
}

export interface ReportInput {
	model: ActiveModel;
	settings: CompactionSettings;
	settingsSource: SettingsSource;
	thinkingLevel: ThinkingLevel | undefined;
	contextTokens: number | null;
	plan: CompactionPlan;
	budgets: BudgetedPlan;
}

export interface Report {
	title: string;
	lines: ReportLine[];
	verdict: Tone;
	worst: Budget;
}

export const REPORT_TITLE = "Compaction budget (chars/4 estimate)";

export function formatTokens(value: number): string {
	return value >= Number.MAX_SAFE_INTEGER / 2
		? "unlimited"
		: Math.round(value).toLocaleString("en-US");
}

export function verdictFor(budget: Budget): Tone {
	// `windowRoom` floors at MIN_MAX_TOKENS, so this means the clamp hit its floor.
	if (budget.windowRoom <= MIN_MAX_TOKENS || budget.textRoom < 512)
		return "fail";
	return budget.textRoom < SAFE_TEXT_ROOM_TOKENS ? "warn" : "ok";
}

function describeSummary(
	label: string,
	count: number,
	budget: Budget,
	extra?: string,
): ReportLine[] {
	return [
		{
			text: `${label}: ${count} ${count === 1 ? "message" : "messages"}${extra ? `, ${extra}` : ""}`,
		},
		{
			text: `  input ${formatTokens(budget.inputTokens)}  room ${formatTokens(budget.windowRoom)}  ->  maxTokens ${formatTokens(budget.maxTokens)}  thinking ${formatTokens(budget.thinkingBudget)}  text room ${formatTokens(budget.textRoom)}`,
		},
		{ text: `  binding: ${budget.binding}` },
	];
}

export function formatReport(input: ReportInput): Report {
	const { model, settings, plan, budgets } = input;
	const { history, prefix, worst } = budgets;

	const lines: ReportLine[] = [
		{
			text: `${model.provider}/${model.id}  window ${formatTokens(model.contextWindow)}  maxTokens ${formatTokens(model.maxTokens)}  thinking ${input.thinkingLevel ?? "unset"}`,
		},
		{
			text: `context ${input.contextTokens === null ? "unknown" : formatTokens(input.contextTokens)}  auto-compact above ${formatTokens(model.contextWindow - settings.reserveTokens)}`,
		},
		{
			text: `compaction ${settings.enabled ? "enabled" : "disabled"}  reserveTokens ${formatTokens(settings.reserveTokens)} (${history.ratio}x ${formatTokens(history.requested)})  keepRecentTokens ${formatTokens(settings.keepRecentTokens)}  settings ${input.settingsSource}`,
		},
		{ text: "" },
		...describeSummary(
			"history summary",
			plan.messagesToSummarize.length,
			history,
			plan.previousSummary ? "merges previous summary" : undefined,
		),
	];
	if (prefix) {
		lines.push(
			...describeSummary(
				"turn prefix summary",
				plan.turnPrefixMessages.length,
				prefix,
			),
		);
	}

	const verdict = verdictFor(worst);
	const verdictLabel =
		verdict === "fail"
			? "FAIL (summary will be truncated)"
			: verdict === "warn"
				? "TIGHT"
				: "OK";
	lines.push({ text: "" });
	lines.push({ text: `verdict: ${verdictLabel}`, tone: verdict });

	if (verdict !== "ok") {
		const short = budgets.budgets.filter(
			(budget) => budget.textRoom < SAFE_TEXT_ROOM_TOKENS,
		);
		// Window-limited means even an unlimited reserve could not fit the text room.
		const windowLimited = short.filter(
			(budget) =>
				budget.windowRoom < SAFE_TEXT_ROOM_TOKENS + budget.thinkingBudget,
		);
		const capLimited = short.filter(
			(budget) =>
				!windowLimited.includes(budget) && budget.binding === "model.maxTokens",
		);
		const reserveLimited = short.filter(
			(budget) =>
				!windowLimited.includes(budget) &&
				budget.binding === "compaction.reserveTokens",
		);

		if (windowLimited.length > 0) {
			const budget = windowLimited[0];
			lines.push({
				text: `Hint: the summarized history alone needs ~${formatTokens(budget.inputTokens)} input tokens,`,
			});
			lines.push({
				text: `  so the window leaves only ${formatTokens(budget.windowRoom)} for the answer (need ~${formatTokens(SAFE_TEXT_ROOM_TOKENS + budget.thinkingBudget)}).`,
			});
			lines.push({
				text: `  Raise keepRecentTokens (currently ${formatTokens(settings.keepRecentTokens)}) so fewer messages are summarized,`,
			});
			lines.push({ text: "  or move to a model with a larger contextWindow." });
		}
		if (capLimited.length > 0) {
			lines.push({
				text: `Hint: model.maxTokens (${formatTokens(worst.modelCap)}) caps the summary, not your settings.`,
			});
			lines.push({
				text: "  Use a model with a larger output cap, or fix its metadata in models.json.",
			});
		}
		if (reserveLimited.length > 0) {
			// adjustMaxTokensForThinking() adds the thinking budget on top of
			// ratio * reserveTokens, so only the text room has to fit the reserve cap.
			const requiredReserve = Math.max(
				...reserveLimited.map((budget) =>
					Math.ceil(SAFE_TEXT_ROOM_TOKENS / budget.ratio),
				),
			);
			const ratios = [
				...new Set(reserveLimited.map((budget) => budget.ratio)),
			].join(" / ");
			lines.push({
				text: `Hint: ${ratios}x reserveTokens is the cap, not the window (${formatTokens(reserveLimited[0].requested)} for this request).`,
			});
			lines.push({
				text: `  Set compaction.reserveTokens to >= ${formatTokens(requiredReserve)} (currently ${formatTokens(settings.reserveTokens)}).`,
			});
			lines.push({
				text: "  A larger reserve also compacts earlier, which shrinks the summarized history.",
			});
		}
		if (worst.thinkingBudget > 0 && worst.textRoom < SAFE_TEXT_ROOM_TOKENS) {
			lines.push({
				text: `Hint: thinking level ${input.thinkingLevel} reserves ${formatTokens(worst.thinkingBudget)} tokens from the same cap.`,
			});
			lines.push({
				text: "  Lower the thinking level (/thinking) before compacting.",
			});
		}
	}

	if (
		model.reasoning &&
		model.api !== "anthropic-messages" &&
		input.thinkingLevel !== undefined &&
		input.thinkingLevel !== "off"
	) {
		lines.push({
			text: "Note: reasoning tokens share maxTokens on this provider, so the real text room is lower than shown.",
		});
	}

	return { title: REPORT_TITLE, lines, verdict, worst };
}
