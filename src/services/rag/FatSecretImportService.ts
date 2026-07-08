/**
 * FatSecret → Food DB import pipeline.
 * Converts FatSecret search results into local Food + FoodVector documents
 * so they become searchable via RAG vector search.
 *
 * Strategy:
 *  - "fast path": parse food_description string for nutrition (no extra API call)
 *  - "full path": call food.get.v4 for precise per-100g nutrition
 *  - Dedup key: source_reference "FS-{food_id}"
 *  - Only Vietnamese-locale foods (locale=vi, region=VN in FatSecretService)
 */
import mongoose from "mongoose";
import Food, { IFood } from "../../models/Food";
import FoodGroup from "../../models/FoodGroup";
import FoodVector from "../../models/FoodVector";
import Recipe from "../../models/Recipe";
import { getFatSecretService, FatSecretSearchResult, FatSecretFood } from "./FatSecretService";
import { getEmbeddingService } from "./EmbeddingService";
import { getTranslationService } from "./TranslationService";
import { getGroqService, LLMMessage } from "./GroqService";
import { buildFoodSearchText } from "../../utils/searchTextBuilder";
import { extractDietTags } from "../../utils/dietTagger";

const FS_FOODGROUP_CODE = 99998;

export interface FatSecretNutrition {
    energy_kcal: number;
    protein: number;
    lipid: number;
    glucid: number;
    fiber: number;
}

export class FatSecretImportService {
    static isAvailable(): boolean {
        return !!(process.env.FATSECRET_KEY && process.env.FATSECRET_SECRET);
    }

