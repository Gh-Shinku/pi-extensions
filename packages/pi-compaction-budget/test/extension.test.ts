import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createCompactionBudgetExtension } from "../src/index.js";

type CommandHandler = (
	args: string,
	ctx: ExtensionCommandContext,
) => Promise<void>;
type EventHandler = (
	event: never,
	ctx: ExtensionCommandContext,
) => Promise<void>;

interface RegisteredCommand {
	handler: CommandHandler;
}

function loadExtension() {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, EventHandler>();
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;

	createCompactionBudgetExtension()(pi);
	const command = commands.get("compact-budget");
	if (!command) throw new Error("compact-budget command was not registered");
	return { command, handlers };
}

type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

function userMessage(text: string, timestamp: number): AppendableMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	} as AppendableMessage;
}

function assistantMessage(text: string, timestamp: number): AppendableMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp,
	} as AppendableMessage;
}

/** A session with one completed turn that can be split and summarized. */
function sessionManager(bigAssistantChars = 4_000): SessionManager {
	const manager = SessionManager.inMemory("/tmp/pi-compaction-budget-test");
	manager.appendMessage(userMessage("first request", 1));
	manager.appendMessage(assistantMessage("x".repeat(bigAssistantChars), 2));
	manager.appendMessage(userMessage("second request", 3));
	manager.appendMessage(assistantMessage("done", 4));
	return manager;
}

const MODEL = {
	provider: "anthropic",
	id: "test-model",
	contextWindow: 500_000,
	maxTokens: 64_000,
	reasoning: false,
	api: "anthropic-messages",
};

function commandContext(
	overrides: {
		notify?: ReturnType<typeof vi.fn>;
		sessionManager?: SessionManager;
		settingsManager?: SettingsManager;
		mode?: string;
		hasUI?: boolean;
		custom?: ReturnType<typeof vi.fn>;
		model?: unknown;
	} = {},
): ExtensionCommandContext {
	const notify = overrides.notify ?? vi.fn();
	return {
		mode: overrides.mode ?? "print",
		hasUI: overrides.hasUI ?? true,
		ui: {
			notify,
			custom: overrides.custom ?? vi.fn(),
		},
		cwd: process.cwd(),
		sessionManager: overrides.sessionManager ?? sessionManager(),
		settingsManager: overrides.settingsManager,
		model: overrides.model ?? MODEL,
		scopedModels: [],
		thinkingLevel: "off",
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({
			tokens: 1_234,
			contextWindow: 500_000,
			percent: 1,
		}),
		compact: vi.fn(),
		getSystemPrompt: () => "",
	} as unknown as ExtensionCommandContext;
}

