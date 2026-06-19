import { getGeminiService, VisionResult, VisionItemResult } from "./GeminiService";
import { getEmbeddingService } from "./EmbeddingService";
import { getRetrievalService, UnifiedSearchResult } from "./RetrievalService";
import { getEnrichmentService } from "./EnrichmentService";
import { Types } from "mongoose";
import UsdaFood from "../../models/UsdaFood";
import Food from "../../models/Food";
import Recipe from "../../models/Recipe";
import RecipeIngredient from "../../models/RecipeIngredient";
import ApiUsage from "../../models/ApiUsage";
import { withTimeout } from "../../utils/asyncTimeout";
import { getFatSecretService } from "./FatSecretService";
import { FatSecretImportService, getFatSecretImportService } from "./FatSecretImportService";

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
    source_type: "food" | "recipe" | "usda" | "fatsecret" | "ai_estimate";
    source_id?: string;
    name: string;
    name_en?: string;
    confidence: number;
    energy_kcal?: number;
    protein?: number;
    lipid?: number;
    glucid?: number;
    fiber?: number;
    estimated_portion_grams?: number;
    is_pending_import?: boolean;
    fdc_id?: number;
    fs_food_id?: string;
    source_note?: string;
}

export interface ScanFoodResult {
    vision: VisionResult;
    primary_match?: ScanMatch;
    alternatives: ScanMatch[];
    fallback_used: boolean;
    fallback_reason?: "low_confidence" | "embedding_unavailable";
    timings_ms?: Record<string, number>;
}

export interface ScanIngredient {
    name: string;
    amount?: number;
    unit?: string;
}

export interface ScanNutrition {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number;
}

export interface ScanVitamin {
    name: string;
    amount: number;
    unit: string;
    percent_dv: number;
}

export interface ScanMealDish {
    dish_name: string;
    source: "recipe" | "food" | "fatsecret" | "usda" | "ai_estimate";
    matched_name: string | null;
    nutrition: ScanNutrition;
    weight_grams: number;
    confidence: number;
    source_id?: string;
    fs_food_id?: string;
    ingredients?: ScanIngredient[];
    vitamins?: ScanVitamin[];
    source_note?: string;
}

export interface ScanMealResult {
    dishes: ScanMealDish[];
    totals: ScanNutrition;
    vitamins: ScanVitamin[];
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    not_food?: boolean;
    fallback_used: boolean;
    fallback_reason?: "low_confidence" | "embedding_unavailable";
    timings_ms?: Record<string, number>;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.75;
const LOCAL_RECIPE_THRESHOLD = 0.72;
const LOCAL_FOOD_THRESHOLD = 0.78;
const FATSECRET_THRESHOLD = 0.68;
const USDA_FALLBACK_THRESHOLD = 0.9;
const VISION_TIMEOUT_MS = Number(process.env.SCAN_VISION_TIMEOUT_MS ?? 45_000);
const EMBEDDING_TIMEOUT_MS = Number(process.env.SCAN_EMBEDDING_TIMEOUT_MS ?? 12_000);
const VECTOR_TIMEOUT_MS = Number(process.env.SCAN_VECTOR_TIMEOUT_MS ?? 2_000);
const HYDRATE_TIMEOUT_MS = Number(process.env.SCAN_HYDRATE_TIMEOUT_MS ?? 1_500);

export class ScannerService {
    private readonly gemini = getGeminiService();
    private readonly embedding = getEmbeddingService();
    private readonly retrieval = getRetrievalService();
    private readonly enrichment = getEnrichmentService();