    /**
     * Parse FatSecret food_description format (search results only need this):
     * "Per 100g - Calories: 52kcal | Fat: 0.14g | Carbs: 11.26g | Protein: 0.70g"
     * "Per serving (200g) - Calories: 200kcal | Fat: 1.00g | ..."
     *
     * Normalises everything to per-100g values.
     */
    static parseFoodDescription(description: string): FatSecretNutrition | null {
        // Detect serving size — default 100g
        const servingMatch = description.match(/Per\s+(?:serving\s+\()?([\d.]+)\s*g/i);
        const servingGrams = servingMatch ? parseFloat(servingMatch[1]) : 100;
        if (!servingGrams || servingGrams <= 0) return null;
        const factor = 100 / servingGrams;

        const cal   = parseFloat(description.match(/Calories:\s*([\d.]+)kcal/i)?.[1] ?? "0") || 0;
        const fat   = parseFloat(description.match(/Fat:\s*([\d.]+)g/i)?.[1] ?? "0") || 0;
        const carbs = parseFloat(description.match(/Carbs:\s*([\d.]+)g/i)?.[1] ?? "0") || 0;
        const prot  = parseFloat(description.match(/Protein:\s*([\d.]+)g/i)?.[1] ?? "0") || 0;
        const fiber = parseFloat(description.match(/Fiber:\s*([\d.]+)g/i)?.[1] ?? "0") || 0;

        if (cal === 0 && prot === 0 && carbs === 0) return null;

        return {
            energy_kcal: Math.round(cal * factor),
            protein: Math.round(prot * factor * 10) / 10,
            lipid:   Math.round(fat  * factor * 10) / 10,
            glucid:  Math.round(carbs * factor * 10) / 10,
            fiber:   Math.round(fiber * factor * 10) / 10,
        };
    }

    /**
     * Translate a single English food name to Vietnamese via TranslationService
     * (Groq-backed, cached).  Never throws — falls back to the English name with
     * a warning so an import is never aborted by a translation failure.
     */
    private async _translateNameToVi(nameEn: string): Promise<string> {
        try {
            const [translated] = await getTranslationService().translateBatch([nameEn]);
            return translated || nameEn;
        } catch (err) {
            console.warn(
                `[FatSecretImport] en→vi translation failed for "${nameEn}" — storing English name:`,
                (err as Error).message,
            );
            return nameEn;
        }
    }

    /**
     * One lightweight Groq call classifying which of the given food names are NOT
     * actual foods/dishes suitable for a Vietnamese nutrition-tracking app
     * (cocktails/alcoholic drinks, protein powders/supplements, brand-only names,
     * non-food items).  Returns the set of 0-based indices to EXCLUDE.
     * Throws on API/parse failure — callers fail open (import everything).
     */
    private async _classifyJunkFoods(names: string[]): Promise<Set<number>> {
        const messages: LLMMessage[] = [
            {
                role: "system",
                content:
                    "You are a strict curator for a Vietnamese nutrition-tracking food database. " +
                    "You will receive a JSON array of food names from a food-database search. " +
                    "Identify which entries are NOT actual foods or dishes suitable for tracking daily nutrition: " +
                    "cocktails or alcoholic drinks, protein powders or supplements, brand-only names with no food, " +
                    "and non-food items. Common dishes, ingredients, drinks like juice/milk/coffee, snacks and " +
                    "desserts ARE valid foods.\n" +
                    "Return ONLY a JSON array of the 0-based indices to EXCLUDE, e.g. [1,4]. " +
                    "Return [] if every entry is a valid food. No markdown, no explanation.",
            },
            {
                role: "user",
                content: JSON.stringify(names),
            },
        ];

        const response = await getGroqService().generate(messages, { temperature: 0, maxTokens: 512 });
        const text = response.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error("junk classification did not return a JSON array");

        return new Set(
            (parsed as unknown[])
                .map((v) => (typeof v === "string" ? parseInt(v, 10) : v))
                .filter((v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < names.length),
        );
    }

    private async _getOrCreateFSGroup(): Promise<mongoose.Types.ObjectId> {
        const existing = await FoodGroup.findOne({ code: FS_FOODGROUP_CODE }).select("_id").lean();
        if (existing) return existing._id as mongoose.Types.ObjectId;
        const created = await FoodGroup.create({
            code: FS_FOODGROUP_CODE,
            name_vi: "FatSecret Imported (chờ phân loại)",
            name_en: "FatSecret Imported (pending classification)",
        });
        return created._id as mongoose.Types.ObjectId;
    }

    /**
     * Fast import: parse food_description from search result (no extra API call).
     * Pass nameVi to store the translated Vietnamese display name alongside the English source name.
     */
    async upsertFromSearchResult(result: FatSecretSearchResult, nameVi?: string): Promise<IFood | null> {
        const ref       = `FS-${result.food_id}`;
        const nutrition = FatSecretImportService.parseFoodDescription(result.food_description);
        if (!nutrition) return null;

        const existing = await Food.findOne({ source_reference: ref }).lean();
        if (existing) {
            // Backfill Vietnamese name if the record still has the English name as name_vi
            if (existing.name_vi === existing.name_en) {
                const backfillName = nameVi || await this._translateNameToVi(result.food_name);
                if (backfillName && backfillName !== result.food_name) {
                    await Food.updateOne(
                        { _id: existing._id },
                        {
                            $set: { name_vi: backfillName },
                            $addToSet: { search_keywords: backfillName.toLowerCase() },
                        },
                    );
                }
            }
            return existing as unknown as IFood;
        }

        // Dedup by name_en within FatSecret sources — prevents importing the same dish
        // multiple times when FatSecret returns different food_ids for the same display name.
        const nameClash = await Food.findOne({
            source_reference: /^FS-/,
            name_en: { $regex: `^${result.food_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
        }).select("_id").lean();
        if (nameClash) return nameClash as unknown as IFood;

        // Never write English into name_vi: translate when the caller did not
        // supply a Vietnamese name (falls back to English only if Groq fails).
        const displayName = nameVi || await this._translateNameToVi(result.food_name);

        const groupId  = await this._getOrCreateFSGroup();
        const tags     = extractDietTags(displayName);
        const keywords = [...new Set([
            result.food_name.toLowerCase(),
            displayName.toLowerCase(),
            ...(result.brand_name ? [result.brand_name.toLowerCase()] : []),
        ])];

        const food = await Food.create({
            name_vi: displayName,
            name_en: result.food_name,
            food_group_id: groupId,
            energy_kcal: nutrition.energy_kcal,
            protein: nutrition.protein,
            lipid:   nutrition.lipid,
            glucid:  nutrition.glucid,
            fiber:   nutrition.fiber,
            source_reference: ref,
            notes: result.brand_name
                ? `Thương hiệu: ${result.brand_name} — Nguồn: FatSecret VN`
                : "Nguồn: FatSecret VN",
            is_approved: true,
            is_deleted: false,
            search_keywords: keywords,
        });

        // Embed in background — do not block the search response
        this._embedFood(food, tags).catch(() => {});
        return food;
    }

    /**
     * Same as upsertFullFood but also sets name_vi to the Vietnamese dish name
     * identified during a scan (so future DB searches find it by Vietnamese name).
     */
    async upsertFullFoodWithViName(fsId: string, nameVi: string): Promise<IFood | null> {
        return this.upsertFullFood(fsId, nameVi || undefined);
    }

    /**
     * Full import: call food.get.v4 for precise per-serving nutrition,
     * normalise to per-100g, then upsert.  Uses more API quota but more accurate.
     * Optional nameVi sets the Vietnamese display name; when absent the English
     * name is translated en→vi so name_vi is never left in English.
     */
    async upsertFullFood(fsId: string, nameVi?: string): Promise<IFood | null> {
        if (!FatSecretImportService.isAvailable()) return null;

        const ref    = `FS-${fsId}`;
        const fsFood = await getFatSecretService().getFoodById(fsId);
        if (!fsFood) return null;

        const nutrition = getFatSecretService().extractPer100g(fsFood);
        if (!nutrition) return null;

        const imageUrl = getFatSecretService().extractImage(fsFood);
        const displayNameVi = nameVi || await this._translateNameToVi(fsFood.food_name);
        const tags     = extractDietTags(displayNameVi);

        const groupId = await this._getOrCreateFSGroup();
        const food = await Food.findOneAndUpdate(
            { source_reference: ref },
            {
                $set: {
                    name_vi: displayNameVi,
                    name_en: fsFood.food_name,
                    energy_kcal: nutrition.energy_kcal,
                    protein: nutrition.protein,
                    lipid:   nutrition.lipid,
                    glucid:  nutrition.glucid,
                    fiber:   nutrition.fiber,
                    ...(imageUrl ? { image_url: imageUrl, image_attribution: { source: "fatsecret", photographer_name: "", photographer_url: "", photo_url: imageUrl, download_location: imageUrl } } : {}),
                    is_approved: true,
                    notes: "Nguồn: FatSecret VN",
                },
                $setOnInsert: {
                    source_reference: ref,
                    food_group_id: groupId,
                    search_keywords: [...new Set([fsFood.food_name.toLowerCase(), displayNameVi.toLowerCase()])],
                    is_deleted: false,
                },
            },
            { upsert: true, new: true },
        );

        if (food) await this._embedFood(food, tags);
        return food;
    }

    /**
     * Import from a FatSecretFood object already fetched via searchFoodsV5.
     * Avoids an extra food.get.v4 API call — uses the nutrition data already
     * present in the v5 search response.  Optional nameVi sets a Vietnamese
     * display name (e.g. translated by the caller before saving).
     */
    async upsertFromV5Food(fsFood: FatSecretFood, nameVi?: string): Promise<IFood | null> {
        if (!fsFood.food_id) return null;
        const ref = `FS-${fsFood.food_id}`;
        const nutrition = getFatSecretService().extractPer100g(fsFood);
        if (!nutrition) return null;

        const imageUrl = getFatSecretService().extractImage(fsFood);
        // Never default name_vi to the English name — translate when the caller
        // did not supply a Vietnamese name (English fallback only on Groq failure).
        const displayNameVi = nameVi || await this._translateNameToVi(fsFood.food_name);
        const tags = extractDietTags(displayNameVi);
        const keywords = [...new Set([displayNameVi.toLowerCase(), fsFood.food_name.toLowerCase()])];

        const groupId = await this._getOrCreateFSGroup();
        const food = await Food.findOneAndUpdate(
            { source_reference: ref },
            {
                $set: {
                    name_vi: displayNameVi,
                    name_en: fsFood.food_name,
                    energy_kcal: nutrition.energy_kcal,
                    protein: nutrition.protein,
                    lipid:   nutrition.lipid,
                    glucid:  nutrition.glucid,
                    fiber:   nutrition.fiber,
                    ...(imageUrl ? { image_url: imageUrl, image_attribution: { source: "fatsecret", photographer_name: "", photographer_url: "", photo_url: imageUrl, download_location: imageUrl } } : {}),
                    is_approved: true,
                    notes: nameVi ? `Tên VN: ${nameVi} — Nguồn: FatSecret` : "Nguồn: FatSecret",
                },
                $setOnInsert: {
                    source_reference: ref,
                    food_group_id: groupId,
                    search_keywords: keywords,
                    is_deleted: false,
                },
            },
            { upsert: true, new: true },
        );

        if (food) this._embedFood(food, tags).catch(() => {});
        return food;
    }

    /**
     * Search FatSecret for `query` and upsert all results (fast path).
     * Ideal for seeding the local DB — call once per food category.
     *
     * Vietnamese-first pipeline:
     *  1. One Groq classification call filters out non-food junk
     *     (cocktails, supplements, brand-only names) — fail-open on error.
     *  2. The top-ranked result (FatSecret relevance) gets the Vietnamese
     *     `query` term itself as name_vi.
     *  3. All remaining results are translated en→vi in ONE translateBatch call.
     */
    async batchImportQuery(
        query: string,
        limit = 20,
    ): Promise<{ query: string; imported: number; skipped: number; excluded: number }> {
        if (!FatSecretImportService.isAvailable()) {
            return { query, imported: 0, skipped: 0, excluded: 0 };
        }

        const results = await getFatSecretService().searchFoods(query, limit);
        let imported = 0;
        let skipped  = 0;
        let excluded = 0;

        // 1. Junk filter — one lightweight LLM call per batch, fail-open on error
        let kept = results;
        if (results.length > 0) {
            try {
                const junkIndices = await this._classifyJunkFoods(results.map((r) => r.food_name));
                if (junkIndices.size > 0) {
                    const junkNames = results
                        .filter((_, i) => junkIndices.has(i))
                        .map((r) => r.food_name);
                    console.warn(
                        `[FatSecretImport] "${query}" — excluding ${junkNames.length} non-food item(s): ${junkNames.join(", ")}`,
                    );
                    kept = results.filter((_, i) => !junkIndices.has(i));
                    excluded = junkIndices.size;
                }
            } catch (err) {
                console.warn(
                    `[FatSecretImport] junk classification failed for "${query}" — importing all results:`,
                    (err as Error).message,
                );
            }
        }

        if (kept.length === 0) return { query, imported, skipped, excluded };

        // 2. FatSecret's top-ranked result best matches the query intent —
        //    give it the Vietnamese query term itself as name_vi.
        const queryNameVi = query.charAt(0).toUpperCase() + query.slice(1);

        // 3. Batch-translate the remaining results' names in ONE call.
        const rest = kept.slice(1);
        let restNamesVi: string[];
        try {
            restNamesVi = rest.length > 0
                ? await getTranslationService().translateBatch(rest.map((r) => r.food_name))
                : [];
        } catch (err) {
            console.warn(
                `[FatSecretImport] batch en→vi translation failed for "${query}" — storing English names:`,
                (err as Error).message,
            );
            restNamesVi = rest.map((r) => r.food_name);
        }

        const top = await this.upsertFromSearchResult(kept[0], queryNameVi);
        if (top) imported++;
        else skipped++;

        for (let i = 0; i < rest.length; i++) {
            const food = await this.upsertFromSearchResult(rest[i], restNamesVi[i]);
            if (food) imported++;
            else skipped++;
        }

        return { query, imported, skipped, excluded };
    }

    /**
     * Save a FatSecret result as a Recipe (prepared dish) with nutrition_source "manual".
     * Use this for composite dishes (e.g. "Grilled Chicken", "Phở bò") instead of
     * upsertFromSearchResult which targets the raw-ingredient Foods collection.
     *
     * Data is stored per-100g (servings=1, total_weight=100) so the search layer
     * can normalise by portion weight the same way it does for Foods.
     */
    async upsertFromSearchResultAsRecipe(
        result: FatSecretSearchResult,
        nameVi: string,
    ): Promise<void> {
        const ref       = `FS-${result.food_id}`;
        const nutrition = FatSecretImportService.parseFoodDescription(result.food_description);
        if (!nutrition) return;

        const displayName = (nameVi && nameVi !== result.food_name) ? nameVi : result.food_name;

        const existing = await Recipe.findOne({ source_reference: ref }).lean();
        if (existing) {
            // Backfill Vi name if record still shows the English name
            if (displayName !== result.food_name && existing.name_vi === existing.name_en) {
                await Recipe.updateOne({ _id: existing._id }, { $set: { name_vi: displayName } });
            }
            return;
        }

        await Recipe.create({
            name_vi:          displayName,
            name_en:          result.food_name,
            // Nutrition per serving = per 100 g (total_weight = 100, servings = 1)
            calories:         nutrition.energy_kcal,
            protein:          nutrition.protein,
            fat:              nutrition.lipid,
            carbs:            nutrition.glucid,
            fiber:            nutrition.fiber || undefined,
            servings:         1,
            total_weight:     100,
            nutrition_source: "manual",
            source_reference: ref,
            is_approved:      true,
            is_public:        true,
            is_deleted:       false,
            images:           [],
        });
    }

    private async _embedFood(food: IFood, dietTags: string[] = []): Promise<void> {
        const searchText = buildFoodSearchText({
            name_vi:     food.name_vi,
            name_en:     food.name_en,
            energy_kcal: food.energy_kcal,
            protein:     food.protein,
            lipid:       food.lipid,
            glucid:      food.glucid,
            diet_tags:   dietTags,
        });

        const embedding = await getEmbeddingService().embed(searchText, "document");

        await FoodVector.findOneAndUpdate(
            { source_id: food._id },
            {
                $set: {
                    source_id:         food._id,
                    source_type:       "food",
                    embedding,
                    name:              food.name_vi,
                    diet_tags:         dietTags,
                    is_approved:       true,
                    embedding_model:   "voyage-4-lite",
                    embedding_version: 1,
                },
            },
            { upsert: true },
        );
    }
}

let _instance: FatSecretImportService | null = null;
export function getFatSecretImportService(): FatSecretImportService {
    if (!_instance) _instance = new FatSecretImportService();
    return _instance;
}
