import mongoose from "mongoose";
import UsdaFood from "../../models/UsdaFood";
import Food from "../../models/Food";
import Recipe, { IRecipe } from "../../models/Recipe";
import RecipeIngredient from "../../models/RecipeIngredient";
import RecipeVector from "../../models/RecipeVector";
import FoodGroup from "../../models/FoodGroup";
import FoodVector from "../../models/FoodVector";
import EnrichmentQueue, { IEnrichmentTrigger } from "../../models/EnrichmentQueue";
import { getEmbeddingService } from "./EmbeddingService";
import { getImageService, UnsplashRateLimitError } from "./ImageService";
import { getTranslationService } from "./TranslationService";
import { getFatSecretService } from "./FatSecretService";
import { getGeminiService } from "./GeminiService";
import { buildRecipeSearchText } from "../../utils/searchTextBuilder";
import { extractDietTags } from "../../utils/dietTagger";
import { uploadFromUrl, isCloudinaryUrl } from "../CloudinaryService";
import { searchImage as offSearchImage } from "../OpenFoodFactsService";

const USDA_FOODGROUP_CODE = 99999;
const WORKER_BATCH = 10;

async function mirrorToCloudinary(rawUrl: string, publicId: string): Promise<string> {
    if (isCloudinaryUrl(rawUrl)) return rawUrl;
    const mirrored = await uploadFromUrl(rawUrl, publicId);
    return mirrored ?? rawUrl;
}
// Max Unsplash slots per worker run. Each slot represents one attempted fetch.
// demo tier: 50/h, cron every 10 min → 6 runs/h × 5 = 30 calls/h (safe).
// Set UNSPLASH_TIER=production to raise limit in ImageService (5000/h).
const IMAGE_FETCH_PER_BATCH = 5;

export class EnrichmentService {
    async queueEnrichment(
        usdaHits: Array<{ usda_food_id: string; fdc_id: number; score: number }>,
        triggeredBy: IEnrichmentTrigger,
    ): Promise<void> {
        if (usdaHits.length === 0) return;

        const fdcIds = usdaHits.map((h) => h.fdc_id);
        const existing = await EnrichmentQueue.find({
            fdc_id: { $in: fdcIds },
            status: { $in: ["pending", "processing", "imported"] },
        }).select("fdc_id").lean();
        const existingFdcIds = new Set(existing.map((e) => e.fdc_id));

        const toQueue = usdaHits.filter((h) => !existingFdcIds.has(h.fdc_id));
        if (toQueue.length === 0) return;

        await EnrichmentQueue.insertMany(
            toQueue.map((h) => ({
                target_type: "food",
                usda_food_id: new mongoose.Types.ObjectId(h.usda_food_id),
                fdc_id: h.fdc_id,
                triggered_by: triggeredBy,
                status: "pending",
            })),
            { ordered: false },
        ).catch(() => { /* duplicate key from unique index — expected under concurrent load */ });
    }

    async queueRecipeEnrichment(
        recipeIds: string[],
        triggeredBy: IEnrichmentTrigger,
    ): Promise<void> {
        if (recipeIds.length === 0) return;

        const objectIds = recipeIds.map((id) => new mongoose.Types.ObjectId(id));

        // Fix I4/vấn-đề-2: only queue recipes that actually still need enrichment.
        // This prevents wasteful queue entries for already-complete recipes.
        const needsEnrichment = await Recipe.find({
            _id: { $in: objectIds },
            $or: [
                { image_url: { $in: [null, ""] } },
                { image_url: { $exists: false } },
                { name_en: { $in: [null, ""] } },
                { name_en: { $exists: false } },
                { instructions: { $exists: false } },
                { instructions: { $size: 0 } },
                { "nutrients_extended.vitamins": { $exists: false } },
            ],
        }).select("_id").lean();

        if (needsEnrichment.length === 0) return;

        const toEnrichIds = needsEnrichment.map((r) => r._id.toString());
        const toEnrichObjectIds = toEnrichIds.map((id) => new mongoose.Types.ObjectId(id));

        // Check queue for already pending/processing — NOT "imported", because recipe
        // enrichment is idempotent and a previously-imported job may have only filled
        // name_en but not image_url (e.g. due to rate limit). Checking the Recipe
        // collection above (not the queue status) is the source of truth.
        const existing = await EnrichmentQueue.find({
            recipe_id: { $in: toEnrichObjectIds },
            status: { $in: ["pending", "processing"] },
        }).select("recipe_id").lean();
        const existingSet = new Set(existing.map((e) => e.recipe_id?.toString()));

        const toQueue = toEnrichIds.filter((id) => !existingSet.has(id));
        if (toQueue.length === 0) return;

        await EnrichmentQueue.insertMany(
            toQueue.map((id) => ({
                target_type: "recipe",
                recipe_id: new mongoose.Types.ObjectId(id),
                triggered_by: triggeredBy,
                status: "pending",
            })),
            { ordered: false },
        ).catch(() => { /* duplicate key from unique index — expected under concurrent load */ });
    }

