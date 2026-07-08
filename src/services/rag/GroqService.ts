import Groq from "groq-sdk";

export interface LLMMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_call_id?: string;
    name?: string;
}

export interface LLMTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface LLMOptions {
    temperature?: number;
    maxTokens?: number;
    tools?: LLMTool[];
}

export interface LLMResponse {
    content: string;
    tool_calls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }>;
}

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
// Flat token estimate for one image input on Llama-4 vision models.
const VISION_IMAGE_TOKEN_ESTIMATE = 1500;

// Vietnamese diacritics and CJK characters tokenize at roughly 1 token per 1.5 chars,
// compared to ~1 token per 4 chars for pure ASCII. Using a mixed estimate prevents
// the token bucket from underestimating and triggering 429s from Groq.
function _estimateTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const m of messages) {
        for (const ch of m.content) {
            const code = ch.codePointAt(0) ?? 0;
            // Non-ASCII (Vietnamese, CJK, emoji, etc.) counts as ~2 tokens per char
            total += code > 127 ? 2 : 0.25;
        }
        total += 4; // per-message overhead (role + formatting)
    }
    return Math.ceil(total);
}

/**
 * Token bucket rate limiter to stay within Groq free tier:
 * 30 req/min, 6K tok/min input.
 */
class TokenBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(
        private readonly capacity: number,
        private readonly refillPerMs: number,
    ) {
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    async consume(amount: number): Promise<void> {
        this._refill();
        if (this.tokens < amount) {
            const waitMs = Math.ceil((amount - this.tokens) / this.refillPerMs);
            await new Promise((r) => setTimeout(r, waitMs));
            this._refill();
        }
        this.tokens -= amount;
    }

    private _refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
        this.lastRefill = now;
    }
}

export class GroqService {
    private readonly client: Groq;
    private readonly reqBucket: TokenBucket;
    private readonly tokenBucket: TokenBucket;

    constructor() {
        const key = process.env.GROQ_API_KEY;
        if (!key) throw new Error("GROQ_API_KEY is not set");
        this.client = new Groq({ apiKey: key });
        // 30 req/min u2192 0.5/s u2192 0.5/1000ms
        this.reqBucket = new TokenBucket(30, 0.5 / 1000);
        // 6000 tok/min u2192 100/s u2192 100/1000ms
        this.tokenBucket = new TokenBucket(6000, 100 / 1000);
    }

    async generate(messages: LLMMessage[], opts: LLMOptions = {}): Promise<LLMResponse> {
        const estimatedTokens = _estimateTokens(messages);
        await this.reqBucket.consume(1);
        await this.tokenBucket.consume(estimatedTokens);

        const completion = await this.client.chat.completions.create({
            model: GROQ_MODEL,
            messages: messages as Groq.Chat.ChatCompletionMessageParam[],
            temperature: opts.temperature ?? 0.7,
            max_tokens: opts.maxTokens ?? 1024,
            tools: opts.tools?.map((t) => ({
                type: "function" as const,
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            })),
        });

        const choice = completion.choices[0];
        const toolCalls = choice.message.tool_calls?.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        }));

        return {
            content: choice.message.content ?? "",
            tool_calls: toolCalls,
        };
    }

    /**
     * Vision call against a Groq-hosted multimodal Llama model. Used as the
     * cross-provider fallback when Gemini vision 503s at peak hours.
     * Returns the raw text response; JSON parsing happens in VisionService.
     */
    async visionRaw(
        prompt: string,
        imageBase64: string,
        mimeType: string,
        opts: LLMOptions = {},
    ): Promise<string> {
        await this.reqBucket.consume(1);
        await this.tokenBucket.consume(
            _estimateTokens([{ role: "user", content: prompt }]) + VISION_IMAGE_TOKEN_ESTIMATE,
        );

        const completion = await this.client.chat.completions.create({
            model: GROQ_VISION_MODEL,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        {
                            type: "image_url",
                            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
                        },
                    ],
                },
            ],
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 1024,
        });

        return completion.choices[0]?.message?.content ?? "";
    }

    async *stream(
        messages: LLMMessage[],
        opts: LLMOptions = {},
    ): AsyncGenerator<string> {
        const estimatedTokens = _estimateTokens(messages);
        await this.reqBucket.consume(1);
        await this.tokenBucket.consume(estimatedTokens);

        const stream = await this.client.chat.completions.create({
            model: GROQ_MODEL,
            messages: messages as Groq.Chat.ChatCompletionMessageParam[],
            temperature: opts.temperature ?? 0.7,
            max_tokens: opts.maxTokens ?? 2048,
            stream: true,
        });

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) yield delta;
        }
    }
}

let _instance: GroqService | null = null;
export function getGroqService(): GroqService {
    if (!_instance) _instance = new GroqService();
    return _instance;
}
