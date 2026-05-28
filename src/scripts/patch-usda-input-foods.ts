/**
 * One-time patch: fix input_foods + search_text + embedding for existing UsdaFood docs.
 *
 * Root cause: ingest-usda.ts had wrong field names for RawInputFood:
 *   - fdcId   → actual: id
 *   - description → actual: foodDescription
 *   - amount  → actual: ingredientWeight
 *   - measureUnit.name → actual: unit (flat string)
 * Result: input_foods was always [] and search_text had 0kcal/0g nutrition.
 *
 * This script reads usda_survey.json, patches existing documents in-place.
 * Does NOT create or delete any documents.
 *
 * Usage: npx ts-node src/scripts/patch-usda-input-foods.ts
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import { connectDB } from "../config/database";
import UsdaFood from "../models/UsdaFood";
import { extractNutrients } from "../utils/nutrientExtractor";
import { buildUsdaSearchText } from "../utils/searchTextBuilder";
import { getEmbeddingService } from "../services/rag/EmbeddingService";

const DATA_FILE = path.resolve(process.cwd(), "data/usda_survey.json");
// Voyage free tier: 3 RPM → must wait ≥20s between embed calls
const BATCH_SIZE = 20;
const EMBED_DELAY_MS = 22_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RawInputFood {
    id?: number;
    foodDescription?: string;
    ingredientWeight?: number;
    unit?: string;
}

interface RawNutrient {
    nutrient?: { id?: number; number?: string };
    amount?: number;
}

interface RawPortion {
    portionDescription?: string;
    gramWeight?: number;
}

interface RawFood {
    fdcId: number;
    description: string;
    foodNutrients?: RawNutrient[];
    foodPortions?: RawPortion[];
    inputFoods?: RawInputFood[];
    wweiaFoodCategory?: {
        wweiaFoodCategoryDescription?: string;
        wweiaFoodCategoryCode?: number;
    };
    foodAttributes?: Array<{ name?: string; value?: string }>;
}

function getWweiaCategory(raw: RawFood): string | undefined {
    if (raw.wweiaFoodCategory?.wweiaFoodCategoryDescription) {
        return raw.wweiaFoodCategory.wweiaFoodCategoryDescription;
    }
    return raw.foodAttributes?.find((a) => a.name === "WWEIA Category description")?.value;
}

async function main() {
    await connectDB();
    console.log("[patch-usda-input-foods] Connected to MongoDB");

    const rawFile = fs.readFileSync(DATA_FILE, "utf8");
    const parsed: unknown = JSON.parse(rawFile);
    let records: RawFood[];
    if (Array.isArray(parsed)) {
        records = parsed as RawFood[];
    } else if (parsed && typeof parsed === "object" && "SurveyFoods" in parsed) {
        records = (parsed as { SurveyFoods: RawFood[] }).SurveyFoods;
    } else {
        throw new Error("Unrecognized USDA JSON structure");
    }

    const totalInDb = await UsdaFood.countDocuments({
        $or: [{ input_foods: { $size: 0 } }, { input_foods: { $exists: false } }],
    });
    console.log(`[patch-usda-input-foods] Loaded ${records.length} records from JSON`);
    console.log(`[patch-usda-input-foods] ${totalInDb} docs still need patching`);
    const estMinutes = Math.ceil((totalInDb / BATCH_SIZE) * (EMBED_DELAY_MS / 1000) / 60);
    console.log(`[patch-usda-input-foods] Estimated time: ~${estMinutes} minutes`);

    const embeddingService = getEmbeddingService();
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const fdcIds = batch.map((r) => r.fdcId);

        // Only update records that exist in DB AND still have empty input_foods (not yet patched)
        // This makes re-runs resume-safe: already-patched docs are skipped
        const existingDocs = await UsdaFood.find({
            fdc_id: { $in: fdcIds },
            $or: [
                { input_foods: { $size: 0 } },
                { input_foods: { $exists: false } },
            ],
        })
            .select("fdc_id description_vi wweia_category diet_tags")
            .lean();

        if (existingDocs.length === 0) {
            skipped += batch.length;
            continue;
        }

        const docMap = new Map(existingDocs.map((d) => [d.fdc_id, d]));

        // Build patch data for existing docs only
        const toEmbed: { fdcId: number; searchText: string; inputFoods: object[]; portions: object[] }[] = [];

        for (const raw of batch) {
            const doc = docMap.get(raw.fdcId);
            if (!doc) { skipped++; continue; }

            const nutrients = extractNutrients(raw.foodNutrients ?? []);

            const inputFoods = (raw.inputFoods ?? [])
                .filter((f) => f.foodDescription)
                .map((f) => ({
                    fdc_id: f.id,
                    description: f.foodDescription!,
                    amount: f.ingredientWeight,
                    unit: f.unit,
                }));

            const portions = (raw.foodPortions ?? [])
                .filter((p) => p.portionDescription && p.gramWeight)
                .map((p) => ({ description: p.portionDescription!, gram_weight: p.gramWeight! }));

            const searchText = buildUsdaSearchText({
                description_vi: doc.description_vi,
                description_en: raw.description,
                wweia_category: getWweiaCategory(raw) ?? doc.wweia_category,
                input_foods: inputFoods,
                portions,
                energy_kcal: nutrients.energy_kcal,
                protein: nutrients.protein,
                lipid: nutrients.lipid,
                glucid: nutrients.glucid,
                diet_tags: doc.diet_tags,
            });

            toEmbed.push({ fdcId: raw.fdcId, searchText, inputFoods, portions });
        }

        if (toEmbed.length === 0) continue;

        // Embed in batch — rate limited to 3 RPM on Voyage free tier
        let embeddings: number[][];
        try {
            embeddings = await embeddingService.embedBatch(
                toEmbed.map((e) => e.searchText),
                "document",
            );
            // Wait after every successful embed to stay within 3 RPM (20s min)
            await sleep(EMBED_DELAY_MS);
        } catch (err) {
            console.error(`[patch] Embed failed for batch at i=${i}:`, err);
            errors += toEmbed.length;
            // Still wait before next retry to avoid immediate 429 again
            await sleep(EMBED_DELAY_MS);
            continue;
        }

        // Bulk update — only patch input_foods, search_text, embedding
        const bulkOps = toEmbed.map((e, idx) => ({
            updateOne: {
                filter: { fdc_id: e.fdcId },
                update: {
                    $set: {
                        input_foods: e.inputFoods,
                        portions: e.portions,
                        search_text: e.searchText,
                        embedding: embeddings[idx],
                    },
                },
            },
        }));

        await UsdaFood.bulkWrite(bulkOps, { ordered: false });
        updated += toEmbed.length;

        if (updated % 500 === 0 || i + BATCH_SIZE >= records.length) {
            console.log(`[patch-usda-input-foods] ${updated} updated, ${skipped} skipped, ${errors} errors`);
        }
    }

    console.log(`[patch-usda-input-foods] Done. updated=${updated} skipped=${skipped} errors=${errors}`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error("[patch-usda-input-foods] Fatal:", err);
    process.exit(1);
});
