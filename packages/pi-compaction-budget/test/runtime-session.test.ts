import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

function seedSession(manager: SessionManager): void {
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first request" }],
		timestamp: 1,
	} as AppendableMessage);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "x".repeat(4_000) }],
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
		timestamp: 2,
	} as AppendableMessage);
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "second request" }],
		timestamp: 3,
	} as AppendableMessage);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
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
		timestamp: 4,
	} as AppendableMessage);
}

describe("real Pi session runtime", () => {
	it("reports the live settings Pi constructed", async () => {
		const previousOffline = process.env.PI_OFFLINE;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		// Keep every runtime write (auth.json, sessions) out of the repository.
		const agentDir = mkdtempSync(
			join(tmpdir(), "pi-compaction-budget-session-"),
		);
		process.env.PI_OFFLINE = "1";
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const notify = vi.fn();
		const settingsManager = SettingsManager.inMemory({
			compaction: {
				enabled: true,
				reserveTokens: 15_000,
				keepRecentTokens: 1,
			},
		});
		const sessionManager = SessionManager.inMemory(process.cwd());
		seedSession(sessionManager);

		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir,
			settingsManager,
			additionalExtensionPaths: [
				"./packages/pi-compaction-budget/src/index.ts",
			],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
		const model = modelRuntime.getModels()[0];
		if (!model) {
			throw new Error(
				"Pi did not provide a built-in model for the runtime test",
			);
		}

		const { session } = await createAgentSession({
			cwd: process.cwd(),
			model,
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
		});

		try {
			await session.bindExtensions({
				mode: "rpc",
				uiContext: { notify } as unknown as ExtensionUIContext,
			});
			const command = session.extensionRunner.getCommand("compact-budget");
			if (!command) {
				throw new Error("compact-budget command was not registered by Pi");
			}
			await command.handler("", session.extensionRunner.createCommandContext());

			const [text, type] = notify.mock.calls[0] as [string, string];
			expect(type).toBe("info");
			expect(text).toContain("reserveTokens 15,000");
			expect(text).toContain("settings live");
		} finally {
			session.dispose();
			rmSync(agentDir, { recursive: true, force: true });
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});
