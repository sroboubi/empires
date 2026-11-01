/**
 * Default prompt file locations owned by the AI package.
 *
 * The engine no longer hardcodes these paths in `src/config.js`. Callers may
 * override them through `deps.config.promptUrls` when constructing an AI
 * manager, but the defaults live here so `src/ai/` is self-contained.
 */
export const DEFAULT_PROMPT_URLS = {
    command: './src/ai/llm/json/systemPrompt.command.md',
    menu: './src/ai/llm/menu/systemPrompt.menu.md',
    chat: './src/ai/llm/systemPrompt.chat.md',
    chatSummation: './src/ai/llm/systemPrompt.chatSummation.md',
};
