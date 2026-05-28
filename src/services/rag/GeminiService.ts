import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { LLMMessage, LLMOptions, LLMResponse } from "./GroqService";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

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
}

export interface MultiVisionResult {
  items: VisionItemResult[];
  not_food?: boolean;
}

export class GeminiService {
  private readonly model: GenerativeModel;

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set");
    const genai = new GoogleGenerativeAI(key);
    this.model = genai.getGenerativeModel({ model: GEMINI_MODEL });
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

    const chat = this.model.startChat({
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
  }

  async *stream(
    messages: LLMMessage[],
    opts: LLMOptions = {},
  ): AsyncGenerator<string> {
    const systemMsg = messages.find((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");
    const lastMsg = userMessages[userMessages.length - 1]?.content ?? "";

    const chat = this.model.startChat({
      systemInstruction: systemMsg
        ? { role: "user", parts: [{ text: systemMsg.content }] }
        : undefined,
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxTokens ?? 2048,
      },
    });

    const result = await chat.sendMessageStream(lastMsg);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }

  async vision(imageBase64: string, mimeType: string): Promise<VisionResult> {
    const prompt = `Analyze this food image and respond ONLY with valid JSON (no markdown, no explanation).

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

    const result = await this.model.generateContent([
      prompt,
      { inlineData: { mimeType, data: imageBase64 } },
    ]);

    const text = result.response.text().trim();
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    try {
      return JSON.parse(cleaned) as VisionResult;
    } catch {
      throw new Error(
        `Gemini vision returned invalid JSON: ${cleaned.slice(0, 200)}`,
      );
    }
  }

  async visionMulti(
    imageBase64: string,
    mimeType: string,
  ): Promise<MultiVisionResult> {
    const prompt = `Analyze this food image that may contain MULTIPLE dishes or food items. Identify ALL distinct dishes/foods visible.
Respond ONLY with valid JSON (no markdown, no explanation).

Required format:
{
  "items": [
    { "name_vi": "Tên món (tiếng Việt)", "name_en": "Dish name (English)", "estimated_portion_grams": 200, "confidence": 0.9 },
    { "name_vi": "Tên món 2", "name_en": "Dish 2", "estimated_portion_grams": 150, "confidence": 0.85 }
  ],
  "not_food": false
}

Rules:
- List every distinct food item you can identify separately.
- If only one food item is visible, return an array with one element.
- If the image does not contain food, set not_food: true and items: [].
- Confidence 0–1 (how certain you are about the identification).`;

    const result = await this.model.generateContent([
      prompt,
      { inlineData: { mimeType, data: imageBase64 } },
    ]);

    const text = result.response.text().trim();
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned) as MultiVisionResult;
      return { items: parsed.items ?? [], not_food: parsed.not_food };
    } catch {
      throw new Error(
        `Gemini visionMulti returned invalid JSON: ${cleaned.slice(0, 200)}`,
      );
    }
  }
}

let _instance: GeminiService | null = null;
export function getGeminiService(): GeminiService {
  if (!_instance) _instance = new GeminiService();
  return _instance;
}