    async runWorker(): Promise<void> {
        const jobs = await EnrichmentQueue.find({ status: "pending" })
            .sort({ created_at: 1 })
            .limit(WORKER_BATCH);

        let imageFetchCount = 0;

        for (const job of jobs) {
            await job.updateOne({ status: "processing" });
            try {
                const canFetchImage = imageFetchCount < IMAGE_FETCH_PER_BATCH;

                if (job.target_type === "recipe") {
                    if (!job.recipe_id) throw new Error("recipe_id missing on recipe job");
                    const enriched = await this._processRecipeJob(job.recipe_id.toString(), canFetchImage);
                    if (enriched && canFetchImage) imageFetchCount++;
                    await job.updateOne({ status: enriched ? "imported" : "skipped" });
                } else {
                    if (job.fdc_id == null) throw new Error("fdc_id missing on food job");
                    const imported = await this.processJob(job.fdc_id, canFetchImage);
                    if (canFetchImage) imageFetchCount++;
                    await job.updateOne({
                        status: imported ? "imported" : "skipped",
                        imported_food_id: imported ?? undefined,
                    });
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await job.updateOne({ status: "failed", error_message: msg });
                console.error(`[EnrichmentService] Job failed (${job.target_type ?? "food"}):`, msg);
            }
        }
    }

    async _processRecipeJob(recipeId: string, fetchImage: boolean): Promise<boolean> {
        const recipe = await Recipe.findById(recipeId)
            .select("name_vi name_en image_url calories protein fat carbs fiber instructions nutrients_extended")
            .lean();
        if (!recipe) throw new Error(`Recipe not found: ${recipeId}`);

        const updates: Partial<{
            name_en: string;
            image_url: string;
            images: string[];
            image_attribution: object;
            instructions: Record<string, unknown>[];
            nutrients_extended: Record<string, unknown>;
        }> = {};

        if (!recipe.name_en) {
            try {
                const [translated] = await getTranslationService().translateBatch([recipe.name_vi]);
                if (translated && translated !== recipe.name_vi) {
                    updates.name_en = translated;
                }
            } catch (err) {
                console.warn("[EnrichmentService] Recipe translation failed:", err instanceof Error ? err.message : String(err));
            }
        }

        // Generate cooking instructions if missing
        if (!recipe.instructions || (recipe.instructions as unknown[]).length === 0) {
            try {
                const instrResp = await getGeminiService().generate(
                    [
                        { role: "system", content: "Bạn là chuyên gia ẩm thực Việt Nam. Hãy tạo hướng dẫn nấu ăn ngắn gọn, thực tế bằng tiếng Việt." },
                        { role: "user", content: `Tạo các bước nấu ăn cho món "${recipe.name_vi}". Trả về JSON đúng định dạng, không markdown:\n{"steps":["Bước 1: ...","Bước 2: ..."]}` },
                    ],
                    { temperature: 0.5, maxTokens: 1024 },
                );
                const cleaned = instrResp.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
                const parsed = JSON.parse(cleaned) as { steps?: unknown };
                if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
                    updates.instructions = (parsed.steps as string[]).map((text, i) => ({ step: i + 1, text }));
                }
            } catch (err) {
                console.warn("[EnrichmentService] Recipe instructions generation failed:", err instanceof Error ? err.message : String(err));
            }
        }

        // Generate vitamins/minerals estimates if missing
        const hasNutrients = (recipe.nutrients_extended as Record<string, unknown> | undefined)?.vitamins
            || (recipe.nutrients_extended as Record<string, unknown> | undefined)?.minerals;
        if (!hasNutrients) {
            try {
                const macroCtx = `calories: ${recipe.calories ?? 0}kcal, protein: ${recipe.protein ?? 0}g, fat: ${recipe.fat ?? 0}g, carbs: ${recipe.carbs ?? 0}g`;
                const nutriResp = await getGeminiService().generate(
                    [
                        { role: "system", content: "You are a nutrition expert. Estimate realistic micronutrient content per serving for recipes." },
                        { role: "user", content: `Estimate vitamins and minerals per serving for "${recipe.name_vi}" (${macroCtx}). Return JSON only, no markdown:\n{"vitamins":{"vitamin_c_mg":0,"vitamin_a_mcg":0,"vitamin_d_mcg":0,"vitamin_e_mg":0,"vitamin_k_mcg":0,"vitamin_b1_mg":0,"vitamin_b2_mg":0,"vitamin_b3_mg":0,"vitamin_b6_mg":0,"vitamin_b12_mcg":0,"folate_mcg":0},"minerals":{"calcium_mg":0,"iron_mg":0,"magnesium_mg":0,"phosphorus_mg":0,"potassium_mg":0,"sodium_mg":0,"zinc_mg":0}}` },
                    ],
                    { temperature: 0.2, maxTokens: 512 },
                );
                const cleaned2 = nutriResp.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
                const nutriParsed = JSON.parse(cleaned2) as { vitamins?: unknown; minerals?: unknown };
                if (nutriParsed.vitamins || nutriParsed.minerals) {
                    updates.nutrients_extended = {
                        ...((recipe.nutrients_extended as Record<string, unknown>) ?? {}),
                        ...(nutriParsed.vitamins ? { vitamins: nutriParsed.vitamins } : {}),
                        ...(nutriParsed.minerals ? { minerals: nutriParsed.minerals } : {}),
                    };
                }
            } catch (err) {
                console.warn("[EnrichmentService] Recipe nutrients generation failed:", err instanceof Error ? err.message : String(err));
            }
        }

        if (!recipe.image_url && fetchImage) {
            const nameForSearch = updates.name_en ?? recipe.name_en ?? recipe.name_vi;
            let rawImageUrl: string | null = null;
            let imageAttribution: object = {};

            // 1. FatSecret (free, no rate limit concerns)
            if (!rawImageUrl && process.env.FATSECRET_KEY) {
                try {
                    const fsResults = await getFatSecretService().searchFoods(nameForSearch, 3);
                    for (const fsFood of fsResults) {
                        const detail = await getFatSecretService().getFoodById(fsFood.food_id);
                        if (!detail) continue;
                        const imgUrl = getFatSecretService().extractImage(detail);
                        if (imgUrl) {
                            rawImageUrl = imgUrl;
                            imageAttribution = { source: "fatsecret" };
                            break;
                        }
                    }
                } catch (err) {
                    console.warn("[EnrichmentService] FatSecret image lookup failed:", err instanceof Error ? err.message : String(err));
                }
            }

            // 2. Open Food Facts (free, no key needed)
            if (!rawImageUrl) {
                try {
                    const offUrl = await offSearchImage(nameForSearch);
                    if (offUrl) {
                        rawImageUrl = offUrl;
                        imageAttribution = { source: "openfoodfacts" };
                    }
                } catch (err) {
                    console.warn("[EnrichmentService] Open Food Facts image lookup failed:", err instanceof Error ? err.message : String(err));
                }
            }

            // 3. Unsplash (rate-limited fallback)
            if (!rawImageUrl) {
                try {
                    const result = await getImageService().fetchFoodImage(nameForSearch);
                    if (result) {
                        rawImageUrl = result.url;
                        imageAttribution = result.attribution;
                    }
                } catch (err) {
                    if (err instanceof UnsplashRateLimitError) {
                        console.warn("[EnrichmentService] Unsplash rate limited, skipping image for recipe:", recipeId);
                    } else {
                        throw err;
                    }
                }
            }

            // Mirror whichever source succeeded to Cloudinary
            if (rawImageUrl) {
                const finalUrl = await mirrorToCloudinary(rawImageUrl, `food-${recipeId}`);
                updates.image_url = finalUrl;
                updates.images = [finalUrl];
                updates.image_attribution = imageAttribution;
            }
        }

        let didWork = false;
        if (Object.keys(updates).length > 0) {
            await Recipe.updateOne({ _id: recipeId }, { $set: updates });
            didWork = true;
        }

        // Upsert RecipeVector for RAG semantic search if not yet embedded
        const existingVector = await RecipeVector.findOne(
            { source_id: new mongoose.Types.ObjectId(recipeId) },
        ).select("_id").lean();

        if (!existingVector) {
            const latest = await Recipe.findById(recipeId)
                .select("name_vi name_en calories protein fat carbs is_approved diet_tags")
                .lean();
            if (latest) {
                const nameEn = (updates.name_en ?? latest.name_en) as string | undefined;
                const fullName = latest.name_vi + (nameEn ? ` | ${nameEn}` : "");
                const searchText = buildRecipeSearchText({
                    name: fullName,
                    energy_kcal: latest.calories,
                    protein: latest.protein,
                    lipid: latest.fat,
                    glucid: latest.carbs,
                    diet_tags: extractDietTags(latest.name_vi),
                });
                const embedding = await getEmbeddingService().embed(searchText, "document");
                await RecipeVector.updateOne(
                    { source_id: new mongoose.Types.ObjectId(recipeId) },
                    {
                        $set: {
                            source_type: "recipe",
                            embedding,
                            name: latest.name_vi,
                            diet_tags: extractDietTags(searchText),
                            is_approved: latest.is_approved ?? false,
                            embedding_model: "voyage-4-lite",
                            embedding_version: 1,
                        },
                    },
                    { upsert: true },
                );
                didWork = true;
            }
        }

        return didWork;
    }

