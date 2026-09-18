import { GoogleGenAI, Type } from '@google/genai';
import Ajv from 'ajv';

/**
 * Wrapper around GoogleGenAI featuring multi-model fallback, Ajv schema validation,
 * and conversational error-correction feedback loops.
 */
export class GeminiClient {
    /**
     * @param {Object} options
     * @param {string} options.systemPrompt - Dynamic system instructions and persona.
     * @param {Object} [options.responseSchema] - Expected JSON schema object.
     * @param {string} options.apiKey - API key for GoogleGenAI SDK.
     * @param {string[]} options.orderedModels - Priority list of model strings to attempt.
     * @param {number} [options.maxRetries=3] - Maximum retry attempts per request/model.
     * @param {Object} [options.generationConfig] - Hyperparameters (temperature, maxOutputTokens, topP, topK, thinkingBudget).
     */
    constructor({
        systemPrompt,
        responseSchema = null,
        apiKey,
        orderedModels = ['gemini-3.8-flash', 'gemini-3.7-flash'],
        maxRetries = 8,
        generationConfig = {}
    }) {
        this.systemPrompt = systemPrompt;
        this.responseSchema = responseSchema;
        this.apiKey = apiKey;
        this.orderedModels = orderedModels;
        this.maxRetries = maxRetries;
        this.generationConfig = generationConfig;

        this.ai = new GoogleGenAI({ apiKey: this.apiKey });
        this.ajv = new Ajv({ allErrors: true, strict: false });
    }

    /**
     * Executes a prompt request across configured models with Ajv schema validation.
     * 
     * @param {string|Object} content - Input prompt string or structured data object.
     * @returns {Promise<Object|string|null>} Validated response data object, or null if all retries fail.
     */
    async generate(content) {
        const formattedPrompt = typeof content === 'string' ? content : JSON.stringify(content);

        const config = {
            systemInstruction: this.systemPrompt,
            ...(this.responseSchema && {
                responseMimeType: 'application/json',
                responseSchema: this.responseSchema
            }),
            ...(this.generationConfig.temperature !== undefined && { temperature: this.generationConfig.temperature }),
            ...(this.generationConfig.maxOutputTokens !== undefined && { maxOutputTokens: this.generationConfig.maxOutputTokens }),
            ...(this.generationConfig.topP !== undefined && { topP: this.generationConfig.topP }),
            ...(this.generationConfig.topK !== undefined && { topK: this.generationConfig.topK }),
            ...(this.generationConfig.thinkingBudget !== undefined && {
                thinkingConfig: { thinkingBudget: this.generationConfig.thinkingBudget }
            })
        };

        for (const model of this.orderedModels) {
            const contents = [
                { role: 'user', parts: [{ text: formattedPrompt }] }
            ];

            let attempts = 0;

            while (attempts < this.maxRetries) {
                attempts++;

                try {
                    const response = await this.ai.models.generateContent({
                        model,
                        contents,
                        config
                    });

                    const rawText = typeof response.text === 'function' ? response.text() : response.text;

                    if (!this.responseSchema) {
                        return rawText;
                    }

                    const validation = this._validateSchema(rawText, this.responseSchema);

                    if (validation.valid) {
                        return validation.data;
                    }

                    console.warn(`[${model}] Ajv validation failed (Attempt ${attempts}/${this.maxRetries}): ${validation.error}`);

                    // Append invalid model response and detailed Ajv error feedback to conversation history
                    contents.push({ role: 'model', parts: [{ text: rawText || '' }] });
                    contents.push({
                        role: 'user',
                        parts: [{
                            text: `Your response failed strict schema validation. Errors: ${validation.error}. Please re-generate the entire response correcting these specific errors and adhering strictly to the schema.`
                        }]
                    });

                } catch (error) {
                    const errMsg = error.message || String(error);
                    console.error(`[${model}] API call error (Attempt ${attempts}/${this.maxRetries}):`, errMsg);

                    // If thinkingConfig is unsupported on this model, strip it and retry
                    if (config.thinkingConfig && (errMsg.includes('thinking') || errMsg.includes('thinkingConfig'))) {
                        console.warn(`[${model}] Removing thinkingConfig for retry on this model.`);
                        delete config.thinkingConfig;
                        continue;
                    }

                    // If client-level fatal error (model not found, bad request, auth error), fail fast to next model
                    if (errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('400') || errMsg.includes('403') || errMsg.includes('401')) {
                        console.warn(`[${model}] Non-recoverable error encountered; advancing to next model in priority order.`);
                        break;
                    }
                }
            }

            console.warn(`[${model}] Finished attempts. Trying next fallback model if available...`);
        }

        console.error('All models and retries failed to produce a valid response.');
        return null;
    }

    /**
     * Internal validator using Ajv to compile schema and collect detailed validation errors.
     */
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

            if (valid) {
                return { valid: true, data: parsed };
            }

            // Format Ajv errors into a clear, field-level description string for the LLM
            const formattedErrors = validate.errors
                .map(err => {
                    const path = err.instancePath ? `At "${err.instancePath}": ` : '';
                    return `${path}${err.message}${err.params ? ' (' + JSON.stringify(err.params) + ')' : ''}`;
                })
                .join('; ');

            return { valid: false, error: formattedErrors };
        } catch (e) {
            return { valid: false, error: `Schema compilation error: ${e.message}` };
        }
    }
}