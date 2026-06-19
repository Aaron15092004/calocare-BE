import { getGeminiService, VisionResult, VisionItemResult } from "./GeminiService";
import { getEmbeddingService } from "./EmbeddingService";
import { getRetrievalService, UnifiedSearchResult } from "./RetrievalService";
import { getEnrichmentService } from "./EnrichmentService";
import { Types } from "mongoose";
import UsdaFood from "../../models/UsdaFood";
import Food from "../../models/Food";
import Recipe from "../../models/Recipe";
import ApiUsage from "../../models/ApiUsage";

function trackGeminiScan(): void {
    const hour = new Date().toISOString().slice(0, 13);
    ApiUsage.findOneAndUpdate(
        { service: "gemini", hour },
        { $inc: { count: 1 } },
        { upsert: true },
    ).exec().catch(() => {});
}

export interface ScanFoodRequest {
    imageBase64: string;
    mimeType: string;
    userId?: string;
}

export interface ScanMatch {
    source_type: "food" | "recipe" | "usda" | "ai_estimate";
    source_id?: string;
    name: string;
    name_en?: string;
    confidence: number;
    energy_kcal?: number;
    protein?: number;
    lipid?: number;
    glucid?: number;
    estimated_portion_grams?: number;
    is_pending_import?: boolean;
    fdc_id?: number;
}

export interface ScanFoodResult {
    vision: VisionResult;
    primary_match?: ScanMatch;
    alternatives: ScanMatch[];
    fallback_used: boolean;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.75;

export class ScannerService {
    private readonly gemini = getGeminiService();
    private readonly embedding = getEmbeddingService();
    private readonly retrieval = getRetrievalService();
    private readonly enrichment = getEnrichmentService();

    async scan(req: ScanFoodRequest): Promise<ScanFoodResult> {
        // Step 1: Vision analysis
        const vision = await this.gemini.vision(req.imageBase64, req.mimeType);
        trackGeminiScan();

        if (vision.not_food) {
            return { vision, alternatives: [], fallback_used: false };
        }

        // Step 2: Embed the identified dish name
        const searchQuery = [vision.main_dish_vi, vision.main_dish_en]
            .filter(Boolean)
            .join(" | ");

        const queryVector = await this.embedding.embed(searchQuery, "query");

        // Step 3: Parallel vector search across all collections
        const [usdaResults, foodResults, recipeResults] = await Promise.all([
            this.retrieval.vectorSearch("usda", queryVector, { topK: 5 }).catch(() => []),
            this.retrieval.vectorSearch("food", queryVector, { topK: 5 }).catch(() => []),
            this.retrieval.vectorSearch("recipe", queryVector, { topK: 5 }).catch(() => []),
        ]);

        // Step 4: Find best match across all results
        const allResults: Array<UnifiedSearchResult & { raw_score: number }> = [
            ...foodResults.map((r) => ({
                source_type: "food" as const,
                source_id: r.payload?.source_id as string ?? r.id,
                name: r.payload?.name as string ?? "",
                score: r.score,
                diet_tags: r.payload?.diet_tags as string[] ?? [],
                raw_score: r.score,
            })),
            ...recipeResults.map((r) => ({
                source_type: "recipe" as const,
                source_id: r.payload?.source_id as string ?? r.id,
                name: r.payload?.name as string ?? "",
                score: r.score,
                diet_tags: r.payload?.diet_tags as string[] ?? [],
                raw_score: r.score,
            })),
            ...usdaResults.map((r) => ({
                source_type: "usda" as const,
                source_id: r.id,
                name: r.payload?.description_vi as string ?? r.payload?.description_en as string ?? "",
                score: r.score,
                diet_tags: r.payload?.diet_tags as string[] ?? [],
                fdc_id: r.payload?.fdc_id as number | undefined,
                imported_to_foods: r.payload?.imported_to_foods as boolean | undefined,
                raw_score: r.score,
            })),
        ].sort((a, b) => b.raw_score - a.raw_score);

        const topScore = allResults[0]?.raw_score ?? 0;

        if (topScore >= HIGH_CONFIDENCE_THRESHOLD) {
            // Good match found
            const primary = await this._hydrateMatch(
                allResults[0],
                vision.estimated_portion_grams,
            );
            const alternatives = await Promise.all(
                allResults.slice(1, 4).map((r) => this._hydrateMatch(r, undefined)),
            );

            // Queue enrichment for USDA hits
            const usdaHits = allResults
                .filter((r) => r.source_type === "usda" && r.raw_score > 0.6 && !r.imported_to_foods)
                .map((r) => ({
                    usda_food_id: r.source_id,
                    fdc_id: r.fdc_id!,
                    score: r.raw_score,
                }));
            if (usdaHits.length > 0) {
                this.enrichment
                    .queueEnrichment(usdaHits, {
                        type: "scan",
                        user_id: req.userId && Types.ObjectId.isValid(req.userId)
                            ? new Types.ObjectId(req.userId)
                            : undefined,
                    })
                    .catch(() => {});
            }

            // Queue recipe enrichment for high-score recipe hits
            const recipeHits = allResults
                .filter((r) => r.source_type === "recipe" && r.raw_score > 0.65)
                .map((r) => r.source_id);
            if (recipeHits.length > 0) {
                this.enrichment
                    .queueRecipeEnrichment(recipeHits, { type: "scan" })
                    .catch(() => {});
            }

            return {
                vision,
                primary_match: primary ?? undefined,
                alternatives: alternatives.filter((a): a is ScanMatch => a !== null),
                fallback_used: false,
            };
        }

        // Step 5: No confident match found. Return a clearly-labelled estimate so
        // the core scan flow remains useful while the verified food DB is growing.
        // This is never written back into Food/Recipe vectors.
        const aiEstimate = await this._geminiEstimateFallback(vision).catch(() => undefined);
        return {
            vision,
            primary_match: aiEstimate,
            alternatives: allResults
                .slice(0, 3)
                .filter((r) => r.raw_score > 0.4)
                .map((r) => ({
                    source_type: r.source_type,
                    source_id: r.source_id,
                    name: r.name,
                    confidence: r.raw_score,
                    fdc_id: r.fdc_id,
                })),
            fallback_used: true,
        };
    }

