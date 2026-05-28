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

        const displayName = (nameVi && nameVi !== result.food_name) ? nameVi : result.food_name;

        const existing = await Food.findOne({ source_reference: ref }).lean();
        if (existing) {
            // Backfill Vietnamese name if the record still has the English name as name_vi
            if (displayName !== result.food_name && existing.name_vi === existing.name_en) {
                await Food.updateOne(
                    { _id: existing._id },
                    {
                        $set: { name_vi: displayName },
                        $addToSet: { search_keywords: displayName.toLowerCase() },
                    },
                );
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
        const food = await this.upsertFullFood(fsId);
        if (!food || !nameVi) return food;
        // Patch name_vi if it's still the English FatSecret name
        if (food.name_vi === food.name_en) {
            await Food.updateOne({ _id: food._id }, { $set: { name_vi: nameVi } });
        }
        return food;
    }

    /**
     * Full import: call food.get.v4 for precise per-serving nutrition,
     * normalise to per-100g, then upsert.  Uses more API quota but more accurate.
     */
    async upsertFullFood(fsId: string): Promise<IFood | null> {
        if (!FatSecretImportService.isAvailable()) return null;

        const ref    = `FS-${fsId}`;
        const fsFood = await getFatSecretService().getFoodById(fsId);
        if (!fsFood) return null;

        const nutrition = getFatSecretService().extractPer100g(fsFood);
        if (!nutrition) return null;

        const imageUrl = getFatSecretService().extractImage(fsFood);
        const tags     = extractDietTags(fsFood.food_name);

        const groupId = await this._getOrCreateFSGroup();
        const food = await Food.findOneAndUpdate(
            { source_reference: ref },
            {
                $set: {
                    name_vi: fsFood.food_name,
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
                    search_keywords: [fsFood.food_name.toLowerCase()],
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
        const displayNameVi = nameVi || fsFood.food_name;
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
     */
    async batchImportQuery(
        query: string,
        limit = 20,
    ): Promise<{ query: string; imported: number; skipped: number }> {
        if (!FatSecretImportService.isAvailable()) {
            return { query, imported: 0, skipped: 0 };
        }

        const results = await getFatSecretService().searchFoods(query, limit);
        let imported = 0;
        let skipped  = 0;

        for (const r of results) {
            const food = await this.upsertFromSearchResult(r);
            if (food) imported++;
            else skipped++;
        }

        return { query, imported, skipped };
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
