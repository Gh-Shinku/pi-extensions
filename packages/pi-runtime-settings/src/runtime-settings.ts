import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { captureNextSettingsManager } from "./settings-manager-capture.js";

type CompactionSettings = ReturnType<SettingsManager["getCompactionSettings"]>;

interface ContextWithSettingsManager extends ExtensionCommandContext {
	settingsManager?: SettingsManager;
}

export interface RuntimeSettingsSnapshot {
	model: string | undefined;
	contextWindow: number | undefined;
	maxTokens: number | undefined;
	compaction: CompactionSettings | undefined;
}

export function readRuntimeSettings(
	ctx: ExtensionCommandContext,
	capturedSettingsManager?: SettingsManager,
): RuntimeSettingsSnapshot {
	const model = ctx.model;
	const settingsManager =
		(ctx as ContextWithSettingsManager).settingsManager ??
		capturedSettingsManager;

	return {
		model: model ? `${model.provider}/${model.id}` : undefined,
		contextWindow: model?.contextWindow,
		maxTokens: model?.maxTokens,
		compaction: settingsManager?.getCompactionSettings(),
	};
}

function displayValue(value: boolean | number | string | undefined): string {
	return value === undefined ? "unavailable" : String(value);
}

export function formatRuntimeSettings(
	settings: RuntimeSettingsSnapshot,
): string {
	return [
		"Effective runtime settings",
		`model: ${displayValue(settings.model)}`,
		`contextWindow: ${displayValue(settings.contextWindow)}`,
		`maxTokens: ${displayValue(settings.maxTokens)}`,
		`compaction.enabled: ${displayValue(settings.compaction?.enabled)}`,
		`compaction.reserveTokens: ${displayValue(settings.compaction?.reserveTokens)}`,
		`compaction.keepRecentTokens: ${displayValue(settings.compaction?.keepRecentTokens)}`,
	].join("\n");
}

export function createRuntimeSettingsExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		let settingsManager: SettingsManager | undefined;
		const stopCapture = captureNextSettingsManager((manager) => {
			settingsManager = manager;
		});

		pi.on("session_shutdown", () => {
			stopCapture();
			settingsManager = undefined;
		});

		pi.registerCommand("runtime-settings", {
			description: "Show effective model and compaction runtime settings",
			handler: async (args, ctx) => {
				if (args.trim()) throw new Error("Usage: /runtime-settings");
				const snapshot = readRuntimeSettings(ctx, settingsManager);
				const type = snapshot.model && snapshot.compaction ? "info" : "warning";
				ctx.ui.notify(formatRuntimeSettings(snapshot), type);
			},
		});
	};
}

export default createRuntimeSettingsExtension();