describe("compact-budget command", () => {
	it("prints the report with live settings", async () => {
		const notify = vi.fn();
		const { command, handlers } = loadExtension();
		const manager = SettingsManager.inMemory({
			compaction: { reserveTokens: 16_384, keepRecentTokens: 1 },
		});
		manager.getImageAutoResize();

		try {
			await command.handler("", commandContext({ notify }));
		} finally {
			handlers.get("session_shutdown")?.(
				undefined as never,
				undefined as never,
			);
		}

		const [text, type] = notify.mock.calls[0] as [string, string];
		expect(type).toBe("info");
		expect(text).toContain("Compaction budget (chars/4 estimate)");
		expect(text).toContain("anthropic/test-model");
		expect(text).toContain("settings live");
		expect(text).toContain("binding:");
		expect(text).toContain("verdict: OK");
	});

	it("honors a simulated reserveTokens argument", async () => {
		const notify = vi.fn();
		const { command, handlers } = loadExtension();
		const manager = SettingsManager.inMemory({
			compaction: { reserveTokens: 16_384, keepRecentTokens: 1 },
		});
		manager.getImageAutoResize();

		try {
			await command.handler("32768", commandContext({ notify }));
		} finally {
			handlers.get("session_shutdown")?.(
				undefined as never,
				undefined as never,
			);
		}

		expect(notify.mock.calls[0][0]).toContain(
			"reserveTokens 32,768 (0.8x 26,214)",
		);
	});

	it("rejects invalid arguments", async () => {
		const notify = vi.fn();
		const { command } = loadExtension();

		await command.handler("abc", commandContext({ notify }));

		expect(notify).toHaveBeenCalledWith(
			"Invalid reserveTokens: abc",
			"warning",
		);
	});

	it("reports a too-small session", async () => {
		const notify = vi.fn();
		const { command } = loadExtension();

		await command.handler(
			"",
			commandContext({
				notify,
				sessionManager: SessionManager.inMemory("/tmp/pi-empty"),
				settingsManager: SettingsManager.inMemory({}),
			}),
		);

		expect(notify).toHaveBeenCalledWith(
			"Nothing to compact (session too small)",
			"info",
		);
	});

	it("reports an already compacted branch", async () => {
		const notify = vi.fn();
		const { command } = loadExtension();
		const manager = sessionManager();
		const entries: SessionEntry[] = manager.getBranch();
		manager.appendCompaction("previous summary", entries[0].id as string, 10);

		await command.handler(
			"",
			commandContext({
				notify,
				sessionManager: manager,
				settingsManager: SettingsManager.inMemory({}),
			}),
		);

		expect(notify).toHaveBeenCalledWith(
			"Already compacted: the last entry is a compaction",
			"info",
		);
	});

	it("renders a closable TUI panel", async () => {
		const done = vi.fn();
		let component:
			| {
					render: (width: number) => string[];
					handleInput: (data: string) => void;
			  }
			| undefined;
		const custom = vi.fn(async (factory: unknown) => {
			const create = factory as (
				tui: unknown,
				theme: unknown,
				kb: unknown,
				finish: (result: unknown) => void,
			) => typeof component;
			component = create(
				undefined,
				{
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
				undefined,
				done,
			);
			return undefined;
		});
		const { command } = loadExtension();

		await command.handler(
			"",
			commandContext({
				mode: "tui",
				custom,
				settingsManager: SettingsManager.inMemory({
					compaction: { keepRecentTokens: 1 },
				}),
			}),
		);

		expect(custom).toHaveBeenCalledTimes(1);
		expect(component).toBeDefined();
		expect(component?.render(120).join("\n")).toContain("Compaction budget");
		component?.handleInput("\r");
		expect(done).toHaveBeenCalledWith(undefined);
	});
});

describe("session_before_compact hook", () => {
	function compactEvent(
		overrides: Partial<SessionBeforeCompactEvent> = {},
	): SessionBeforeCompactEvent {
		return {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "entry-1",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1_000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: {
					enabled: true,
					reserveTokens: 16_384,
					keepRecentTokens: 20_000,
				},
			},
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
			...overrides,
		} as SessionBeforeCompactEvent;
	}

	it("warns when the summary will be truncated", async () => {
		const notify = vi.fn();
		const { handlers } = loadExtension();
		const handler = handlers.get("session_before_compact");
		if (!handler) throw new Error("hook was not registered");

		const event = compactEvent();
		event.preparation.messagesToSummarize = [
			{
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(80_000) }],
			},
		] as never;

		await handler(
			event as never,
			commandContext({
				notify,
				model: {
					...MODEL,
					contextWindow: 20_000,
				},
			}),
		);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Compaction budget is FAIL"),
			"error",
		);
		expect(notify.mock.calls[0][0]).toContain(
			"Run /compact-budget for details.",
		);
	});

	it("stays quiet when the budget is fine", async () => {
		const notify = vi.fn();
		const { handlers } = loadExtension();
		const handler = handlers.get("session_before_compact");
		if (!handler) throw new Error("hook was not registered");

		await handler(compactEvent() as never, commandContext({ notify }));

		expect(notify).not.toHaveBeenCalled();
	});
});
