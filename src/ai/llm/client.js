import Ajv from 'ajv';

export class LLMClient {
    /**
     * @param {Object} options
     * @param {string} options.systemPrompt - System instructions and persona.
     * @param {Object} [options.responseSchema] - Expected JSON schema object.
     * @param {string} options.apiKey - OpenRouter API key.
     * @param {string[]} [options.orderedModels] - Ordered fallback array of OpenRouter model IDs.
     * @param {number} [options.maxRetries=2] - Schema error feedback retries.
     * @param {number} [options.timeoutMs=15000] - Hard timeout limit per request in milliseconds.
     * @param {Object} [options.generationConfig] - Hyperparameters (temperature, maxOutputTokens, thinkingBudget).
     */
    constructor({
        systemPrompt,
        responseSchema = null,
        apiKey,
        orderedModels = [],
        maxRetries = 2,
        timeoutMs = 15000,
        generationConfig = {}
    }) {
        this.systemPrompt = systemPrompt;
        this.responseSchema = responseSchema;
        this.apiKey = apiKey;
        this.orderedModels = orderedModels;
        this.maxRetries = maxRetries;
        this.timeoutMs = timeoutMs;
        this.generationConfig = generationConfig;

        this.ajv = new Ajv({ allErrors: true, strict: false });
    }

    async generate(content) {
        const formattedPrompt = typeof content === 'string' ? content : JSON.stringify(content);

        // Append schema directly to system prompt to guarantee adherence on open-source models
        let effectiveSystemPrompt = this.systemPrompt;
        if (this.responseSchema) {
            effectiveSystemPrompt += `\n\nREQUIRED RESPONSE SCHEMA:\nYou MUST respond strictly in raw JSON adhering to this JSON Schema:\n${JSON.stringify(this.responseSchema)}`;
        }

        const messages = [
            { role: 'system', content: effectiveSystemPrompt },
            { role: 'user', content: formattedPrompt }
        ];

        // Build base payload
        const payload = {
            models: this.orderedModels, // OpenRouter handles server-side fallback across this list
            messages: messages,
            ...(this.generationConfig.temperature !== undefined && { temperature: this.generationConfig.temperature }),
            ...(this.generationConfig.maxOutputTokens !== undefined && { max_tokens: this.generationConfig.maxOutputTokens })
        };

        // Pass structured output schema to OpenRouter API
        if (this.responseSchema) {
            payload.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: 'game_action_response',
                    strict: true,
                    schema: this.responseSchema
                }
            };
        }

        // Pass reasoning/thinking budget if explicitly positive
        if (this.generationConfig.thinkingBudget > 0) {
            payload.reasoning = { max_tokens: this.generationConfig.thinkingBudget };
        }

        let attempts = 0;

        while (attempts <= this.maxRetries) {
            attempts++;

            try {
                // Enforce request time limit using AbortSignal.timeout
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'HTTP-Referer': window.location.origin || 'http://localhost:3000',
                        'X-Title': '4X Strategy Game',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(this.timeoutMs)
                });

                if (!response.ok) {
                    let errData;
                    try {
                        errData = await response.json();
                    } catch {
                        const errText = await response.text().catch(() => '');
                        errData = { message: errText };
                    }
                    const errMsg = JSON.stringify(errData);

                    // If provider rejects structured response_format or reasoning, strip and retry immediately
                    if (payload.response_format && (errMsg.includes('response_format') || errMsg.includes('json_schema') || errMsg.includes('schema'))) {
                        console.warn('[LLMClient] Provider does not support response_format; falling back to prompt-only schema adherence.');
                        delete payload.response_format;
                        continue;
                    }
                    if (payload.reasoning && errMsg.includes('reasoning')) {
                        console.warn('[LLMClient] Provider does not support reasoning parameter; stripping reasoning.');
                        delete payload.reasoning;
                        continue;
                    }

                    throw new Error(`OpenRouter HTTP ${response.status}: ${errMsg}`);
                }

                const result = await response.json();
                const rawText = result.choices[0]?.message?.content || '';

                if (!this.responseSchema) {
                    return rawText;
                }

                // Ajv Schema Validation
                const validation = this._validateSchema(rawText, this.responseSchema);
                if (validation.valid) {
                    return validation.data;
                }

                console.warn(`[Ajv Validation Failed - Attempt ${attempts}/${this.maxRetries}]: ${validation.error}`);

                // Feed validation error back to LLM for correction turn
                payload.messages.push({ role: 'assistant', content: rawText });
                payload.messages.push({
                    role: 'user',
                    content: `Your response failed strict schema validation. Errors: ${validation.error}. Please re-generate the entire response adhering strictly to the schema.`
                });

            } catch (error) {
                if (error.name === 'TimeoutError' || error.name === 'AbortError') {
                    console.error(`[LLM Request Timeout]: Request exceeded ${this.timeoutMs}ms limit.`);
                } else {
                    console.error(`[LLM Request Error - Attempt ${attempts}]:`, error.message);
                }

                if (attempts > this.maxRetries) break;
            }
        }

        console.error('All retries and model fallbacks failed to produce a valid response.');
        return null;
    }

    _validateSchema(jsonString, schema) {
        let parsed;
        try {
            parsed = JSON.parse(jsonString);
        } catch (e) {
            return { valid: false, error: `Malformed JSON format: ${e.message}` };
        }

        try {
            const validate = this.ajv.compile(schema);
            const valid = validate(parsed);

            if (valid) return { valid: true, data: parsed };

            const formattedErrors = validate.errors
                .map(err => `${err.instancePath ? `At "${err.instancePath}": ` : ''}${err.message}`)
                .join('; ');

            return { valid: false, error: formattedErrors };
        } catch (e) {
            return { valid: false, error: `Schema compilation error: ${e.message}` };
        }
    }
}