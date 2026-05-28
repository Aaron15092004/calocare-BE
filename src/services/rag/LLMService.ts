import { GroqService, LLMMessage, LLMOptions, LLMResponse, getGroqService } from "./GroqService";
export type { LLMMessage };
import { GeminiService, getGeminiService } from "./GeminiService";

/**
 * Multi-provider LLM abstraction with automatic fallback:
 * Primary: Groq Llama 3.3 70B
 * Fallback: Gemini 2.0 Flash (on 429/503)
 */
export class LLMService {
    private readonly groq: GroqService;
    private readonly gemini: GeminiService;

    constructor() {
        this.groq = getGroqService();
        this.gemini = getGeminiService();
    }

    async generate(messages: LLMMessage[], opts: LLMOptions = {}): Promise<LLMResponse> {
        try {
            return await this.groq.generate(messages, opts);
        } catch (err) {
            if (this._isFallbackError(err)) {
                return await this.gemini.generate(messages, opts);
            }
            throw err;
        }
    }

    async *stream(messages: LLMMessage[], opts: LLMOptions = {}): AsyncGenerator<string> {
        try {
            yield* this.groq.stream(messages, opts);
        } catch (err) {
            if (this._isFallbackError(err)) {
                yield* this.gemini.stream(messages, opts);
            } else {
                throw err;
            }
        }
    }

    private _isFallbackError(err: unknown): boolean {
        if (err instanceof Error) {
            const msg = err.message.toLowerCase();
            // Rate limit or service unavailable
            return msg.includes("429") || msg.includes("503") || msg.includes("rate limit");
        }
        return false;
    }
}

let _instance: LLMService | null = null;
export function getLLMService(): LLMService {
    if (!_instance) _instance = new LLMService();
    return _instance;
}