    // processJob: each UsdaFood document is a prepared dish (Type-2 recipe).
    // Creates:
    //   - Food records for each input_food entry (raw ingredients, deduped)
    //   - Recipe (nutrition_source="manual") from the USDA dish with full macros/micros
    //   - RecipeIngredient links: Recipe → Foods
    //   - RecipeVector for semantic search
    // Returns Recipe._id (NOT Food._id — callers must update accordingly).
    async processJob(fdcId: number, fetchImage = false): Promise<mongoose.Types.ObjectId | null> {
        // Idempotency: return existing Recipe._id without re-creating
        const existingRecipe = await Recipe.findOne({ code: `USDA-${fdcId}` }).select("_id").lean();
        if (existingRecipe) {
            await UsdaFood.updateOne(
                { fdc_id: fdcId },
                { imported_to_foods: true, imported_food_id: existingRecipe._id },
            );
            return existingRecipe._id as mongoose.Types.ObjectId;
        }

        const usdaDoc = await UsdaFood.findOne({ fdc_id: fdcId })
            .select("description_vi description_en energy_kcal protein lipid glucid fiber water nutrients_extended input_foods portions diet_tags")
            .lean();
        if (!usdaDoc) throw new Error(`UsdaFood not found: fdc_id=${fdcId}`);

        // Dedup by name_vi: if a non-USDA recipe already exists with the same Vietnamese name,
        // reuse it instead of creating a duplicate.
        const candidateName = usdaDoc.description_vi ?? usdaDoc.description_en;
        const nameClash = await Recipe.findOne({
            name_vi: { $regex: `^${candidateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
            code: { $not: /^USDA-/ },
        }).select("_id").lean();
        if (nameClash) {
            await UsdaFood.updateOne(
                { fdc_id: fdcId },
                { imported_to_foods: true, imported_food_id: nameClash._id },
            );
            return nameClash._id as mongoose.Types.ObjectId;
        }

        // Get or create USDA placeholder food group (for ingredient Foods)
        const existingGroup = await FoodGroup.findOne({ code: USDA_FOODGROUP_CODE }).lean();
        const groupId = existingGroup
            ? existingGroup._id
            : (await FoodGroup.create({
                  code: USDA_FOODGROUP_CODE,
                  name_vi: "USDA Imported (chờ phân loại)",
                  name_en: "USDA Imported (pending classification)",
              }))._id;

        // ── Step 1: Create Food records from input_foods (deduped) ──────────────
        interface IngredientRef { food_id: mongoose.Types.ObjectId; amount?: number; unit?: string }
        const ingredientRefs: IngredientRef[] = [];

        // Batch-translate all input_food descriptions to Vietnamese upfront
        const rawInputFoods = usdaDoc.input_foods ?? [];
        const inputDescriptions = rawInputFoods.map((f) => f.description);
        let translatedDescriptions: string[] = inputDescriptions;
        if (inputDescriptions.length > 0) {
            try {
                translatedDescriptions = await getTranslationService().translateBatch(inputDescriptions);
            } catch (err) {
                console.warn("[EnrichmentService] input_food batch translation failed, using originals:", err instanceof Error ? err.message : String(err));
            }
        }
        const viNameMap = new Map(inputDescriptions.map((desc, i) => [desc, translatedDescriptions[i] ?? desc]));

        for (const inputFood of rawInputFoods) {
            try {
                // Dedup key: prefer fdc_id-based reference; fall back to name-based
                const dedupeRef = inputFood.fdc_id
                    ? `USDA-${inputFood.fdc_id}`
                    : `USDA-NAME-${inputFood.description.toLowerCase().replace(/\s+/g, "-").slice(0, 60)}`;

                const existingFood = await Food.findOne({ source_reference: dedupeRef }).select("_id").lean();
                if (existingFood) {
                    ingredientRefs.push({ food_id: existingFood._id as mongoose.Types.ObjectId, amount: inputFood.amount, unit: inputFood.unit });
                    continue;
                }

                // Look up full nutrition from UsdaFood if fdc_id available
                let nutrition = { energy_kcal: 0, protein: 0, lipid: 0, glucid: 0, fiber: undefined as number | undefined, water: undefined as number | undefined, nutrients_extended: undefined as Record<string, unknown> | undefined };
                if (inputFood.fdc_id) {
                    const ingredientUsda = await UsdaFood.findOne({ fdc_id: inputFood.fdc_id })
                        .select("energy_kcal protein lipid glucid fiber water nutrients_extended")
                        .lean();
                    if (ingredientUsda) {
                        nutrition = {
                            energy_kcal: ingredientUsda.energy_kcal,
                            protein: ingredientUsda.protein,
                            lipid: ingredientUsda.lipid,
                            glucid: ingredientUsda.glucid,
                            fiber: ingredientUsda.fiber,
                            water: ingredientUsda.water,
                            nutrients_extended: ingredientUsda.nutrients_extended as Record<string, unknown> | undefined,
                        };
                    }
                }

                const food = await Food.create({
                    name_vi: viNameMap.get(inputFood.description) ?? inputFood.description,
                    name_en: inputFood.description,
                    food_group_id: groupId,
                    ...nutrition,
                    is_approved: true,
                    source_reference: dedupeRef,
                    notes: `Auto-imported from USDA FDC input_food. Parent fdc_id=${fdcId}${inputFood.fdc_id ? `, ingredient fdc_id=${inputFood.fdc_id}` : ""}.`,
                });
                ingredientRefs.push({ food_id: food._id as mongoose.Types.ObjectId, amount: inputFood.amount, unit: inputFood.unit });
            } catch (err) {
                console.warn(`[EnrichmentService] input_food "${inputFood.description}" skipped:`, err instanceof Error ? err.message : String(err));
            }
        }

        // ── Step 2: Determine total_weight for per-serving nutrition ─────────────
        // Sum input_food amounts in grams; fall back to portions[0] or 100g default
        const inputWeightG = (usdaDoc.input_foods ?? []).reduce((sum, f) => {
            if (f.amount == null) return sum;
            const unit = (f.unit ?? "g").toLowerCase();
            if (unit === "g" || unit === "gram" || unit === "grams") return sum + f.amount;
            return sum;
        }, 0);
        const total_weight = inputWeightG > 0
            ? inputWeightG
            : (usdaDoc.portions?.[0]?.gram_weight ?? 100);

        const factor = total_weight / 100;

        // ── Step 3: Fetch image (optional) ────────────────────────────────────────
        let imageUrl: string | undefined;
        let imageAttribution: object | undefined;
        if (fetchImage) {
            const nameForImg = usdaDoc.description_vi ?? usdaDoc.description_en;
            let rawImageUrl: string | null = null;
            let rawAttribution: object = {};

            // 1. FatSecret
            if (process.env.FATSECRET_KEY) {
                try {
                    const fsResults = await getFatSecretService().searchFoods(nameForImg, 3);
                    for (const fsFood of fsResults) {
                        const detail = await getFatSecretService().getFoodById(fsFood.food_id);
                        if (!detail) continue;
                        const imgUrl = getFatSecretService().extractImage(detail);
                        if (imgUrl) {
                            rawImageUrl = imgUrl;
                            rawAttribution = { source: "fatsecret" };
                            break;
                        }
                    }
                } catch (err) {
                    console.warn("[EnrichmentService] FatSecret image lookup failed:", err instanceof Error ? err.message : String(err));
                }
            }

            // 2. Open Food Facts
            if (!rawImageUrl) {
                try {
                    const offUrl = await offSearchImage(nameForImg);
                    if (offUrl) {
                        rawImageUrl = offUrl;
                        rawAttribution = { source: "openfoodfacts" };
                    }
                } catch (err) {
                    console.warn("[EnrichmentService] Open Food Facts image lookup failed:", err instanceof Error ? err.message : String(err));
                }
            }

            // 3. Unsplash
            if (!rawImageUrl) {
                try {
                    const result = await getImageService().fetchFoodImage(nameForImg);
                    if (result) {
                        rawImageUrl = result.url;
                        rawAttribution = result.attribution;
                    }
                } catch (err) {
                    if (err instanceof UnsplashRateLimitError) {
                        console.warn("[EnrichmentService] Unsplash rate limited, skipping image for food:", fdcId);
                    } else {
                        throw err;
                    }
                }
            }

            // Mirror to Cloudinary
            if (rawImageUrl) {
                imageUrl = await mirrorToCloudinary(rawImageUrl, `food-usda-${fdcId}`);
                imageAttribution = rawAttribution;
            }
        }

        // ── Step 4: Create Recipe (Type 2 — nutrition_source = "manual") ─────────
        // Array form of create() returns T[] with a clear type; destructure to get single doc.
        let recipe: mongoose.HydratedDocument<IRecipe>;
        try {
            [recipe] = await Recipe.create([{
                code: `USDA-${fdcId}`,
                name_vi: usdaDoc.description_vi ?? usdaDoc.description_en,
                name_en: usdaDoc.description_en,
                servings: 1,
                // Per-serving macros (per-100g × factor)
                calories: Math.round(usdaDoc.energy_kcal * factor),
                protein: Math.round(usdaDoc.protein * factor * 10) / 10,
                fat: Math.round(usdaDoc.lipid * factor * 10) / 10,
                carbs: Math.round(usdaDoc.glucid * factor * 10) / 10,
                fiber: usdaDoc.fiber != null ? Math.round(usdaDoc.fiber * factor * 10) / 10 : undefined,
                total_weight,
                nutrition_source: "manual" as const,
                nutrients_extended: usdaDoc.nutrients_extended,
                is_approved: true,
                is_public: false,
                ai_training_approved: false,
                ...(imageUrl ? { image_url: imageUrl, images: [imageUrl], image_attribution: imageAttribution } : {}),
            }]);
        } catch (err: any) {
            // Race condition: another worker created the same recipe concurrently
            if (err.code === 11000 && err.keyPattern?.code) {
                const existing = await Recipe.findOne({ code: `USDA-${fdcId}` }).select("_id").lean();
                if (existing) return existing._id as mongoose.Types.ObjectId;
            }
            throw err;
        }

        // ── Step 5: Create RecipeIngredient records ───────────────────────────────
        if (ingredientRefs.length > 0) {
            await RecipeIngredient.insertMany(
                ingredientRefs.map((ref, idx) => ({
                    recipe_id: recipe._id,
                    food_id: ref.food_id,
                    amount: ref.amount ?? 100,
                    unit: ref.unit ?? "g",
                    sort_order: idx,
                })),
                { ordered: false },
            ).catch((err) => {
                console.warn("[EnrichmentService] RecipeIngredient insertMany partial failure:", err instanceof Error ? err.message : String(err));
            });
        }

        // ── Step 6: Create RecipeVector for semantic search ───────────────────────
        const searchText = buildRecipeSearchText({
            name: recipe.name_vi + (recipe.name_en ? ` | ${recipe.name_en}` : ""),
            energy_kcal: recipe.calories,
            protein: recipe.protein,
            lipid: recipe.fat,
            glucid: recipe.carbs,
            diet_tags: [...new Set([...extractDietTags(recipe.name_vi), ...(usdaDoc.diet_tags ?? [])])],
        });

        const embedding = await getEmbeddingService().embed(searchText, "document");
        const mergedTags = [...new Set([...extractDietTags(searchText), ...(usdaDoc.diet_tags ?? [])])];

        // Upsert — safe against rare duplicate calls
        await RecipeVector.updateOne(
            { source_id: recipe._id },
            {
                $set: {
                    source_type: "recipe",
                    embedding,
                    name: recipe.name_vi,
                    diet_tags: mergedTags,
                    is_approved: true,
                    embedding_model: "voyage-4-lite",
                    embedding_version: 1,
                },
            },
            { upsert: true },
        );

        // ── Step 7: Mark UsdaFood as imported → Recipe ────────────────────────────
        await UsdaFood.updateOne(
            { fdc_id: fdcId },
            { imported_to_foods: true, imported_food_id: recipe._id },
        );

        return recipe._id as mongoose.Types.ObjectId;
    }

    /**
     * RAG-03: Queue Recipe/Food records that are missing an image_url for enrichment.
     * Runs in small batches to stay within rate limits. Returns count queued.
     */
    async runImageBackfill(batchSize = 50): Promise<{ recipes: number; foods: number }> {
        // Recipes without images
        const recipesWithoutImage = await Recipe.find({
            $or: [{ image_url: { $in: [null, ""] } }, { image_url: { $exists: false } }],
        })
            .select("_id")
            .limit(batchSize)
            .lean();

        let recipesQueued = 0;
        if (recipesWithoutImage.length > 0) {
            const recipeIds = recipesWithoutImage.map((r) => r._id.toString());
            await this.queueRecipeEnrichment(recipeIds, { type: "admin" });
            recipesQueued = recipeIds.length;
        }

        // USDA foods (via UsdaFood → Recipe link) without images
        const usdaWithoutImage = await Recipe.find({
            code: /^USDA-/,
            $or: [{ image_url: { $in: [null, ""] } }, { image_url: { $exists: false } }],
        })
            .select("_id code")
            .limit(batchSize)
            .lean();

        let foodsQueued = 0;
        for (const usdaRecipe of usdaWithoutImage) {
            const fdcId = parseInt((usdaRecipe.code as string).replace("USDA-", ""), 10);
            if (isNaN(fdcId)) continue;
            const usdaDoc = await UsdaFood.findOne({ fdc_id: fdcId }).select("_id fdc_id").lean();
            if (!usdaDoc) continue;
            await this.queueEnrichment(
                [{ usda_food_id: usdaDoc._id.toString(), fdc_id: fdcId, score: 1 }],
                { type: "admin" },
            );
            foodsQueued++;
        }

        console.log(`[EnrichmentService] Image backfill queued: ${recipesQueued} recipes, ${foodsQueued} USDA foods`);
        return { recipes: recipesQueued, foods: foodsQueued };
    }

    /**
     * RAG-05: Re-queue USDA foods and recipes that haven't been refreshed in staleDays.
     * Clears the existing imported status so the worker re-processes them.
     */
    async runStaleRefresh(staleDays = 90, batchSize = 100): Promise<number> {
        const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

        // Mark old "imported" jobs as "pending" again so the worker picks them up
        const result = await EnrichmentQueue.updateMany(
            {
                status: "imported",
                updated_at: { $lt: cutoff },
            },
            { $set: { status: "pending" } },
        );

        const count = result.modifiedCount;
        if (count > 0) {
            console.log(`[EnrichmentService] Stale refresh: re-queued ${count} enrichment jobs older than ${staleDays} days`);
        }
        return count;
    }
}

let _instance: EnrichmentService | null = null;
export function getEnrichmentService(): EnrichmentService {
    if (!_instance) _instance = new EnrichmentService();
    return _instance;
}
