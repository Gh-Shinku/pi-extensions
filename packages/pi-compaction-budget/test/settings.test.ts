import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveModel } from "../src/budget.js";
import {
	captureNextSettingsManager,
	parseTokenArg,
	resolveCompactionSettings,
} from "../src/settings.js";

const MODEL = {
	provider: "anthropic",
	id: "test-model",
} as unknown as ActiveModel;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function commandContext(
	overrides: Record<string, unknown> = {},
): ExtensionContext {
	return {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		...overrides,
	} as unknown as ExtensionContext;
}

describe("captureNextSettingsManager", () => {
	it("captures the manager Pi consults after loading extensions", () => {
		const captured: SettingsManager[] = [];
		captureNextSettingsManager((manager) => captured.push(manager));

		const manager = SettingsManager.inMemory({
			compaction: { reserveTokens: 20_000, keepRecentTokens: 8_000 },
		});
		manager.getImageAutoResize();

		expect(captured).toEqual([manager]);
	});

	it("stops listening when cancelled", () => {
		const captured: SettingsManager[] = [];
		const stop = captureNextSettingsManager((manager) =>
			captured.push(manager),
		);
		stop();

		SettingsManager.inMemory({}).getImageAutoResize();

		expect(captured).toEqual([]);
	});
});

describe("resolveCompactionSettings", () => {
	it("prefers the captured live manager", () => {
		const captured = SettingsManager.inMemory({
			compaction: {
				enabled: false,
				reserveTokens: 12_345,
				keepRecentTokens: 678,
			},
		});

		const resolved = resolveCompactionSettings(
			commandContext(),
			MODEL,
			{},
			captured,
		);

		expect(resolved.source).toBe("live");
		expect(resolved.settings).toEqual({
			enabled: false,
			reserveTokens: 12_345,
			keepRecentTokens: 678,
		});
	});

	it("passes the active model to the settings manager", () => {
		const captured = SettingsManager.inMemory({
			compaction: { reserveTokens: 4_321, keepRecentTokens: 1_234 },
		});
		const getCompactionSettings = vi.spyOn(captured, "getCompactionSettings");

		const resolved = resolveCompactionSettings(
			commandContext(),
			MODEL,
			{},
			captured,
		);

		expect(getCompactionSettings).toHaveBeenCalledWith(MODEL);
		expect(resolved.settings.reserveTokens).toBe(4_321);
	});

	it("prefers a public ctx.settingsManager over the captured instance", () => {
		const fromContext = SettingsManager.inMemory({
			compaction: { reserveTokens: 9_999 },
		});
		const captured = SettingsManager.inMemory({
			compaction: { reserveTokens: 1_111 },
		});

		const resolved = resolveCompactionSettings(
			commandContext({ settingsManager: fromContext }),
			MODEL,
			{},
			captured,
		);

		expect(resolved.settings.reserveTokens).toBe(9_999);
	});

	it("falls back to settings.json on disk", () => {
		const agentDir = tempDir("pi-budget-agent-");
		const cwd = tempDir("pi-budget-project-");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { reserveTokens: 4_000 } }),
		);
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1_234 } }),
		);

		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const resolved = resolveCompactionSettings(
				commandContext({ cwd }),
				MODEL,
			);

			expect(resolved.source).toBe("disk");
			expect(resolved.settings.reserveTokens).toBe(4_000);
			expect(resolved.settings.keepRecentTokens).toBe(1_234);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previous;
			}
		}
	});

	it("applies simulation overrides on top of the resolved settings", () => {
		const captured = SettingsManager.inMemory({
			compaction: { reserveTokens: 1_000, keepRecentTokens: 500 },
		});

		const resolved = resolveCompactionSettings(
			commandContext(),
			MODEL,
			{
				reserveTokens: 32_768,
			} as never,
			captured,
		);

		expect(resolved.settings.reserveTokens).toBe(32_768);
		expect(resolved.settings.keepRecentTokens).toBe(500);
	});
});

describe("parseTokenArg", () => {
	it("returns undefined without an argument", () => {
		expect(parseTokenArg(undefined, "reserveTokens")).toBeUndefined();
	});

	it("parses a non-negative safe integer", () => {
		expect(parseTokenArg("32768", "reserveTokens")).toBe(32_768);
		expect(parseTokenArg("0", "reserveTokens")).toBe(0);
	});

	it("rejects anything else", () => {
		for (const raw of ["abc", "-5", "1.5", ""]) {
			expect(() => parseTokenArg(raw, "reserveTokens")).toThrow(
				`Invalid reserveTokens: ${raw}`,
			);
		}
	});
});

describe("settings typing", () => {
	it("reports the values the extension context exposes", () => {
		const isTrusted = vi.fn(() => true);
		const ctx = commandContext({ isProjectTrusted: isTrusted });
		expect(ctx.isProjectTrusted()).toBe(true);
	});
});
