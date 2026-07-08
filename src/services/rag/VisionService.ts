import {
    GeminiService,
    getGeminiService,
    isTransientGeminiError,
    MultiVisionResult,
    VisionResult,
} from "./GeminiService";
import { GroqService, getGroqService } from "./GroqService";
import ApiUsage from "../../models/ApiUsage";

export type VisionProvider = "gemini" | "groq_vision";

const SINGLE_PROMPT = `Analyze this food image and respond ONLY with valid JSON (no markdown, no explanation).

Required format:
{
  "main_dish_vi": "Vietnamese name of the main dish",
  "main_dish_en": "English name of the main dish",
  "components": ["ingredient1", "ingredient2"],
  "estimated_portion_grams": 300,
  "cuisine": "Vietnamese",
  "cooking_method": "boiled",
  "confidence": 0.85,
  "not_food": false
}

If the image does not contain food, set not_food: true and use empty strings for other fields.`;

const MULTI_PROMPT = `Analyze this food image that may contain MULTIPLE dishes or food items. Identify ALL distinct Vietnamese-relevant dishes/foods visible.
Respond ONLY with valid JSON (no markdown, no explanation).

Required format:
{
  "items": [
    { "name_vi": "Tên món (tiếng Việt)", "name_en": "Dish name (English)", "estimated_portion_grams": 200, "confidence": 0.9, "components": ["cơm", "sườn", "dưa leo"] },
    { "name_vi": "Tên món 2", "name_en": "Dish 2", "estimated_portion_grams": 150, "confidence": 0.85, "components": ["thành phần nhìn thấy"] }
  ],
  "not_food": false
}

Rules:
- List every distinct food item you can identify separately.
- Prefer common Vietnamese dish names when the image looks like Vietnamese food.
- Do not split a composed dish into ingredients unless the image clearly shows separate foods on the plate.
- If only one food item is visible, return an array with one element.
- If the image does not contain food, set not_food: true and items: [].
- Components are visible ingredients only; keep them short.
- Confidence 0–1 (how certain you are about the identification).`;

function stripFences(raw: string): string {
    return raw
        .trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
}

function trackVisionScan(provider: VisionProvider): void {
    const hour = new Date().toISOString().slice(0, 13);
    ApiUsage.findOneAndUpdate(
        { service: provider, hour },
        { $inc: { count: 1 } },
        { upsert: true },
    ).exec().catch(() => {});
}

/**
 * Cross-provider vision abstraction, mirroring LLMService's text fallback:
 * Primary: Gemini (with its internal retry + model fallback)
 * Fallback: Groq-hosted Llama-4 vision — a fully independent provider, since
 * peak-hour Gemini 503s hit every Gemini model at once.
 */
export class VisionService {
    private readonly gemini: GeminiService;
    private readonly groq: GroqService;

    constructor() {
        this.gemini = getGeminiService();
        this.groq = getGroqService();
    }

    async vision(imageBase64: string, mimeType: string): Promise<VisionResult> {
        const { text, provider } = await this._rawWithFallback(SINGLE_PROMPT, imageBase64, mimeType);
        const cleaned = stripFences(text);
        try {
            return JSON.parse(cleaned) as VisionResult;
        } catch {
            throw new Error(`${provider} vision returned invalid JSON: ${cleaned.slice(0, 200)}`);
        }
    }

    async visionMulti(imageBase64: string, mimeType: string): Promise<MultiVisionResult> {
        const { text, provider } = await this._rawWithFallback(MULTI_PROMPT, imageBase64, mimeType);
        const cleaned = stripFences(text);
        try {
            const parsed = JSON.parse(cleaned) as MultiVisionResult;
            return { items: parsed.items ?? [], not_food: parsed.not_food };
        } catch {
            throw new Error(`${provider} visionMulti returned invalid JSON: ${cleaned.slice(0, 200)}`);
        }
    }

    private async _rawWithFallback(
        prompt: string,
        imageBase64: string,
        mimeType: string,
    ): Promise<{ text: string; provider: VisionProvider }> {
        try {
            const text = await this.gemini.visionRaw(prompt, imageBase64, mimeType);
            trackVisionScan("gemini");
            return { text, provider: "gemini" };
        } catch (err) {
            if (!isTransientGeminiError(err)) throw err;
            console.warn(
                "[Vision] Gemini unavailable, falling back to Groq vision:",
                err instanceof Error ? err.message : err,
            );
            const text = await this.groq.visionRaw(prompt, imageBase64, mimeType, { maxTokens: 1024 });
            trackVisionScan("groq_vision");
            return { text, provider: "groq_vision" };
        }
    }
}

let _instance: VisionService | null = null;
export function getVisionService(): VisionService {
    if (!_instance) _instance = new VisionService();
    return _instance;
}
