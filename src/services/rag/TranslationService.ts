import { getGroqService, LLMMessage } from "./GroqService";

const BATCH_SIZE = 30;
const CACHE_MAX = 2000;

export interface TranslatedFood {
    name_vi: string;
    type: "dish" | "ingredient";
}

export class TranslationService {
    private readonly groq = getGroqService();
    // Normalized key: `${direction}:${text}` → translated string
    private readonly _cache = new Map<string, string>();
    // Key: `classify:${text}` → TranslatedFood
    private readonly _classifyCache = new Map<string, TranslatedFood>();

    private _cacheGet(direction: "vi2en" | "en2vi", text: string): string | undefined {
        return this._cache.get(`${direction}:${text.toLowerCase().trim()}`);
    }

    private _cacheSet(direction: "vi2en" | "en2vi", text: string, translated: string): void {
        if (this._cache.size >= CACHE_MAX) {
            // Evict oldest entry
            const firstKey = this._cache.keys().next().value;
            if (firstKey !== undefined) this._cache.delete(firstKey);
        }
        this._cache.set(`${direction}:${text.toLowerCase().trim()}`, translated);
    }

    /**
     * Translate an array of Vietnamese food names to English.
     * Used before sending to FatSecret (English-indexed DB, no region support).
     */
    async translateViToEn(names: string[]): Promise<string[]> {
        const results: string[] = new Array(names.length);
        const missIndices: number[] = [];

        for (let i = 0; i < names.length; i++) {
            const cached = this._cacheGet("vi2en", names[i]);
            if (cached !== undefined) {
                results[i] = cached;
            } else {
                missIndices.push(i);
            }
        }

        for (let b = 0; b < missIndices.length; b += BATCH_SIZE) {
            const batchIndices = missIndices.slice(b, b + BATCH_SIZE);
            const chunk = batchIndices.map((i) => names[i]);
            const translated = await this._translateChunkViToEn(chunk);
            for (let j = 0; j < batchIndices.length; j++) {
                results[batchIndices[j]] = translated[j];
                this._cacheSet("vi2en", names[batchIndices[j]], translated[j]);
            }
        }

        return results;
    }

    private async _translateChunkViToEn(names: string[], retries = 1): Promise<string[]> {
        const messages: LLMMessage[] = [
            {
                role: "system",
                content:
                    "You are a Vietnamese-to-English food translator. " +
                    "Translate the given Vietnamese dish/food names to short English equivalents suitable for a food database search. " +
                    "Return ONLY a JSON array of strings in the same order. No markdown, no explanation.",
            },
            {
                role: "user",
                content: JSON.stringify(names),
            },
        ];

        const response = await this.groq.generate(messages, { temperature: 0.2, maxTokens: 1024 });
        const text = response.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            if (retries > 0) return this._translateChunkViToEn(names, retries - 1);
            console.warn("[TranslationService] Vi→En JSON parse failed, using originals");
            return names;
        }

        if (!Array.isArray(parsed) || parsed.length !== names.length) {
            if (retries > 0) return this._translateChunkViToEn(names, retries - 1);
            console.warn("[TranslationService] Vi→En array length mismatch, using originals");
            return names;
        }