    private _cleanJson(raw: string): string {
        return raw
            .trim()
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();
    }

    private _clampNumber(value: unknown, min: number, max: number, fallback: number): number {
        const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
        return Math.round(Math.max(min, Math.min(max, n)) * 10) / 10;
    }

    private async _geminiEstimateFallback(vision: VisionResult): Promise<ScanMatch | undefined> {
        const dishName = vision.main_dish_vi || vision.main_dish_en;
        if (!dishName || (vision.confidence ?? 0) < 0.35) return undefined;

        const response = await this.gemini.generate(
            [
                {
                    role: "system",
                    content:
                        "Bạn ước tính dinh dưỡng món ăn theo khẩu phần phổ biến. " +
                        "Chỉ trả JSON hợp lệ, không markdown. Không dùng claim y tế.",
                },
                {
                    role: "user",
                    content:
                        `Ước tính dinh dưỡng trung bình trên 100g cho món: ${dishName}\n` +
                        `Tên tiếng Anh: ${vision.main_dish_en || ""}\n` +
                        `Thành phần nhìn thấy: ${(vision.components ?? []).join(", ")}\n` +
                        `Cách nấu: ${vision.cooking_method || "unknown"}\n` +
                        `JSON format: {"calories_per_100g":150,"protein_per_100g":8,"carbs_per_100g":20,"fat_per_100g":5,"confidence":0.4}`,
                },
            ],
            { temperature: 0.2, maxTokens: 300 },
        );

        type Estimate = {
            calories_per_100g?: number;
            protein_per_100g?: number;
            carbs_per_100g?: number;
            fat_per_100g?: number;
            confidence?: number;
        };
        const parsed = JSON.parse(this._cleanJson(response.content)) as Estimate;
        const calories = this._clampNumber(parsed.calories_per_100g, 5, 900, 150);
        return {
            source_type: "ai_estimate",
            name: dishName,
            name_en: vision.main_dish_en,
            confidence: Math.min(0.55, this._clampNumber(parsed.confidence, 0.2, 0.55, 0.4)),
            energy_kcal: calories,
            protein: this._clampNumber(parsed.protein_per_100g, 0, 80, 5),
            glucid: this._clampNumber(parsed.carbs_per_100g, 0, 100, 20),
            lipid: this._clampNumber(parsed.fat_per_100g, 0, 80, 5),
            estimated_portion_grams: this._clampNumber(vision.estimated_portion_grams, 20, 1500, 200),
        };
    }

