/**
 * USDA Survey FNDDS ingest script.
 * Reads ./data/usda_survey.json via streaming, transforms and upserts into usda_foods.
 * Resume-safe: skips records already in DB by fdc_id.
 *
 * Usage: npx ts-node src/scripts/ingest-usda.ts
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import { connectDB } from "../config/database";
import UsdaFood from "../models/UsdaFood";
import { extractNutrients } from "../utils/nutrientExtractor";
import { extractDietTags } from "../utils/dietTagger";
import { buildUsdaSearchText } from "../utils/searchTextBuilder";
import { getEmbeddingService } from "../services/rag/EmbeddingService";
import { getTranslationService } from "../services/rag/TranslationService";

const DATA_FILE = path.resolve(process.cwd(), "data/usda_survey.json");
const BATCH_SIZE = 30;

// ---- Raw USDA types ----
interface RawNutrient {
    nutrient?: { id?: number; number?: string; name?: string };
    amount?: number;
}

interface RawPortion {
    portionDescription?: string;
    gramWeight?: number;
}

interface RawInputFood {
    id?: number;               // actual JSON field (not fdcId)
    foodDescription?: string;  // actual JSON field (not description)
    ingredientWeight?: number; // actual JSON field (not amount)
    unit?: string;             // actual JSON field — flat string (not measureUnit.name)
    portionDescription?: string;
    portionCode?: string;
}

interface RawFoodAttribute {
    name?: string;
    value?: string;
}

interface RawFood {
    fdcId: number;
    foodCode?: string;
    description: string;
    foodNutrients?: RawNutrient[];
    foodPortions?: RawPortion[];
    inputFoods?: RawInputFood[];
    foodAttributes?: RawFoodAttribute[];
    wweiaFoodCategory?: {
        wweiaFoodCategoryDescription?: string;
        wweiaFoodCategoryCode?: number;
    };
}

// ---- Helpers ----
function getWweiaInfo(raw: RawFood): { category?: string; category_code?: number } {
    if (raw.wweiaFoodCategory?.wweiaFoodCategoryDescription) {
        return {
            category: raw.wweiaFoodCategory.wweiaFoodCategoryDescription,
            category_code: raw.wweiaFoodCategory.wweiaFoodCategoryCode,
        };
    }
    // Fallback: foodAttributes
    const catAttr = raw.foodAttributes?.find((a) => a.name === "WWEIA Category description");
    const codeAttr = raw.foodAttributes?.find((a) => a.name === "WWEIA Category number");
    return {
        category: catAttr?.value,
        category_code: codeAttr?.value ? parseInt(codeAttr.value) : undefined,
    };
}

function rawToPartialDoc(
    raw: RawFood,
    descriptionVi: string,
    embedding: number[],
    inputFoodTranslations?: Map<string, string>,
) {
    const nutrients = extractNutrients(raw.foodNutrients ?? []);

    const portions = (raw.foodPortions ?? [])
        .filter((p) => p.portionDescription && p.gramWeight)
        .map((p) => ({ description: p.portionDescription!, gram_weight: p.gramWeight! }));

    const inputFoods = (raw.inputFoods ?? [])
        .filter((f) => f.foodDescription)
        .map((f) => ({
            fdc_id: f.id,
            description: f.foodDescription!,
            description_vi: inputFoodTranslations?.get(f.foodDescription!) ?? undefined,
            amount: f.ingredientWeight,
            unit: f.unit,
        }));

    const { category, category_code } = getWweiaInfo(raw);

    const searchTextInput = {
        description_vi: descriptionVi,
        description_en: raw.description,
        wweia_category: category,
        input_foods: inputFoods,
        portions,
        ...nutrients,
    };

    const search_text = buildUsdaSearchText(searchTextInput);
    const diet_tags = extractDietTags(search_text);

    return {
        fdc_id: raw.fdcId,
        food_code: raw.foodCode,
        description_en: raw.description,
        description_vi: descriptionVi,
        wweia_category: category,
        wweia_category_code: category_code,
        energy_kcal: nutrients.energy_kcal,
        protein: nutrients.protein,
        lipid: nutrients.lipid,
        glucid: nutrients.glucid,
        fiber: nutrients.fiber,
        water: nutrients.water,
        nutrients_extended: nutrients.nutrients_extended,
        portions,
        input_foods: inputFoods,
        diet_tags,
        search_text,
        embedding,
        imported_to_foods: false,
    };
}

// ---- JSON array reader (64MB is fine for Node.js heap) ----
async function* streamJsonArray(filePath: string): AsyncGenerator<RawFood> {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    let records: RawFood[];
    if (Array.isArray(parsed)) {
        records = parsed as RawFood[];
    } else if (parsed && typeof parsed === "object" && "SurveyFoods" in parsed) {
        records = (parsed as { SurveyFoods: RawFood[] }).SurveyFoods;
    } else {
        throw new Error("Unrecognized USDA JSON structure");
    }

    for (const record of records) {
        yield record;
    }
}

// ---- Main ----
async function main() {
    await connectDB();
    console.log("[ingest-usda] Connected to MongoDB");

    const embeddingService = getEmbeddingService();
    const translationService = getTranslationService();

    let total = 0;
    let skipped = 0;
    let inserted = 0;
    let errors = 0;

    const batch: RawFood[] = [];

    async function processBatch(records: RawFood[]) {
        // Resume check: filter out already-imported fdc_ids
        const fdcIds = records.map((r) => r.fdcId);
        const existing = await UsdaFood.find({ fdc_id: { $in: fdcIds } }).select("fdc_id").lean();
        const existingSet = new Set(existing.map((e) => e.fdc_id));

        const toProcess = records.filter((r) => !existingSet.has(r.fdcId));
        skipped += records.length - toProcess.length;

        if (toProcess.length === 0) return;

        // Batch translate main descriptions
        const descriptions = toProcess.map((r) => r.description);
        let translations: string[];
        try {
            translations = await translationService.translateBatch(descriptions);
        } catch (err) {
            console.warn("[ingest-usda] Translation failed, using originals:", err);
            translations = descriptions;
        }

        // Batch translate unique input_foods descriptions (RAG-01)
        const uniqueInputFoodDescs = [
            ...new Set(
                toProcess.flatMap((r) =>
                    (r.inputFoods ?? [])
                        .map((f) => f.foodDescription)
                        .filter((d): d is string => Boolean(d)),
                ),
            ),
        ];
        const inputFoodTranslations = new Map<string, string>();
        if (uniqueInputFoodDescs.length > 0) {
            try {
                const inputFoodTrans = await translationService.translateBatch(uniqueInputFoodDescs);
                uniqueInputFoodDescs.forEach((desc, idx) => {
                    if (inputFoodTrans[idx] && inputFoodTrans[idx] !== desc) {
                        inputFoodTranslations.set(desc, inputFoodTrans[idx]);
                    }
                });
            } catch (err) {
                console.warn("[ingest-usda] input_foods translation failed, using originals:", err);
            }
        }

        // Batch embed
        const searchTexts = toProcess.map((r, i) => {
            const partialNutrients = extractNutrients(r.foodNutrients ?? []);
            const partialSearch = buildUsdaSearchText({
                description_vi: translations[i],
                description_en: r.description,
                wweia_category: getWweiaInfo(r).category,
                input_foods: r.inputFoods
                    ?.filter((f) => f.foodDescription)
                    .map((f) => ({
                        description: f.foodDescription ?? "",
                        description_vi: inputFoodTranslations.get(f.foodDescription ?? "") ?? undefined,
                    })),
                portions: r.foodPortions?.map((p) => ({
                    description: p.portionDescription ?? "",
                    gram_weight: p.gramWeight ?? 0,
                })),
                energy_kcal: partialNutrients.energy_kcal,
                protein: partialNutrients.protein,
                lipid: partialNutrients.lipid,
                glucid: partialNutrients.glucid,
            });
            return partialSearch;
        });

        let embeddings: number[][];
        try {
            embeddings = await embeddingService.embedBatch(searchTexts, "document");
        } catch (err) {
            console.error("[ingest-usda] Embedding failed for batch:", err);
            errors += toProcess.length;
            return;
        }

        // Build documents
        const docs = toProcess.map((raw, i) =>
            rawToPartialDoc(raw, translations[i], embeddings[i], inputFoodTranslations),
        );

        // Insert
        try {
            await UsdaFood.insertMany(docs, { ordered: false });
            inserted += docs.length;
        } catch (err: unknown) {
            // ordered:false u2014 partial success is fine, count actual inserts
            if (err && typeof err === "object" && "insertedDocs" in err) {
                const insertErr = err as { insertedDocs?: unknown[] };
                inserted += insertErr.insertedDocs?.length ?? 0;
            }
            errors++;
        }
    }

    console.log(`[ingest-usda] Streaming ${DATA_FILE}...`);
    const startMs = Date.now();

    for await (const record of streamJsonArray(DATA_FILE)) {
        total++;
        batch.push(record);

        if (batch.length >= BATCH_SIZE) {
            await processBatch([...batch]);
            batch.length = 0;
            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
            console.log(
                `[ingest-usda] total=${total} inserted=${inserted} skipped=${skipped} errors=${errors} elapsed=${elapsed}s`,
            );
            // 20s delay between batches = stay under Voyage free tier 3 req/min
            await new Promise((r) => setTimeout(r, 20_000));
        }
    }

    // Process remaining
    if (batch.length > 0) {
        await processBatch(batch);
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
        `[ingest-usda] DONE: total=${total} inserted=${inserted} skipped=${skipped} errors=${errors} elapsed=${elapsed}s`,
    );

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error("[ingest-usda] Fatal error:", err);
    process.exit(1);
});
