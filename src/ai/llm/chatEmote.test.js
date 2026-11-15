/**
 * Node-based tests for the diplomatic chat emote tag (Phase 25).
 * Run with: node --input-type=module -e "import('./src/ai/llm/chatEmote.test.js')"
 *
 * Covers extractChatEmote: tag parsing, normalization to the portrait
 * filename stem, validation against the approved subset, and the
 * neutral fallback. generateChatReply itself needs a live LLM client,
 * so it is not exercised here.
 */
import { APPROVED_CHAT_EMOTES, extractChatEmote } from './llmBase.js';

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}: ${e.message}`);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(`${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

console.log('\n## extractChatEmote');

// --- the approved list ---

test('approved list is the 15-emote subset (no death/drunk/blushing)', () => {
    assertEqual(APPROVED_CHAT_EMOTES.length, 15, 'list length');
    for (const excluded of ['blushing', 'stealthy', 'drunk', 'dying', 'unconscious', 'wounded']) {
        assert(!APPROVED_CHAT_EMOTES.includes(excluded), `${excluded} must be excluded`);
    }
    assert(APPROVED_CHAT_EMOTES.includes('neutral'), 'neutral is the default');
    assert(APPROVED_CHAT_EMOTES.includes('eye_roll'), 'eye_roll is approved');
});

// --- parsing ---

test('parses a valid emote and strips the tag', () => {
    const { emote, text } = extractChatEmote('We accept. [EMOTE: JOY]');
    assertEqual(emote, 'joy', 'emote');
    assertEqual(text, 'We accept.', 'tag stripped');
});

test('matching is case-insensitive', () => {
    const { emote, text } = extractChatEmote('Indeed. [emote: Smug]');
    assertEqual(emote, 'smug', 'emote');
    assertEqual(text, 'Indeed.', 'tag stripped');
});

test('normalizes spaces to underscores (eye roll)', () => {
    const { emote } = extractChatEmote('As if. [EMOTE: Eye Roll]');
    assertEqual(emote, 'eye_roll', 'eye roll -> eye_roll');
});

test('missing tag falls back to neutral and leaves the text alone', () => {
    const { emote, text } = extractChatEmote('No emotion here.');
    assertEqual(emote, 'neutral', 'emote');
    assertEqual(text, 'No emotion here.', 'text unchanged');
});

test('an emote outside the approved list falls back to neutral', () => {
    const { emote, text } = extractChatEmote('Oops. [EMOTE: drunk]');
    assertEqual(emote, 'neutral', 'drunk is excluded');
    assertEqual(text, 'Oops.', 'tag still stripped');
});

test('works alongside [END_CHAT]', () => {
    const { emote, text } = extractChatEmote('Farewell. [END_CHAT] [EMOTE: sadness]');
    assertEqual(emote, 'sadness', 'emote');
    assert(text.includes('[END_CHAT]'), 'END_CHAT left for its own parser');
    assert(!text.includes('[EMOTE'), 'emote tag stripped');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
