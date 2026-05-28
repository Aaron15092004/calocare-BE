import { getRetrievalService, UnifiedSearchResult, SourceType } from "./RetrievalService";
import { getEnrichmentService } from "./EnrichmentService";
import UsdaFood from "../../models/UsdaFood";
import Food from "../../models/Food";
import Recipe from "../../models/Recipe";

export interface UserPreferences {
    dietary_preference?: "omnivore" | "vegetarian" | "vegan" | "pescatarian" | "halal" | "kosher";
    allergies?: string[];
    disliked_foods?: string[];
    cuisine_preferences?: string[];
}

export interface FoodSearchRequest {
    query: string;
    top_k?: number;
    include_sources?: SourceType[];
    user_preferences?: UserPreferences;
}

export interface UsdaPortion {
    description: string;
    gram_weight: number;
}

export interface FoodSearchResultItem {
    source_type: SourceType;
    source_id: string;
    name: string;
    name_en?: string;
    score: number;
    energy_kcal?: number;
    protein?: number;
    lipid?: number;
    glucid?: number;
    diet_tags: string[];
    is_approved?: boolean;
    is_pending_import?: boolean;
    fdc_id?: number;
    // USDA-specific enriched fields
    portions?: UsdaPortion[];
    wweia_category?: string;
    wweia_category_code?: number;
}

// WWEIA categories inappropriate for adult meal plans — exclude from results
const WWEIA_EXCLUDE_PREFIXES = [
    "Baby food",
    "Infant formula",
    "Alcoholic beverages",
    "Dietary supplements",
];

const ALLERGEN_TAG_MAP: Record<string, string> = {
    dairy: "contains-dairy",
    gluten: "contains-gluten",
    eggs: "contains-eggs",
    shellfish: "contains-shellfish",
    peanut: "contains-peanut",
    peanuts: "contains-peanut",
};

const VEGETARIAN_EXCLUDE_TAG = "non-vegetarian";

export class FoodSearchService {
    private readonly retrieval = getRetrievalService();
    private readonly enrichment = getEnrichmentService();

    async search(req: FoodSearchRequest): Promise<FoodSearchResultItem[]> {
        const topK = req.top_k ?? 10;
        const sources = req.include_sources ?? ["usda", "food", "recipe"];

        // Pre-filter allergens at vector search level (defense-in-depth with post-filter below)
        const excludeTags = this._buildExcludeTags(req.user_preferences);

        const rawResults = await this.retrieval.searchAll(req.query, {
            topK: topK + 5,
            sources,
            excludeTags,
        });

        // Post-filter: remove allergens and dietary violations
        const filtered = this._applyPreferenceFilter(rawResults, req.user_preferences);

        const topResults = filtered.slice(0, topK);

        // Trigger enrichment for high-score USDA hits
        const usdaHits = topResults.filter(
            (r) => r.source_type === "usda" && r.score > 0.7 && !r.imported_to_foods,
        );
        if (usdaHits.length > 0) {
            // Fire-and-forget
            this.enrichment
                .queueEnrichment(
                    usdaHits.map((h) => ({
                        usda_food_id: h.source_id,
                        fdc_id: h.fdc_id!,
                        score: h.score,
                    })),
                    { type: "search" },
                )
                .catch((err) => console.warn("[FoodSearchService] queue enrichment error:", err));
        }

        // Trigger recipe enrichment for high-score recipe hits
        const recipeHits = topResults.filter((r) => r.source_type === "recipe" && r.score > 0.65);
        if (recipeHits.length > 0) {
            this.enrichment
                .queueRecipeEnrichment(
                    recipeHits.map((h) => h.source_id),
                    { type: "search" },
                )
                .catch((err) => console.warn("[FoodSearchService] queue recipe enrichment error:", err));
        }

        // Hydrate with full data from DB
        return this._hydrateResults(topResults);
    }

    private _buildExcludeTags(prefs?: UserPreferences): string[] | undefined {
        if (!prefs) return undefined;
        const tags: string[] = [];

        for (const allergy of prefs.allergies ?? []) {
            const tag = ALLERGEN_TAG_MAP[allergy.toLowerCase()];
            if (tag) tags.push(tag);
        }

        // Vegetarian/vegan: also exclude non-vegetarian tagged items
        if (prefs.dietary_preference && prefs.dietary_preference !== "omnivore") {
            tags.push(VEGETARIAN_EXCLUDE_TAG);
        }

        return tags.length > 0 ? tags : undefined;
    }

