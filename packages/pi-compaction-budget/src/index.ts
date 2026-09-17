import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import {
	type ActiveModel,
	buildPlan,
	type CompactionPlan,
	computeBudgets,
	isAlreadyCompacted,
} from "./budget.js";
import {
	formatReport,
	formatTokens,
	type Report,
	type Tone,
} from "./report.js";
import {
	type CompactionSettings,
	captureNextSettingsManager,
	parseTokenArg,
	resolveCompactionSettings,
	type SettingsSource,
} from "./settings.js";

function colorForTone(
	tone: Tone | undefined,
): "text" | "success" | "warning" | "error" {
	switch (tone) {
		case "ok":
			return "success";
		case "warn":
			return "warning";
		case "fail":
			return "error";
		default:
			return "text";
	}
}

function buildReport(
	ctx: ExtensionContext,
	model: ActiveModel,
	plan: CompactionPlan,
	settings: CompactionSettings,
	settingsSource: SettingsSource,
	customInstructions?: string,
): Report {
	const usage = ctx.getContextUsage();
	return formatReport({
		model,
		settings,
		settingsSource,
		thinkingLevel: ctx.thinkingLevel,
		contextTokens: usage?.tokens ?? null,
		plan,
		budgets: computeBudgets(
			model,
			ctx.thinkingLevel,
			plan,
			settings.reserveTokens,
			customInstructions,
		),
	});
}

async function showReport(
	report: Report,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode === "tui") {
		await ctx.ui.custom((_tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);
			container.addChild(
				new Text(theme.fg("accent", theme.bold(report.title)), 1, 0),
			);
			for (const line of report.lines) {
				container.addChild(
					new Text(theme.fg(colorForTone(line.tone), line.text), 1, 0),
				);
			}
			container.addChild(
				new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0),
			);
			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
						done(undefined);
					}
				},
			};
		});
		return;
	}

	const text = [report.title, ...report.lines.map((line) => line.text)].join(
		"\n",
	);
	const type =
		report.verdict === "fail"
			? "error"
			: report.verdict === "warn"
				? "warning"
				: "info";
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
	} else {
		console.log(text);
	}
}

export function createCompactionBudgetExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		let settingsManager: SettingsManager | undefined;
		let stopCapture: (() => void) | undefined;

		const armCapture = () => {
			stopCapture?.();
			stopCapture = captureNextSettingsManager((manager) => {
				settingsManager = manager;
			});
		};
		armCapture();

		pi.on("session_start", () => {
			armCapture();
		});
		pi.on("session_shutdown", () => {
			stopCapture?.();
			stopCapture = undefined;
			settingsManager = undefined;
		});

		pi.registerCommand("compact-budget", {
			description:
				"Show the summary output budget after the context clamp (optional: reserveTokens [keepRecentTokens])",
			handler: async (args, ctx) => {
				const model = ctx.model;
				if (!model) {
					ctx.ui.notify("No model selected", "warning");
					return;
				}

				const [reserveArg, keepRecentArg] = args
					.trim()
					.split(/\s+/)
					.filter(Boolean);
				let settings: CompactionSettings;
				let settingsSource: SettingsSource;
				try {
					const resolved = resolveCompactionSettings(
						ctx,
						model,
						{
							reserveTokens: parseTokenArg(reserveArg, "reserveTokens"),
							keepRecentTokens: parseTokenArg(
								keepRecentArg,
								"keepRecentTokens",
							),
						},
						settingsManager,
					);
					settings = resolved.settings;
					settingsSource = resolved.source;
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
					return;
				}

				const entries = ctx.sessionManager.getBranch();
				if (isAlreadyCompacted(entries)) {
					ctx.ui.notify(
						"Already compacted: the last entry is a compaction",
						"info",
					);
					return;
				}

				const plan = buildPlan(entries, settings.keepRecentTokens);
				if (
					plan.messagesToSummarize.length === 0 &&
					plan.turnPrefixMessages.length === 0
				) {
					ctx.ui.notify("Nothing to compact (session too small)", "info");
					return;
				}

				await showReport(
					buildReport(ctx, model, plan, settings, settingsSource),
					ctx,
				);
			},
		});

		// Report with the real prepared compaction, so a failing /compact explains itself.
		pi.on(
			"session_before_compact",
			async (event: SessionBeforeCompactEvent, ctx) => {
				const model = ctx.model;
				if (!model || !ctx.hasUI) return;
				const { preparation } = event;
				const plan: CompactionPlan = {
					previousSummary: preparation.previousSummary,
					messagesToSummarize: preparation.messagesToSummarize,
					turnPrefixMessages: preparation.turnPrefixMessages,
					isSplitTurn: preparation.isSplitTurn,
				};
				const report = buildReport(
					ctx,
					model,
					plan,
					preparation.settings,
					"live",
					event.customInstructions,
				);
				if (report.verdict === "ok") return;
				ctx.ui.notify(
					`Compaction budget is ${report.verdict.toUpperCase()}: maxTokens ${formatTokens(report.worst.maxTokens)}, ` +
						`text room ${formatTokens(report.worst.textRoom)} (binding: ${report.worst.binding}). ` +
						"Run /compact-budget for details.",
					report.verdict === "fail" ? "error" : "warning",
				);
			},
		);
	};
}

export default createCompactionBudgetExtension();