        return parsed as string[];
    }

    /**
     * Translate an array of English food descriptions to Vietnamese.
     * Processed in batches of 30 to balance context window vs API calls.
     */
    async translateBatch(descriptions: string[]): Promise<string[]> {
        const results: string[] = new Array(descriptions.length);
        const missIndices: number[] = [];

        for (let i = 0; i < descriptions.length; i++) {
            const cached = this._cacheGet("en2vi", descriptions[i]);
            if (cached !== undefined) {
                results[i] = cached;
            } else {
                missIndices.push(i);
            }
        }

        for (let b = 0; b < missIndices.length; b += BATCH_SIZE) {
            const batchIndices = missIndices.slice(b, b + BATCH_SIZE);
            const chunk = batchIndices.map((i) => descriptions[i]);
            const translated = await this._translateChunk(chunk);
            for (let j = 0; j < batchIndices.length; j++) {
                results[batchIndices[j]] = translated[j];
                this._cacheSet("en2vi", descriptions[batchIndices[j]], translated[j]);
            }
        }

        return results;
    }

    private async _translateChunk(descriptions: string[], retries = 1): Promise<string[]> {
        const messages: LLMMessage[] = [
            {
                role: "system",
                content:
                    "You are a professional food translator specializing in Vietnamese cuisine terminology. " +
                    "Translate the given English food descriptions to Vietnamese. " +
                    "Return ONLY a JSON array of strings in the same order. No markdown, no explanation.",
            },
            {
                role: "user",
                content: JSON.stringify(descriptions),
            },
        ];

        const response = await this.groq.generate(messages, { temperature: 0.3, maxTokens: 2048 });
        const text = response.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            if (retries > 0) return this._translateChunk(descriptions, retries - 1);
            // Fallback: return originals on parse failure
            console.warn("[TranslationService] JSON parse failed, using originals");
            return descriptions;
        }

        if (!Array.isArray(parsed) || parsed.length !== descriptions.length) {
            if (retries > 0) return this._translateChunk(descriptions, retries - 1);
            console.warn("[TranslationService] Array length mismatch, using originals");
            return descriptions;
        }

        return parsed as string[];
    }

    /**
     * Translate English food names to Vietnamese AND classify each as
     * "dish" (prepared meal) or "ingredient" (raw/single food item).
     * Combines both operations in one Groq call to save tokens and latency.
     * Results are cached separately from plain translations.
     */
    async translateAndClassify(names: string[]): Promise<TranslatedFood[]> {
        const results: TranslatedFood[] = new Array(names.length);
        const missIndices: number[] = [];

        for (let i = 0; i < names.length; i++) {
            const key = `classify:${names[i].toLowerCase().trim()}`;
            const cached = this._classifyCache.get(key);
            if (cached !== undefined) {
                results[i] = cached;
            } else {
                missIndices.push(i);
            }
        }

        for (let b = 0; b < missIndices.length; b += BATCH_SIZE) {
            const batchIndices = missIndices.slice(b, b + BATCH_SIZE);
            const chunk = batchIndices.map((i) => names[i]);
            const classified = await this._classifyChunk(chunk);
            for (let j = 0; j < batchIndices.length; j++) {
                results[batchIndices[j]] = classified[j];
                if (this._classifyCache.size >= CACHE_MAX) {
                    const first = this._classifyCache.keys().next().value;
                    if (first !== undefined) this._classifyCache.delete(first);
                }
                this._classifyCache.set(
                    `classify:${names[batchIndices[j]].toLowerCase().trim()}`,
                    classified[j],
                );
            }
        }

        return results;
    }

    private async _classifyChunk(names: string[], retries = 1): Promise<TranslatedFood[]> {
        const messages: LLMMessage[] = [
            {
                role: "system",
                content:
                    "You are a food expert and Vietnamese translator. " +
                    "For each English food name, translate it to Vietnamese and classify it.\n" +
                    "Classification rules:\n" +
                    "- \"dish\": a prepared/cooked meal or packaged food product " +
                    "(e.g. Grilled Chicken, Pho Bo Soup, Caesar Salad, Oreo Cookies)\n" +
                    "- \"ingredient\": a raw, unprocessed, or single-component food item " +
                    "(e.g. Chicken Breast, White Rice, Olive Oil, Salt, Egg)\n" +
                    "Return ONLY a JSON array in the same order: " +
                    "[{\"name_vi\": \"...\", \"type\": \"dish\"|\"ingredient\"}, ...]. " +
                    "No markdown, no explanation.",
            },
            {
                role: "user",
                content: JSON.stringify(names),
            },
        ];

        const response = await this.groq.generate(messages, { temperature: 0.2, maxTokens: 1024 });
        const text = response.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            if (retries > 0) return this._classifyChunk(names, retries - 1);
            console.warn("[TranslationService] classify JSON parse failed, using defaults");
            return names.map((n) => ({ name_vi: n, type: "ingredient" as const }));
        }

        if (!Array.isArray(parsed) || parsed.length !== names.length) {
            if (retries > 0) return this._classifyChunk(names, retries - 1);
            console.warn("[TranslationService] classify array length mismatch, using defaults");
            return names.map((n) => ({ name_vi: n, type: "ingredient" as const }));
        }

        return (parsed as Array<{ name_vi?: string; type?: string }>).map((item, i) => ({
            name_vi: typeof item?.name_vi === "string" ? item.name_vi : names[i],
            type: item?.type === "dish" ? "dish" : "ingredient",
        }));
    }
}

let _instance: TranslationService | null = null;
export function getTranslationService(): TranslationService {
    if (!_instance) _instance = new TranslationService();
    return _instance;
}
