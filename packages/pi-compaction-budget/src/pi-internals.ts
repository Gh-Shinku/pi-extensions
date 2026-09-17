/**
 * Mirrors of private pi internals used to predict the summarization budget.
 *
 * Every value below is copied from `@earendil-works/pi-coding-agent` 0.85.1 and
 * its pi-ai dependency, which is the peer range this package supports. Verify
 * them again whenever the peer version range is widened.
 *
 * Only the character length of the prompt mirrors matters for the budget math:
 * pi estimates the summary input as `ceil(chars / 4)`.
 */

/** packages/ai/src/api/simple-options.ts: safety margin `clampMaxTokensToContext` keeps free. */
export const CONTEXT_SAFETY_TOKENS = 4096;
/** packages/ai/src/api/simple-options.ts: `MIN_MAX_TOKENS`. */
export const MIN_MAX_TOKENS = 1;
/** packages/ai/src/utils/estimate.ts: `CHARS_PER_TOKEN`. */
export const CHARS_PER_TOKEN = 4;
/** packages/ai/src/api/simple-options.ts: `DEFAULT_THINKING_BUDGETS`. */
export const THINKING_BUDGETS: Record<string, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};
/** packages/ai/src/api/simple-options.ts: `MIN_ANSWER_TOKENS`. */
export const MIN_ANSWER_TOKENS = 1024;
/** packages/coding-agent/src/core/compaction/compaction.ts: history summary reserve ratio. */
export const HISTORY_RESERVE_RATIO = 0.8;
/** packages/coding-agent/src/core/compaction/compaction.ts: turn prefix summary reserve ratio. */
export const TURN_PREFIX_RESERVE_RATIO = 0.5;
/** Text room below which a full structured summary is likely to be truncated. */
export const SAFE_TEXT_ROOM_TOKENS = 4096;

/** packages/coding-agent/src/core/compaction/utils.ts: `SUMMARIZATION_SYSTEM_PROMPT`. */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** packages/coding-agent/src/core/compaction/compaction.ts: `SUMMARIZATION_PROMPT`. */
export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** packages/coding-agent/src/core/compaction/compaction.ts: `UPDATE_SUMMARIZATION_INSTRUCTIONS`. */
export const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** packages/coding-agent/src/core/compaction/compaction.ts: `UPDATE_SUMMARIZATION_PROMPT`. */
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/** packages/coding-agent/src/core/compaction/compaction.ts: `TURN_PREFIX_SUMMARIZATION_PROMPT`. */
export const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;
