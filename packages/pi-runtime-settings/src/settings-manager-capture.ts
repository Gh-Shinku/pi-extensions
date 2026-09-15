import { SettingsManager } from "@earendil-works/pi-coding-agent";

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
