import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeSettingsExtension,
	formatRuntimeSettings,
	readRuntimeSettings,
} from "../src/runtime-settings.js";

interface RegisteredCommand {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function loadExtension() {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, () => void>();
	const pi = {
		on(event: string, handler: () => void) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;

	createRuntimeSettingsExtension()(pi);
	const command = commands.get("runtime-settings");
	if (!command) throw new Error("runtime-settings command was not registered");
	return { command, handlers };
}

function commandContext(notify = vi.fn()): ExtensionCommandContext {
	return {
		model: {
			provider: "runtime-provider",
			id: "runtime-model",
			contextWindow: 196_608,
			maxTokens: 32_768,
		},
		ui: { notify },
	} as unknown as ExtensionCommandContext;
}

describe("runtime settings", () => {
	it("reads active model values and resolved in-memory compaction settings", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				enabled: false,
				reserveTokens: 12_345,
				keepRecentTokens: 6_789,
			},
		});

		expect(readRuntimeSettings(commandContext(), manager)).toEqual({
			model: "runtime-provider/runtime-model",
			contextWindow: 196_608,
			maxTokens: 32_768,
			compaction: {
				enabled: false,
				reserveTokens: 12_345,
				keepRecentTokens: 6_789,
			},
		});
	});

	it("captures the live manager Pi consults after loading extensions", async () => {
		const notify = vi.fn();
		const { command } = loadExtension();
		const manager = SettingsManager.inMemory({
			compaction: {
				enabled: true,
				reserveTokens: 20_000,
				keepRecentTokens: 8_000,
			},
		});

		manager.getImageAutoResize();
		await command.handler("", commandContext(notify));

		expect(notify).toHaveBeenCalledWith(
			[
				"Effective runtime settings",
				"model: runtime-provider/runtime-model",
				"contextWindow: 196608",
				"maxTokens: 32768",
				"compaction.enabled: true",
				"compaction.reserveTokens: 20000",
				"compaction.keepRecentTokens: 8000",
			].join("\n"),
			"info",
		);
	});

	it("loads and reports through a real Pi session runtime", async () => {
		const notify = vi.fn();
		const settingsManager = SettingsManager.inMemory({
			compaction: {
				enabled: false,
				reserveTokens: 15_000,
				keepRecentTokens: 7_500,
			},
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			settingsManager,
			additionalExtensionPaths: ["./packages/pi-runtime-settings/src/index.ts"],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
		const model = modelRuntime.getModels()[0];
		if (!model)
			throw new Error(
				"Pi did not provide a built-in model for the runtime test",
			);

		const { session } = await createAgentSession({
			cwd: process.cwd(),
			model,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(process.cwd()),
			settingsManager,
		});

		try {
			await session.bindExtensions({
				mode: "tui",
				uiContext: { notify } as unknown as ExtensionUIContext,
			});
			const command = session.extensionRunner.getCommand("runtime-settings");
			if (!command)
				throw new Error("runtime-settings command was not registered by Pi");
			await command.handler("", session.extensionRunner.createCommandContext());

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("compaction.reserveTokens: 15000"),
				"info",
			);
		} finally {
			session.dispose();
		}
	});

	it("reports every required field when runtime objects are unavailable", () => {
		expect(
			formatRuntimeSettings({
				model: undefined,
				contextWindow: undefined,
				maxTokens: undefined,
				compaction: undefined,
			}),
		).toContain("compaction.keepRecentTokens: unavailable");
	});

	it("rejects command arguments", async () => {
		const { command, handlers } = loadExtension();
		await expect(
			command.handler("unexpected", commandContext()),
		).rejects.toThrow("Usage: /runtime-settings");
		handlers.get("session_shutdown")?.();
	});
});
