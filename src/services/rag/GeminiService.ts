import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { LLMMessage, LLMOptions, LLMResponse } from "./GroqService";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-lite-latest";
// Paid tier default; lower via env if quota issues reappear.
const GEMINI_RPM = Number(process.env.GEMINI_RPM) || 60;

const RETRY_DELAYS_MS = [1000, 3000];

export function isTransientGeminiError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return /(^|\D)(429|503)(\D|$)|rate.?limit|overloaded|quota|resource.?exhausted|service unavailable|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/** Simple request-per-minute bucket, mirroring GroqService's TokenBucket. */
class RequestBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(private readonly capacity: number, private readonly refillPerMs: number) {
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    async consume(): Promise<void> {
        this._refill();
        if (this.tokens < 1) {
            const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
            await new Promise((r) => setTimeout(r, waitMs));
            this._refill();
        }
        this.tokens -= 1;
    }

    private _refill(): void {
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
        this.lastRefill = now;
    }
}

export interface VisionResult {
  main_dish_vi: string;
  main_dish_en: string;
  components: string[];
  estimated_portion_grams: number;
  cuisine: string;
  cooking_method: string;
  confidence: number;
  not_food?: boolean;
}

export interface VisionItemResult {
  name_vi: string;
  name_en: string;
  estimated_portion_grams: number;
  confidence: number;
  components?: string[];
}

export interface MultiVisionResult {
  items: VisionItemResult[];
  not_food?: boolean;
}

export class GeminiService {
  private readonly model: GenerativeModel;
  private readonly fallbackModel: GenerativeModel | null;
  private readonly bucket = new RequestBucket(GEMINI_RPM, GEMINI_RPM / 60_000);

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set");
    const genai = new GoogleGenerativeAI(key);
    this.model = genai.getGenerativeModel({ model: GEMINI_MODEL });
    this.fallbackModel = GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL
      ? genai.getGenerativeModel({ model: GEMINI_FALLBACK_MODEL })
      : null;
  }

  /**
   * Run a Gemini call with the request bucket, transient-error retries
   * (1s → 3s backoff), then one attempt on the fallback model. Peak-hour
   * 503s were reaching users directly because none of this existed.
   */
  private async _resilient<T>(run: (model: GenerativeModel) => Promise<T>): Promise<T> {
    await this.bucket.consume();

    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await run(this.model);
      } catch (err) {
        lastErr = err;
        if (!isTransientGeminiError(err) || attempt === RETRY_DELAYS_MS.length) break;
        console.warn(`[Gemini] transient error (attempt ${attempt + 1}), retrying:`, err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }

    if (this.fallbackModel && isTransientGeminiError(lastErr)) {
      console.warn(`[Gemini] primary model exhausted, trying fallback ${GEMINI_FALLBACK_MODEL}`);
      return run(this.fallbackModel);
    }
    throw lastErr;
  }

  async generate(
    messages: LLMMessage[],
    opts: LLMOptions = {},
  ): Promise<LLMResponse> {
    // Convert to Gemini format (system prompt separate)
    const systemMsg = messages.find((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");

    const chatHistory = userMessages.slice(0, -1).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const lastMsg = userMessages[userMessages.length - 1]?.content ?? "";

    return this._resilient(async (model) => {
      const chat = model.startChat({
        history: chatHistory,
        systemInstruction: systemMsg
          ? { role: "user", parts: [{ text: systemMsg.content }] }
          : undefined,
        generationConfig: {
          temperature: opts.temperature ?? 0.7,
          maxOutputTokens: opts.maxTokens ?? 1024,
        },
      });

      const result = await chat.sendMessage(lastMsg);
      return { content: result.response.text() };
    });
  }

  async *stream(
    messages: LLMMessage[],
    opts: LLMOptions = {},
  ): AsyncGenerator<string> {
    const systemMsg = messages.find((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");
    const lastMsg = userMessages[userMessages.length - 1]?.content ?? "";

    // Streams cannot retry mid-flight; the bucket + fallback still protect
    // the initial connection, which is where peak-hour 503s occur.
    const result = await this._resilient((model) => {
      const chat = model.startChat({
        systemInstruction: systemMsg
          ? { role: "user", parts: [{ text: systemMsg.content }] }
          : undefined,
        generationConfig: {
          temperature: opts.temperature ?? 0.7,
          maxOutputTokens: opts.maxTokens ?? 2048,
        },
      });
      return chat.sendMessageStream(lastMsg);
    });
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }

  /**
   * Raw vision call — prompt construction and JSON parsing live in
   * VisionService so the Groq fallback provider shares them exactly.
   */
  async visionRaw(prompt: string, imageBase64: string, mimeType: string): Promise<string> {
    const result = await this._resilient((model) => model.generateContent([
      prompt,
      { inlineData: { mimeType, data: imageBase64 } },
    ]));
    return result.response.text().trim();
  }
}

let _instance: GeminiService | null = null;
export function getGeminiService(): GeminiService {
  if (!_instance) _instance = new GeminiService();
  return _instance;
}
