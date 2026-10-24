import Ajv from 'ajv';

export class LLMClient {
    /**
     * @param {Object} options
     * @param {string|null} [options.systemPrompt=null] - Default system instructions (optional fallback).
     * @param {Object|null} [options.responseSchema=null] - Expected JSON schema (optional fallback).
     * @param {string|null} options.apiKey - API key.
     * @param {string} options.baseUrl - Endpoint URL.
     * @param {string|string[]} options.orderedModels - Model ID(s).
     * @param {number} [options.maxRetries=2] - Schema error feedback retries.
     * @param {number} [options.timeoutMs=15000] - Hard timeout limit in ms.
     * @param {Object} [options.generationConfig] - Hyperparameters (temperature, maxOutputTokens, thinkingBudget).
     */
    constructor({
        systemPrompt = null,
        responseSchema = null,
        apiKey,
        baseUrl,
        orderedModels,
        maxRetries = 2,
        timeoutMs = 15000,
        generationConfig = {}
    } = {}) {
        this.systemPrompt = systemPrompt;
        this.responseSchema = responseSchema;
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.trim().replace(/\/+$/, '') + '/chat/completions';
        this.orderedModels = Array.isArray(orderedModels) ? orderedModels : [orderedModels];
        this.maxRetries = maxRetries;
        this.timeoutMs = timeoutMs;
        this.generationConfig = generationConfig;
        this.allowSchema = true;   // these are generally per provider (per base URL, not per model)
        this.allowReasoning = true;
        this.ajv = new Ajv({ allErrors: true, strict: false });
    }

    /**
     * Generates a response from the LLM using a dynamic system prompt and options.
     * @param {string|Array<Object>} content - Prompt text or array of messages.
     * @param {string|null} [systemPrompt=null] - Dynamic system instructions for this call.
     * @param {Object|null} [options=null] - Call options: { responseSchema, temperature, maxOutputTokens, thinkingBudget, generationConfig }.
     * @returns {Promise<Object|string|null>} Parsed JSON object if schema validated, otherwise raw string.
     */
    async generate(content, systemPrompt = null, options = null) {
        const activeSystemPrompt = systemPrompt !== null && systemPrompt !== undefined
            ? systemPrompt
            : (this.systemPrompt || '');

        let activeSchema = this.responseSchema;
        let configOverrides = {};

        if (options) {
            if (options.responseSchema !== undefined) {
                activeSchema = options.responseSchema;
            } else if (options.properties || options.anyOf || options.type) {
                activeSchema = options;
            }

            if (options.generationConfig) {
                configOverrides = options.generationConfig;
            } else {
                if (options.temperature !== undefined) configOverrides.temperature = options.temperature;
                if (options.maxOutputTokens !== undefined) configOverrides.maxOutputTokens = options.maxOutputTokens;
                if (options.thinkingBudget !== undefined) configOverrides.thinkingBudget = options.thinkingBudget;
            }
        }

        const effectiveGenConfig = {
            ...this.generationConfig,
            ...configOverrides
        };

        let effectiveSystemPrompt = activeSystemPrompt;
        if (activeSchema) {
            effectiveSystemPrompt += `\n\nREQUIRED RESPONSE SCHEMA:\nYou MUST respond strictly in raw JSON adhering to this JSON Schema:\n${JSON.stringify(activeSchema)}`;
        }

        let messages;
        if (Array.isArray(content)) {
            messages = effectiveSystemPrompt
                ? [{ role: 'system', content: effectiveSystemPrompt }, ...content]
                : [...content];
        } else {
            const formattedPrompt = typeof content === 'string' ? content : JSON.stringify(content);
            messages = [
                { role: 'system', content: effectiveSystemPrompt },
                { role: 'user', content: formattedPrompt }
            ];
        }

        // Sequential fallback across models (works identically for local and cloud)
        for (const model of this.orderedModels) {
            let attempts = 0;

            const payload = {
                model: model,
                messages: [...messages],
                ...(effectiveGenConfig.temperature !== undefined && { temperature: effectiveGenConfig.temperature }),
                ...(effectiveGenConfig.maxOutputTokens !== undefined && { max_tokens: effectiveGenConfig.maxOutputTokens })
            };

            if (activeSchema && this.allowSchema) {
                payload.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name: 'game_action_response',
                        strict: true,
                        schema: activeSchema
                    }
                };
            }

