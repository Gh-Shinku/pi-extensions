import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ActiveModel } from "./budget.js";

export type CompactionSettings = ReturnType<
	SettingsManager["getCompactionSettings"]
>;

/** Where the reported settings came from. */
export type SettingsSource = "live" | "disk";

export interface TokenOverrides {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

type CaptureListener = (manager: SettingsManager) => void;

const listeners = new Set<CaptureListener>();
let restoreCapture: (() => void) | undefined;

function installCaptureHook(): void {
	if (restoreCapture) return;

	const prototype = SettingsManager.prototype;
	const original = prototype.getImageAutoResize;

	prototype.getImageAutoResize =
		function getImageAutoResizeWithCapture(): boolean {
			for (const listener of [...listeners]) listener(this);
			return original.call(this);
		};

	restoreCapture = () => {
		prototype.getImageAutoResize = original;
		restoreCapture = undefined;
	};
}

/**
 * Capture the resolved SettingsManager Pi uses while constructing the session.
 * Pi 0.85 does not expose this runtime object through ExtensionContext, but it
 * does call getImageAutoResize() after extensions load and before session_start.
 */
export function captureNextSettingsManager(
	onCapture: CaptureListener,
): () => void {
	let active = true;
	const listener: CaptureListener = (manager) => {
		if (!active) return;
		active = false;
		listeners.delete(listener);
		onCapture(manager);
		if (listeners.size === 0) restoreCapture?.();
	};

	listeners.add(listener);
	installCaptureHook();

	return () => {
		if (!active) return;
		active = false;
		listeners.delete(listener);
		if (listeners.size === 0) restoreCapture?.();
	};
}

/** Prefer a future public `ctx.settingsManager` over the captured instance. */
function settingsManagerFromContext(
	ctx: ExtensionContext,
): SettingsManager | undefined {
	const candidate: unknown = (ctx as { settingsManager?: unknown })
		.settingsManager;
	return candidate instanceof SettingsManager ? candidate : undefined;
}

function settingsManagerFromDisk(ctx: ExtensionContext): SettingsManager {
	return SettingsManager.create(ctx.cwd, undefined, {
		projectTrusted: ctx.isProjectTrusted(),
	});
}

/**
 * Newer Pi versions take the model here so per-model `compaction.modelOverrides`
 * are applied; 0.85.x declares no parameter and ignores the extra argument.
 */
type GetCompactionSettings = (model?: {
	provider: string;
	id: string;
}) => CompactionSettings;

/**
 * Resolve the compaction settings Pi itself would use for this model.
 *
 * The captured live manager is authoritative: it holds in-memory and SDK
 * settings and any model-specific overrides the running Pi version supports.
 * Reading from disk is only a fallback for sessions where the capture hook did
 * not run.
 */
export function resolveCompactionSettings(
	ctx: ExtensionContext,
	model: ActiveModel,
	overrides: TokenOverrides = {},
	captured?: SettingsManager,
): { settings: CompactionSettings; source: SettingsSource } {
	const live = settingsManagerFromContext(ctx) ?? captured;
	const source: SettingsSource = live ? "live" : "disk";
	const manager = live ?? settingsManagerFromDisk(ctx);
	const getCompactionSettings =
		manager.getCompactionSettings as GetCompactionSettings;
	const settings = getCompactionSettings.call(manager, model);

	return {
		settings: {
			...settings,
			reserveTokens: overrides.reserveTokens ?? settings.reserveTokens,
			keepRecentTokens: overrides.keepRecentTokens ?? settings.keepRecentTokens,
		},
		source,
	};
}

export function parseTokenArg(
	raw: string | undefined,
	name: string,
): number | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid ${name}: ${raw}`);
	}
	return parsed;
}