    async scan(req: ScanFoodRequest): Promise<ScanFoodResult> {
        const timings_ms: Record<string, number> = {};

        // Step 1: Vision analysis
        const vision = await this._timed(
            timings_ms,
            "vision",
            () => this.gemini.vision(req.imageBase64, req.mimeType),
            VISION_TIMEOUT_MS,
        );
        trackGeminiScan();

        if (vision.not_food) {
            return { vision, alternatives: [], fallback_used: false, timings_ms };
        }

        // Step 2: Embed the identified dish name
        const searchQuery = [vision.main_dish_vi, vision.main_dish_en]
            .filter(Boolean)
            .join(" | ");

        let queryVector: number[];
        try {
            queryVector = await this._timed(
                timings_ms,
                "embedding",
                () => this.embedding.embed(searchQuery, "query"),
                EMBEDDING_TIMEOUT_MS,
            );
        } catch {
            return {
                vision,
                primary_match: this._quickVisionEstimate(vision),
                alternatives: [],
                fallback_used: true,
                fallback_reason: "embedding_unavailable",
                timings_ms,
            };
        }

        // Step 3: Parallel vector search across all collections
        const [usdaResults, foodResults, recipeResults] = await Promise.all([
            this._timed(
                timings_ms,
                "vector_usda",
                () => this.retrieval.vectorSearch("usda", queryVector, { topK: 5 }),
                VECTOR_TIMEOUT_MS,
            ).catch(() => []),
            this._timed(
                timings_ms,
                "vector_food",
                () => this.retrieval.vectorSearch("food", queryVector, { topK: 5 }),
                VECTOR_TIMEOUT_MS,
            ).catch(() => []),
            this._timed(
                timings_ms,
                "vector_recipe",
                () => this.retrieval.vectorSearch("recipe", queryVector, { topK: 5 }),
                VECTOR_TIMEOUT_MS,
            ).catch(() => []),
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
            const primary = await this._timed(
                timings_ms,
                "hydrate_primary",
                () => this._hydrateMatch(allResults[0], vision.estimated_portion_grams),
                HYDRATE_TIMEOUT_MS,
            ).catch(() => null);
            const alternatives = await this._timed(
                timings_ms,
                "hydrate_alternatives",
                () => Promise.all(
                    allResults.slice(1, 4).map((r) =>
                        withTimeout(this._hydrateMatch(r, undefined), HYDRATE_TIMEOUT_MS, "hydrate_alternative").catch(() => null),
                    ),
                ),
                HYDRATE_TIMEOUT_MS * 2,
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
                timings_ms,
            };
        }

        // Step 5: No confident match found. Return a quick, clearly-labelled
        // estimate derived from the first vision pass instead of blocking the
        // realtime scan path on a second LLM call.
        const aiEstimate = this._quickVisionEstimate(vision);
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
            fallback_reason: "low_confidence",
            timings_ms,
        };
    }

    async scanMeal(req: ScanFoodRequest): Promise<ScanMealResult> {
        const timings_ms: Record<string, number> = {};
        const multiVision = await this._timed(
            timings_ms,
            "vision_multi",
            () => this.gemini.visionMulti(req.imageBase64, req.mimeType),
            VISION_TIMEOUT_MS,
        );
        trackGeminiScan();

        if (multiVision.not_food || multiVision.items.length === 0) {
            return {
                not_food: true,
                dishes: [],
                totals: this._emptyNutrition(),
                vitamins: [],
                meal_type: this._guessMealType(),
                fallback_used: false,
                timings_ms,
            };
        }

        const items = multiVision.items
            .filter((item) => (item.name_vi || item.name_en) && (item.confidence ?? 0) >= 0.2)
            .slice(0, 6);

        const dishes = (await Promise.all(
            items.map((item) => this._resolveMealItem(item, req.userId).catch(() => null)),
        )).filter((dish): dish is ScanMealDish => dish !== null);

        return {
            dishes,
            totals: this._sumNutrition(dishes.map((dish) => dish.nutrition)),
            vitamins: this._aggregateVitamins(dishes.flatMap((dish) => dish.vitamins ?? [])),
            meal_type: this._guessMealType(),
            fallback_used: dishes.some((dish) => dish.source === "ai_estimate" || dish.source === "usda"),
            fallback_reason: dishes.some((dish) => dish.source === "ai_estimate") ? "low_confidence" : undefined,
            timings_ms,
        };
    }

    private async _timed<T>(
        timings: Record<string, number>,
        stage: string,
        fn: () => Promise<T>,
        timeoutMs: number,
    ): Promise<T> {
        const startedAt = Date.now();
        try {
            return await withTimeout(fn(), timeoutMs, stage);
        } finally {
            timings[stage] = Date.now() - startedAt;
        }
    }

    private async _resolveMealItem(item: VisionItemResult, userId?: string): Promise<ScanMealDish> {
        const grams = this._clampNumber(item.estimated_portion_grams, 20, 1500, 200);

        const recipe = await this._findRecipeByName(item);
        if (recipe) return this._dishFromRecipe(item, recipe.doc, recipe.score, grams);

        const food = await this._findFoodByName(item);
        if (food) return this._dishFromFood(item, food.doc, food.score, grams);

        const vectorLocal = await this._findVectorLocalDish(item, grams);
        if (vectorLocal) return vectorLocal;

        const fatsecret = await this._findFatSecretDish(item, grams);
        if (fatsecret) return fatsecret;

        const usda = await this._findUsdaFallbackDish(item, grams, userId);
        if (usda) return usda;

        return this._dishFromVisionEstimate(item, grams);
    }