            if (effectiveGenConfig.thinkingBudget > 0 && this.allowReasoning) {
                payload.reasoning = { max_tokens: effectiveGenConfig.thinkingBudget };
            }

            while (attempts <= this.maxRetries) {
                attempts++;

                try {
                    const headers = { 'Content-Type': 'application/json' };
                    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

                    const response = await fetch(this.baseUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(payload),
                        signal: AbortSignal.timeout(this.timeoutMs)
                    });

                    if (!response.ok) {
                        let errData;
                        try { errData = await response.json(); }
                        catch { errData = { message: await response.text().catch(() => '') }; }

                        const errMsg = JSON.stringify(errData);

                        if (payload.response_format && (errMsg.includes('response_format') || errMsg.includes('json_schema') || errMsg.includes('schema'))) {
                            console.warn('[LLMClient] Provider rejected response_format; falling back to prompt enforcement.');
                            delete payload.response_format;
                            this.allowSchema = false;    // one time fix for provider - if we hit this once, we won't try again.
                            continue;
                        }

                        if (payload.reasoning && errMsg.includes('reasoning')) {
                            console.warn('[LLMClient] Provider rejected reasoning parameter; stripping.');
                            delete payload.reasoning;
                            this.allowReasoning = false;    // one time fix for provider - if we hit this once, we won't try again.
                            continue;
                        }

                        throw new Error(`HTTP ${response.status}: ${errMsg}`);
                    }

                    const result = await response.json();

                    // Debug: log the full response (includes reasoning_content, finish_reason, usage)
                    console.debug(`[LLMClient] Full response from ${model}:`, JSON.stringify(result, null, 2));

                    const choice = result.choices?.[0];
                    const finishReason = choice?.finish_reason;

                    // Check for abnormal termination before attempting to parse
                    if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
                        const reasonMsg = {
                            'length': 'LLM hit max output token limit — response is truncated and JSON will be malformed.',
                            'content_filter': 'LLM response was blocked by content filter.',
                            'function_call': 'Unexpected function_call finish reason.'
                        }[finishReason] || `LLM finished with reason: ${finishReason}`;
                        console.error(`[LLMClient] Abnormal finish_reason from ${model}: ${reasonMsg}`);
                        // Don't retry on content_filter; do retry on length (might succeed with different phrasing)
                        if (finishReason === 'content_filter') break;
                        continue;
                    }

                    let rawText = choice?.message?.content || '';

                    rawText = this._cleanTextOutput(rawText);

                    if (!activeSchema) return rawText;

                    const validation = this._validateSchema(rawText, activeSchema);
                    if (validation.valid) return validation.data;

                    console.warn(`[Ajv Validation Failed - Model: ${model} - Attempt ${attempts}/${this.maxRetries}]: ${validation.error}`);

                    payload.messages.push({ role: 'assistant', content: rawText });
                    payload.messages.push({
                        role: 'user',
                        content: `Your response failed strict schema validation. Errors: ${validation.error}. Re-generate the full JSON adhering strictly to the schema.`
                    });

                } catch (error) {
                    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
                        console.error(`[LLM Timeout]: Request to ${this.baseUrl} (${model}) exceeded ${this.timeoutMs}ms limit.`);
                    } else {
                        console.error(`[LLM Request Error - Model: ${model}]:`, error.message);
                    }

                    if (attempts > this.maxRetries) break;
                }
            }
        }

        console.error('All models and retries failed to produce a valid response.');
        return null;
    }

    _cleanTextOutput(text) {
        if (!text) return '';
        let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
        }
        return cleaned;
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