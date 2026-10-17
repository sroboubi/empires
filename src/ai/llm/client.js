import Ajv from 'ajv';

export class LLMClient {
    /**
     * @param {Object} options
     * @param {string} options.systemPrompt - System instructions.
     * @param {Object} [options.responseSchema] - Expected JSON schema.
     * @param {string} [options.apiKey=''] - Optional API key.
     * @param {string} [options.baseUrl='http://localhost:1234/v1/chat/completions'] - Endpoint URL.
     * @param {string|string[]} [options.orderedModels=['local-model']] - Model ID(s).
     * @param {number} [options.maxRetries=2] - Schema error feedback retries.
     * @param {number} [options.timeoutMs=15000] - Hard timeout limit in ms.
     * @param {Object} [options.generationConfig] - Hyperparameters (temperature, maxOutputTokens, thinkingBudget).
     */
    constructor({
        systemPrompt,
        responseSchema = null,
        apiKey = '',
        baseUrl = 'http://localhost:1234/v1/chat/completions',
        orderedModels = ['local-model'],
        maxRetries = 2,
        timeoutMs = 15000,
        generationConfig = {}
    }) {
        this.systemPrompt = systemPrompt;
        this.responseSchema = responseSchema;
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.orderedModels = Array.isArray(orderedModels) ? orderedModels : [orderedModels];
        this.maxRetries = maxRetries;
        this.timeoutMs = timeoutMs;
        this.generationConfig = generationConfig;

        this.ajv = new Ajv({ allErrors: true, strict: false });
    }

    async generate(content) {
        const formattedPrompt = typeof content === 'string' ? content : JSON.stringify(content);

        let effectiveSystemPrompt = this.systemPrompt;
        if (this.responseSchema) {
            effectiveSystemPrompt += `\n\nREQUIRED RESPONSE SCHEMA:\nYou MUST respond strictly in raw JSON adhering to this JSON Schema:\n${JSON.stringify(this.responseSchema)}`;
        }

        const messages = [
            { role: 'system', content: effectiveSystemPrompt },
            { role: 'user', content: formattedPrompt }
        ];

        // Sequential fallback across models (works identically for local and cloud)
        for (const model of this.orderedModels) {
            let attempts = 0;

            const payload = {
                model: model,
                messages: messages,
                ...(this.generationConfig.temperature !== undefined && { temperature: this.generationConfig.temperature }),
                ...(this.generationConfig.maxOutputTokens !== undefined && { max_tokens: this.generationConfig.maxOutputTokens })
            };

            if (this.responseSchema) {
                payload.response_format = { type: 'json_object' };
            }

            if (this.generationConfig.thinkingBudget > 0) {
                payload.reasoning = { max_tokens: this.generationConfig.thinkingBudget };
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
                            continue;
                        }

                        if (payload.reasoning && errMsg.includes('reasoning')) {
                            console.warn('[LLMClient] Provider rejected reasoning parameter; stripping.');
                            delete payload.reasoning;
                            continue;
                        }

                        throw new Error(`HTTP ${response.status}: ${errMsg}`);
                    }

                    const result = await response.json();
                    let rawText = result.choices[0]?.message?.content || '';

                    rawText = this._cleanTextOutput(rawText);

                    if (!this.responseSchema) return rawText;

                    const validation = this._validateSchema(rawText, this.responseSchema);
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