    private _candidateNames(item: VisionItemResult): string[] {
        return [...new Set([item.name_vi, item.name_en].filter((name): name is string => !!name?.trim()))];
    }

    private _escapeRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private _loosePhraseRegex(value: string): RegExp {
        const escaped = value
            .trim()
            .split(/\s+/)
            .map((part) => this._escapeRegex(part))
            .join("\\s+");
        return new RegExp(escaped, "i");
    }

    private _normalizeName(value?: string | null): string {
        return (value ?? "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/đ/g, "d")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    private _tokens(value?: string | null): string[] {
        const stop = new Set(["mon", "phan", "dia", "bat", "chen", "suat", "cai", "mot", "nhieu"]);
        return this._normalizeName(value)
            .split(" ")
            .filter((token) => token.length > 1 && !stop.has(token));
    }

    private _nameSimilarity(query?: string | null, candidate?: string | null): number {
        const q = this._normalizeName(query);
        const c = this._normalizeName(candidate);
        if (!q || !c) return 0;
        if (q === c) return 1;

        const qTokens = this._tokens(q);
        const cTokens = this._tokens(c);
        if (qTokens.length === 0 || cTokens.length === 0) return 0;

        const qSet = new Set(qTokens);
        const cSet = new Set(cTokens);
        const overlap = qTokens.filter((token) => cSet.has(token)).length;
        const coverageQ = overlap / qSet.size;
        const coverageC = overlap / cSet.size;
        const dice = (2 * overlap) / (qSet.size + cSet.size);

        let score = coverageQ * 0.45 + coverageC * 0.35 + dice * 0.2;
        if (c.includes(q) || q.includes(c)) {
            const lengthRatio = Math.min(q.length, c.length) / Math.max(q.length, c.length);
            score = Math.max(score, 0.78 + lengthRatio * 0.12);
        }
        if (qTokens.length === 1 && cTokens.length > 1 && q !== c) {
            score = Math.min(score, 0.69);
        }
        return Math.max(0, Math.min(1, score));
    }

    private _scoreCandidate(item: VisionItemResult, candidateVi?: string | null, candidateEn?: string | null): number {
        const candidateNames = [candidateVi, candidateEn].filter(Boolean) as string[];
        const queryNames = this._candidateNames(item);
        let best = 0;
        for (const query of queryNames) {
            for (const candidate of candidateNames) {
                best = Math.max(best, this._nameSimilarity(query, candidate));
            }
        }
        return best;
    }

    private async _findRecipeByName(item: VisionItemResult): Promise<{ doc: any; score: number } | null> {
        const names = this._candidateNames(item);
        if (names.length === 0) return null;
        const regexes = names.map((name) => this._loosePhraseRegex(name));
        const docs = await Recipe.find({
            is_approved: true,
            is_deleted: { $ne: true },
            $or: [
                ...regexes.map((regex) => ({ name_vi: regex })),
                ...regexes.map((regex) => ({ name_en: regex })),
            ],
        })
            .limit(12)
            .select("name_vi name_en calories protein carbs fat fiber servings total_weight nutrients_extended nutrition_source tags")
            .lean();

        const ranked = docs
            .map((doc) => ({ doc, score: this._scoreCandidate(item, doc.name_vi, doc.name_en) }))
            .sort((a, b) => b.score - a.score);
        return ranked[0]?.score >= LOCAL_RECIPE_THRESHOLD ? ranked[0] : null;
    }

    private async _findFoodByName(item: VisionItemResult): Promise<{ doc: any; score: number } | null> {
        const names = this._candidateNames(item);
        if (names.length === 0) return null;
        const regexes = names.map((name) => this._loosePhraseRegex(name));
        const normalizedNames = names.map((name) => this._normalizeName(name));
        const docs = await Food.find({
            is_approved: true,
            is_deleted: { $ne: true },
            $or: [
                ...regexes.map((regex) => ({ name_vi: regex })),
                ...regexes.map((regex) => ({ name_en: regex })),
                { search_keywords: { $in: normalizedNames } },
            ],
        })
            .limit(12)
            .select("name_vi name_en energy_kcal protein lipid glucid fiber nutrients_extended source_reference")
            .lean();

        const ranked = docs
            .map((doc) => ({ doc, score: this._scoreCandidate(item, doc.name_vi, doc.name_en) }))
            .sort((a, b) => b.score - a.score);
        return ranked[0]?.score >= LOCAL_FOOD_THRESHOLD ? ranked[0] : null;
    }

    private async _findVectorLocalDish(item: VisionItemResult, grams: number): Promise<ScanMealDish | null> {
        const query = this._candidateNames(item).join(" | ");
        if (!query) return null;
        try {
            const queryVector = await withTimeout(this.embedding.embed(query, "query"), EMBEDDING_TIMEOUT_MS, "embedding");
            const [recipeResults, foodResults] = await Promise.all([
                this.retrieval.vectorSearch("recipe", queryVector, { topK: 5 }).catch(() => []),
                this.retrieval.vectorSearch("food", queryVector, { topK: 5 }).catch(() => []),
            ]);

            const recipeCandidates = await Promise.all(
                recipeResults
                    .filter((result) => result.score >= HIGH_CONFIDENCE_THRESHOLD)
                    .map(async (result) => {
                        const doc = await Recipe.findById(result.payload?.source_id as string ?? result.id)
                            .select("name_vi name_en calories protein carbs fat fiber servings total_weight nutrients_extended nutrition_source tags")
                            .lean();
                        if (!doc || doc.is_deleted || !doc.is_approved) return null;
                        const lexical = this._scoreCandidate(item, doc.name_vi, doc.name_en);
                        return { doc, score: result.score * 0.65 + lexical * 0.35, lexical };
                    }),
            );
            const bestRecipe = recipeCandidates
                .filter((candidate): candidate is { doc: any; score: number; lexical: number } => !!candidate)
                .sort((a, b) => b.score - a.score)[0];
            if (bestRecipe && bestRecipe.score >= 0.78 && bestRecipe.lexical >= 0.52) {
                return this._dishFromRecipe(item, bestRecipe.doc, bestRecipe.score, grams);
            }

            const foodCandidates = await Promise.all(
                foodResults
                    .filter((result) => result.score >= HIGH_CONFIDENCE_THRESHOLD)
                    .map(async (result) => {
                        const doc = await Food.findById(result.payload?.source_id as string ?? result.id)
                            .select("name_vi name_en energy_kcal protein lipid glucid fiber nutrients_extended source_reference is_approved is_deleted")
                            .lean();
                        if (!doc || doc.is_deleted || !doc.is_approved) return null;
                        const lexical = this._scoreCandidate(item, doc.name_vi, doc.name_en);
                        return { doc, score: result.score * 0.65 + lexical * 0.35, lexical };
                    }),
            );
            const bestFood = foodCandidates
                .filter((candidate): candidate is { doc: any; score: number; lexical: number } => !!candidate)
                .sort((a, b) => b.score - a.score)[0];
            if (bestFood && bestFood.score >= 0.8 && bestFood.lexical >= 0.55) {
                return this._dishFromFood(item, bestFood.doc, bestFood.score, grams);
            }
        } catch {
            return null;
        }
        return null;
    }

    private async _findFatSecretDish(item: VisionItemResult, grams: number): Promise<ScanMealDish | null> {
        if (!FatSecretImportService.isAvailable()) return null;
        const queryNames = this._candidateNames(item);
        const query = item.name_en || item.name_vi || queryNames[0];
        if (!query) return null;

        try {
            const items = await getFatSecretService().searchFoodsV5(query, 5);
            const candidates = items
                .map((fsFood) => {
                    const per100g = getFatSecretService().extractPer100g(fsFood);
                    if (!per100g) return null;
                    const score = Math.max(
                        ...queryNames.map((name) => this._nameSimilarity(name, fsFood.food_name)),
                    );
                    return { fsFood, per100g, score };
                })
                .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
                .sort((a, b) => b.score - a.score);

            const best = candidates[0];
            if (!best || best.score < FATSECRET_THRESHOLD) return null;

            getFatSecretImportService()
                .upsertFromV5Food(best.fsFood, item.name_vi || undefined)
                .catch(() => {});

            return {
                dish_name: item.name_vi || best.fsFood.food_name,
                source: "fatsecret",
                matched_name: item.name_vi || best.fsFood.food_name,
                nutrition: this._nutritionFromPer100g(
                    best.per100g.energy_kcal,
                    best.per100g.protein,
                    best.per100g.glucid,
                    best.per100g.lipid,
                    best.per100g.fiber,
                    grams,
                ),
                weight_grams: grams,
                confidence: Math.min(0.82, Math.max(best.score, item.confidence ?? 0.5)),
                fs_food_id: best.fsFood.food_id,
                ingredients: this._ingredientsFromVision(item),
                source_note: `FatSecret: ${best.fsFood.food_name}`,
            };
        } catch {
            return null;
        }
    }

    private async _findUsdaFallbackDish(item: VisionItemResult, grams: number, userId?: string): Promise<ScanMealDish | null> {
        if (process.env.SCAN_ALLOW_USDA_FALLBACK === "false") return null;
        const query = this._candidateNames(item).join(" | ");
        if (!query) return null;

        try {
            const queryVector = await withTimeout(this.embedding.embed(query, "query"), EMBEDDING_TIMEOUT_MS, "embedding");
            const results = await this.retrieval.vectorSearch("usda", queryVector, { topK: 5 }).catch(() => []);
            for (const result of results.filter((r) => r.score >= USDA_FALLBACK_THRESHOLD)) {
                const doc = await UsdaFood.findById(result.id)
                    .select("description_vi description_en energy_kcal protein lipid glucid fiber fdc_id imported_to_foods nutrients_extended")
                    .lean();
                if (!doc?.description_vi) continue;
                const lexical = this._scoreCandidate(item, doc.description_vi, doc.description_en);
                if (lexical < 0.55) continue;

                if (!doc.imported_to_foods) {
                    this.enrichment
                        .queueEnrichment(
                            [{ usda_food_id: String(doc._id), fdc_id: doc.fdc_id, score: result.score }],
                            {
                                type: "scan",
                                user_id: userId && Types.ObjectId.isValid(userId)
                                    ? new Types.ObjectId(userId)
                                    : undefined,
                            },
                        )
                        .catch(() => {});
                }

                return {
                    dish_name: item.name_vi || doc.description_vi,
                    source: "usda",
                    matched_name: doc.description_vi,
                    nutrition: this._nutritionFromPer100g(
                        doc.energy_kcal,
                        doc.protein,
                        doc.glucid,
                        doc.lipid,
                        doc.fiber ?? 0,
                        grams,
                    ),
                    weight_grams: grams,
                    confidence: Math.min(0.78, result.score * 0.7 + lexical * 0.3),
                    source_id: String(doc._id),
                    ingredients: this._ingredientsFromVision(item),
                    vitamins: this._vitaminsFromExtended(doc.nutrients_extended as Record<string, unknown> | undefined, grams / 100),
                    source_note: "Nguồn quốc tế, dùng khi chưa có match nội bộ đủ tin cậy.",
                };
            }
        } catch {
            return null;
        }
        return null;
    }

    private async _dishFromRecipe(item: VisionItemResult, recipe: any, confidence: number, grams: number): Promise<ScanMealDish> {
        const totalWeight = Number(recipe.total_weight || 0);
        const scale = totalWeight > 0 ? grams / totalWeight : 1;
        return {
            dish_name: item.name_vi || recipe.name_vi,
            source: "recipe",
            matched_name: recipe.name_vi,
            nutrition: this._scaleNutrition({
                calories: Number(recipe.calories || 0),
                protein: Number(recipe.protein || 0),
                carbs: Number(recipe.carbs || 0),
                fat: Number(recipe.fat || 0),
                fiber: Number(recipe.fiber || 0),
            }, scale),
            weight_grams: grams,
            confidence: Math.min(0.98, confidence),
            source_id: String(recipe._id),
            ingredients: await this._getRecipeIngredients(String(recipe._id)),
            vitamins: this._vitaminsFromExtended(recipe.nutrients_extended as Record<string, unknown> | undefined, scale),
        };
    }

    private _dishFromFood(item: VisionItemResult, food: any, confidence: number, grams: number): ScanMealDish {
        return {
            dish_name: item.name_vi || food.name_vi,
            source: "food",
            matched_name: food.name_vi,
            nutrition: this._nutritionFromPer100g(
                food.energy_kcal,
                food.protein,
                food.glucid,
                food.lipid,
                food.fiber ?? 0,
                grams,
            ),
            weight_grams: grams,
            confidence: Math.min(0.96, confidence),
            source_id: String(food._id),
            ingredients: this._ingredientsFromVision(item),
            vitamins: this._vitaminsFromExtended(food.nutrients_extended as Record<string, unknown> | undefined, grams / 100),
        };
    }

    private _dishFromVisionEstimate(item: VisionItemResult, grams: number): ScanMealDish {
        const fakeVision: VisionResult = {
            main_dish_vi: item.name_vi,
            main_dish_en: item.name_en,
            components: item.components ?? [],
            estimated_portion_grams: grams,
            cuisine: "",
            cooking_method: "",
            confidence: item.confidence,
        };
        const estimate = this._quickVisionEstimate(fakeVision);
        return {
            dish_name: item.name_vi || item.name_en || "Món ăn",
            source: "ai_estimate",
            matched_name: item.name_vi || item.name_en || "Món ăn",
            nutrition: this._nutritionFromPer100g(
                estimate?.energy_kcal ?? 160,
                estimate?.protein ?? 6,
                estimate?.glucid ?? 20,
                estimate?.lipid ?? 6,
                estimate?.fiber ?? 0,
                grams,
            ),
            weight_grams: grams,
            confidence: Math.min(0.45, item.confidence ?? 0.35),
            ingredients: this._ingredientsFromVision(item),
            source_note: "Ước tính khi chưa có dữ liệu nội bộ đủ tin cậy.",
        };
    }

    private _ingredientsFromVision(item: VisionItemResult): ScanIngredient[] | undefined {
        const components = (item.components ?? [])
            .map((name) => name.trim())
            .filter(Boolean)
            .slice(0, 8);
        return components.length ? components.map((name) => ({ name })) : undefined;
    }

    private async _getRecipeIngredients(recipeId: string): Promise<ScanIngredient[] | undefined> {
        const ingredients = await RecipeIngredient.find({ recipe_id: recipeId })
            .sort({ sort_order: 1 })
            .populate("food_id", "name_vi name_en")
            .populate("ingredient_recipe_id", "name_vi name_en")
            .lean();
        const mapped = ingredients
            .map((ingredient: any) => ({
                name: ingredient.food_id?.name_vi
                    || ingredient.ingredient_recipe_id?.name_vi
                    || ingredient.food_id?.name_en
                    || ingredient.ingredient_recipe_id?.name_en
                    || "",
                amount: ingredient.amount,
                unit: ingredient.unit,
            }))
            .filter((ingredient) => ingredient.name);
        return mapped.length ? mapped : undefined;
    }

    private _nutritionFromPer100g(
        calories: number | undefined,
        protein: number | undefined,
        carbs: number | undefined,
        fat: number | undefined,
        fiber: number | undefined,
        grams: number,
    ): ScanNutrition {
        return this._scaleNutrition({
            calories: Number(calories || 0),
            protein: Number(protein || 0),
            carbs: Number(carbs || 0),
            fat: Number(fat || 0),
            fiber: Number(fiber || 0),
        }, grams / 100);
    }

    private _scaleNutrition(nutrition: ScanNutrition, scale: number): ScanNutrition {
        return {
            calories: Math.round(nutrition.calories * scale),
            protein: this._round1(nutrition.protein * scale),
            carbs: this._round1(nutrition.carbs * scale),
            fat: this._round1(nutrition.fat * scale),
            fiber: this._round1(nutrition.fiber * scale),
        };
    }

    private _emptyNutrition(): ScanNutrition {
        return { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
    }

    private _sumNutrition(items: ScanNutrition[]): ScanNutrition {
        return items.reduce(
            (sum, item) => ({
                calories: sum.calories + item.calories,
                protein: this._round1(sum.protein + item.protein),
                carbs: this._round1(sum.carbs + item.carbs),
                fat: this._round1(sum.fat + item.fat),
                fiber: this._round1(sum.fiber + item.fiber),
            }),
            this._emptyNutrition(),
        );
    }

    private _round1(value: number): number {
        return Math.round(value * 10) / 10;
    }

    private _guessMealType(): ScanMealResult["meal_type"] {
        const hour = new Date().getHours();
        if (hour >= 5 && hour < 10) return "breakfast";
        if (hour >= 10 && hour < 14) return "lunch";
        if (hour >= 14 && hour < 17) return "snack";
        return "dinner";
    }

    private _vitaminsFromExtended(extended: Record<string, unknown> | undefined, scale: number): ScanVitamin[] {
        if (!extended) return [];
        const buckets: Record<string, unknown>[] = [];
        for (const key of ["vitamins", "minerals"]) {
            const value = extended[key];
            if (value && typeof value === "object" && !Array.isArray(value)) {
                buckets.push(value as Record<string, unknown>);
            }
        }
        buckets.push(extended);

        const vitamins: ScanVitamin[] = [];
        const seen = new Set<string>();
        for (const bucket of buckets) {
            for (const [rawKey, rawValue] of Object.entries(bucket)) {
                if (rawKey === "vitamins" || rawKey === "minerals" || typeof rawValue !== "number") continue;
                const key = rawKey.toLowerCase();
                if (!/(vitamin|calcium|iron|magnesium|phosphorus|potassium|sodium|zinc|folate|canxi|sat|kali|magie|kem)/i.test(key)) continue;
                const unit = key.includes("mcg") || key.includes("µg") ? "mcg" : key.includes("_g") ? "g" : "mg";
                const name = rawKey
                    .replace(/_/g, " ")
                    .replace(/\b(mg|mcg|µg|g)\b/gi, "")
                    .replace(/\s+/g, " ")
                    .trim();
                const id = `${name.toLowerCase()}_${unit}`;
                if (seen.has(id)) continue;
                seen.add(id);
                vitamins.push({
                    name,
                    amount: this._round1(rawValue * scale),
                    unit,
                    percent_dv: 0,
                });
            }
        }
        return vitamins.filter((vitamin) => vitamin.amount > 0).slice(0, 16);
    }

    private _aggregateVitamins(vitamins: ScanVitamin[]): ScanVitamin[] {
        const byKey = new Map<string, ScanVitamin>();
        for (const vitamin of vitamins) {
            const key = `${vitamin.name.toLowerCase()}_${vitamin.unit}`;
            const existing = byKey.get(key);
            if (existing) {
                existing.amount = this._round1(existing.amount + vitamin.amount);
            } else {
                byKey.set(key, { ...vitamin });
            }
        }
        return Array.from(byKey.values())
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 12);
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

    private _quickVisionEstimate(vision: VisionResult): ScanMatch | undefined {
        const dishName = vision.main_dish_vi || vision.main_dish_en;
        if (!dishName || (vision.confidence ?? 0) < 0.25) return undefined;

        const haystack = [
            dishName,
            vision.main_dish_en,
            vision.cooking_method,
            ...(vision.components ?? []),
        ].join(" ").toLowerCase();

        let calories = 160;
        let protein = 6;
        let carbs = 20;
        let fat = 6;

        if (/salad|rau|vegetable|gỏi|luộc/.test(haystack)) {
            calories = 90; protein = 4; carbs = 12; fat = 3;
        }
        if (/rice|cơm|noodle|bún|phở|mì|bread|bánh mì|xôi/.test(haystack)) {
            calories = 210; protein = 7; carbs = 34; fat = 5;
        }
        if (/chicken|gà|beef|bò|pork|heo|fish|cá|shrimp|tôm|egg|trứng|tofu|đậu/.test(haystack)) {
            protein = Math.max(protein, 16);
            calories = Math.max(calories, 190);
            carbs = Math.min(carbs, 18);
        }
        if (/fried|chiên|rán|xào|stir/.test(haystack)) {
            calories += 80;
            fat += 9;
        }
        if (/grilled|nướng|roasted|quay/.test(haystack)) {
            calories += 35;
            fat += 4;
        }
        if (/soup|canh|cháo|porridge/.test(haystack)) {
            calories = Math.min(calories, 120);
            carbs = Math.min(carbs, 18);
            fat = Math.min(fat, 4);
        }

        return {
            source_type: "ai_estimate",
            name: dishName,
            name_en: vision.main_dish_en,
            confidence: Math.min(0.45, Math.max(0.25, (vision.confidence ?? 0.45) * 0.55)),
            energy_kcal: this._clampNumber(calories, 20, 650, 160),
            protein: this._clampNumber(protein, 0, 60, 6),
            glucid: this._clampNumber(carbs, 0, 90, 20),
            lipid: this._clampNumber(fat, 0, 60, 6),
            estimated_portion_grams: this._clampNumber(vision.estimated_portion_grams, 20, 1500, 200),
        };
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