    private _applyPreferenceFilter(
        results: UnifiedSearchResult[],
        prefs?: UserPreferences,
    ): UnifiedSearchResult[] {
        if (!prefs) return results;

        return results.filter((r) => {
            const tags = r.diet_tags ?? [];

            // Dietary preference check
            if (
                prefs.dietary_preference &&
                prefs.dietary_preference !== "omnivore" &&
                tags.includes(VEGETARIAN_EXCLUDE_TAG)
            ) {
                return false;
            }

            // Allergen check u2014 MUST NOT leak
            for (const allergy of prefs.allergies ?? []) {
                const tag = ALLERGEN_TAG_MAP[allergy.toLowerCase()];
                if (tag && tags.includes(tag)) return false;
            }

            return true;
        });
    }

    private async _hydrateResults(
        results: UnifiedSearchResult[],
    ): Promise<FoodSearchResultItem[]> {
        const hydrated: FoodSearchResultItem[] = [];

        for (const r of results) {
            try {
                if (r.source_type === "usda") {
                    const doc = await UsdaFood.findById(r.source_id)
                        .select("description_vi description_en energy_kcal protein lipid glucid fdc_id imported_to_foods portions wweia_category wweia_category_code")
                        .lean();
                    if (!doc) continue;
                    // Exclude WWEIA categories not suitable for adult meal plans
                    if (doc.wweia_category && WWEIA_EXCLUDE_PREFIXES.some((p) => doc.wweia_category!.startsWith(p))) {
                        continue;
                    }
                    hydrated.push({
                        source_type: "usda",
                        source_id: r.source_id,
                        name: doc.description_vi ?? doc.description_en,
                        name_en: doc.description_en,
                        score: r.score,
                        energy_kcal: doc.energy_kcal,
                        protein: doc.protein,
                        lipid: doc.lipid,
                        glucid: doc.glucid,
                        diet_tags: r.diet_tags,
                        is_approved: false,
                        is_pending_import: !doc.imported_to_foods,
                        fdc_id: doc.fdc_id,
                        portions: doc.portions?.length ? doc.portions : undefined,
                        wweia_category: doc.wweia_category,
                        wweia_category_code: doc.wweia_category_code,
                    });
                } else if (r.source_type === "food") {
                    const doc = await Food.findById(r.source_id)
                        .select("name_vi name_en energy_kcal protein lipid glucid is_approved")
                        .lean();
                    if (!doc || doc.is_deleted) continue;
                    hydrated.push({
                        source_type: "food",
                        source_id: r.source_id,
                        name: doc.name_vi,
                        name_en: doc.name_en,
                        score: r.score,
                        energy_kcal: doc.energy_kcal,
                        protein: doc.protein,
                        lipid: doc.lipid,
                        glucid: doc.glucid,
                        diet_tags: r.diet_tags,
                        is_approved: doc.is_approved,
                    });
                } else {
                    const doc = await Recipe.findById(r.source_id)
                        .select("name_vi name_en calories protein fat carbs is_approved")
                        .lean();
                    if (!doc || doc.is_deleted) continue;
                    hydrated.push({
                        source_type: "recipe",
                        source_id: r.source_id,
                        name: doc.name_vi,
                        name_en: doc.name_en,
                        score: r.score,
                        energy_kcal: doc.calories,
                        protein: doc.protein,
                        lipid: doc.fat,
                        glucid: doc.carbs,
                        diet_tags: r.diet_tags,
                        is_approved: doc.is_approved,
                    });
                }
            } catch (err) {
                // P1-2: Log hydration failures for debugging
                console.warn("[FoodSearchService] hydrate failed for", r.source_id, err instanceof Error ? err.message : String(err));
            }
        }

        return hydrated;
    }
}

let _instance: FoodSearchService | null = null;
export function getFoodSearchService(): FoodSearchService {
    if (!_instance) _instance = new FoodSearchService();
    return _instance;
}