    private async _hydrateMatch(
        result: UnifiedSearchResult & { raw_score: number },
        portionGrams?: number,
    ): Promise<ScanMatch | null> {
        try {
            if (result.source_type === "food") {
                const doc = await Food.findById(result.source_id)
                    .select("name_vi name_en energy_kcal protein lipid glucid")
                    .lean();
                if (!doc) return null;
                return {
                    source_type: "food",
                    source_id: result.source_id,
                    name: doc.name_vi,
                    name_en: doc.name_en,
                    confidence: result.raw_score,
                    energy_kcal: doc.energy_kcal,
                    protein: doc.protein,
                    lipid: doc.lipid,
                    glucid: doc.glucid,
                    estimated_portion_grams: portionGrams,
                };
            }

            if (result.source_type === "recipe") {
                const doc = await Recipe.findById(result.source_id)
                    .select("name_vi name_en calories protein fat carbs")
                    .lean();
                if (!doc) return null;
                return {
                    source_type: "recipe",
                    source_id: result.source_id,
                    name: doc.name_vi,
                    name_en: doc.name_en,
                    confidence: result.raw_score,
                    energy_kcal: doc.calories,
                    protein: doc.protein,
                    lipid: doc.fat,
                    glucid: doc.carbs,
                    estimated_portion_grams: portionGrams,
                };
            }

            if (result.source_type === "usda") {
                const doc = await UsdaFood.findById(result.source_id)
                    .select("description_vi description_en energy_kcal protein lipid glucid fdc_id imported_to_foods")
                    .lean();
                if (!doc) return null;
                return {
                    source_type: "usda",
                    source_id: result.source_id,
                    name: doc.description_vi ?? doc.description_en,
                    name_en: doc.description_en,
                    confidence: result.raw_score,
                    energy_kcal: doc.energy_kcal,
                    protein: doc.protein,
                    lipid: doc.lipid,
                    glucid: doc.glucid,
                    estimated_portion_grams: portionGrams,
                    is_pending_import: !doc.imported_to_foods,
                    fdc_id: doc.fdc_id,
                };
            }
        } catch {
            return null;
        }
        return null;
    }

    /**
     * SF-05: Multi-item scan — identify ALL dishes in one photo, resolve each via RAG.
     * Returns one ScanFoodResult per identified item (empty array if not_food).
     */
    async scanMulti(req: ScanFoodRequest): Promise<ScanFoodResult[]> {
        const multiVision = await this.gemini.visionMulti(req.imageBase64, req.mimeType);
        trackGeminiScan();
        if (multiVision.not_food || multiVision.items.length === 0) return [];

        const results = await Promise.all(
            multiVision.items.map((item) => this._scanSingleItem(item, req.userId)),
        );
        return results;
    }

    private async _scanSingleItem(item: VisionItemResult, userId?: string): Promise<ScanFoodResult> {
        const fakeVision: VisionResult = {
            main_dish_vi: item.name_vi,
            main_dish_en: item.name_en,
            components: [],
            estimated_portion_grams: item.estimated_portion_grams,
            cuisine: "",
            cooking_method: "",
            confidence: item.confidence,
        };

        const searchQuery = [item.name_vi, item.name_en].filter(Boolean).join(" | ");
        const queryVector = await this.embedding.embed(searchQuery, "query");

        const [usdaResults, foodResults, recipeResults] = await Promise.all([
            this.retrieval.vectorSearch("usda", queryVector, { topK: 3 }).catch(() => []),
            this.retrieval.vectorSearch("food", queryVector, { topK: 3 }).catch(() => []),
            this.retrieval.vectorSearch("recipe", queryVector, { topK: 3 }).catch(() => []),
        ]);

        const allResults = [
            ...foodResults.map((r) => ({ source_type: "food" as const, source_id: r.payload?.source_id as string ?? r.id, name: r.payload?.name as string ?? "", score: r.score, diet_tags: [] as string[], raw_score: r.score })),
            ...recipeResults.map((r) => ({ source_type: "recipe" as const, source_id: r.payload?.source_id as string ?? r.id, name: r.payload?.name as string ?? "", score: r.score, diet_tags: [] as string[], raw_score: r.score })),
            ...usdaResults.map((r) => ({ source_type: "usda" as const, source_id: r.id, name: r.payload?.description_vi as string ?? r.payload?.description_en as string ?? "", score: r.score, diet_tags: [] as string[], raw_score: r.score, fdc_id: r.payload?.fdc_id as number | undefined, imported_to_foods: r.payload?.imported_to_foods as boolean | undefined })),
        ].sort((a, b) => b.raw_score - a.raw_score);

        const topScore = allResults[0]?.raw_score ?? 0;

        if (topScore >= HIGH_CONFIDENCE_THRESHOLD) {
            const primary = await this._hydrateMatch(allResults[0], item.estimated_portion_grams);
            return { vision: fakeVision, primary_match: primary ?? undefined, alternatives: [], fallback_used: false };
        }

        return { vision: fakeVision, primary_match: undefined, alternatives: [], fallback_used: false };
    }

    // TODO(post-deploy): _geminiEstimateFallback is BLOCKED.
    // This method called Gemini to invent per-100g nutrition when vector-search
    // confidence was below 0.75. Results were stored in AISuggestedFood and
    // served as real data to users — causing hallucinated nutrition.
    // Re-enable only after USDA+Food vector index coverage ≥ 80% of VN foods,
    // AND add a human-review step before results are returned to users.
    //
    // private async _geminiEstimateFallback(...) { ... }
}

let _instance: ScannerService | null = null;
export function getScannerService(): ScannerService {
    if (!_instance) _instance = new ScannerService();
    return _instance;
}
