/**
 * Vietnamese Institute of Nutrition (Viện Dinh Dưỡng Quốc Gia) food data ingest.
 * Reads ./data/vn_nutrition_sample.json, upserts into Food collection, and creates
 * FoodVector entries for semantic search.
 *
 * Resume-safe: skips records already in DB by source_reference (VN-{code}).
 * Usage: npx ts-node src/scripts/ingest-vn-nutrition.ts [--data path/to/file.json]
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { connectDB } from "../config/database";
import Food from "../models/Food";
import FoodVector from "../models/FoodVector";
import FoodGroup from "../models/FoodGroup";
import { getEmbeddingService } from "../services/rag/EmbeddingService";
import { buildFoodSearchText } from "../utils/searchTextBuilder";
import { extractDietTags } from "../utils/dietTagger";

const BATCH_SIZE = 20;
// Voyage AI free tier: 5 RPM → 1 call per 12s minimum. Set to 15s for safety.
const EMBED_DELAY_MS = 15_000;

interface VnNutritionRecord {
    code: string;
    name_vi: string;
    name_en?: string;
    food_group?: string;
    energy_kcal: number;
    protein: number;
    lipid: number;
    glucid: number;
    fiber?: number;
    water?: number;
    ash?: number;
    waste_percentage?: number;
    notes?: string;
    nutrients_extended?: Record<string, unknown>;
}

async function getOrCreateFoodGroup(name: string): Promise<string> {
    const existing = await FoodGroup.findOne({ name_vi: name }).lean();
    if (existing) return existing._id.toString();
    const created = await FoodGroup.create({
        code: Math.floor(Math.random() * 90000) + 10000,
        name_vi: name,
        name_en: name,
    });
    return created._id.toString();
}

async function main(): Promise<void> {
    await connectDB();

    const dataArg = process.argv.find((a) => a.startsWith("--data="));
    const dataFile = dataArg
        ? path.resolve(process.cwd(), dataArg.replace("--data=", ""))
        : path.resolve(process.cwd(), "data/vn_nutrition_sample.json");

    if (!fs.existsSync(dataFile)) {
        console.error(`[ingest-vn-nutrition] Data file not found: ${dataFile}`);
        process.exit(1);
    }

    const records: VnNutritionRecord[] = JSON.parse(fs.readFileSync(dataFile, "utf-8"));
    console.log(`[ingest-vn-nutrition] Loaded ${records.length} records from ${path.basename(dataFile)}`);

    const groupCache = new Map<string, string>();
    let imported = 0;
    let skipped = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const sourceRefs = batch.map((r) => `VN-${r.code}`);

        const existing = await Food.find({ source_reference: { $in: sourceRefs } })
            .select("source_reference")
            .lean();
        const existingSet = new Set(existing.map((f) => f.source_reference));

        const toImport = batch.filter((r) => !existingSet.has(`VN-${r.code}`));
        skipped += batch.length - toImport.length;

        if (toImport.length === 0) {
            console.log(`[ingest-vn-nutrition] Batch ${i}–${i + batch.length - 1}: all skipped`);
            continue;
        }

        // Build search texts for batch embedding
        const searchTexts = toImport.map((r) =>
            buildFoodSearchText({
                name_vi: r.name_vi,
                name_en: r.name_en,
                energy_kcal: r.energy_kcal,
                protein: r.protein,
                lipid: r.lipid,
                glucid: r.glucid,
                diet_tags: extractDietTags(r.name_vi),
            }),
        );

        console.log(`[ingest-vn-nutrition] Embedding batch ${i}–${i + batch.length - 1} (${toImport.length} items)...`);
        const embeddings = await getEmbeddingService().embedBatch(searchTexts, "document");

        for (let j = 0; j < toImport.length; j++) {
            const r = toImport[j];
            const sourceRef = `VN-${r.code}`;

            let groupId: string | undefined;
            if (r.food_group) {
                if (!groupCache.has(r.food_group)) {
                    groupCache.set(r.food_group, await getOrCreateFoodGroup(r.food_group));
                }
                groupId = groupCache.get(r.food_group);
            }

            const food = await Food.create({
                code: r.code,
                name_vi: r.name_vi,
                name_en: r.name_en,
                food_group_id: groupId,
                energy_kcal: r.energy_kcal,
                protein: r.protein,
                lipid: r.lipid,
                glucid: r.glucid,
                fiber: r.fiber,
                water: r.water,
                ash: r.ash,
                waste_percentage: r.waste_percentage,
                nutrients_extended: r.nutrients_extended,
                source_reference: sourceRef,
                is_approved: true,
                notes: r.notes ?? `Nguồn: Viện Dinh Dưỡng Quốc Gia Việt Nam`,
                search_keywords: [r.name_vi, r.name_en, r.food_group].filter(Boolean) as string[],
            });

            const dietTags = extractDietTags(r.name_vi + " " + (r.name_en ?? ""));

            await FoodVector.updateOne(
                { source_id: food._id },
                {
                    $set: {
                        source_type: "food",
                        embedding: embeddings[j],
                        name: r.name_vi,
                        diet_tags: dietTags,
                        is_approved: true,
                        embedding_model: "voyage-4-lite",
                        embedding_version: 1,
                    },
                },
                { upsert: true },
            );

            imported++;
        }

        console.log(`[ingest-vn-nutrition] Batch ${i}–${i + batch.length - 1}: ${toImport.length} imported`);

        if (i + BATCH_SIZE < records.length) {
            console.log(`[ingest-vn-nutrition] Waiting ${EMBED_DELAY_MS / 1000}s for Voyage rate limit...`);
            await new Promise((r) => setTimeout(r, EMBED_DELAY_MS));
        }
    }

    console.log(`\n[ingest-vn-nutrition] Done. Imported: ${imported} | Skipped (already in DB): ${skipped}`);
    process.exit(0);
}

main().catch((err) => {
    console.error("[ingest-vn-nutrition] Fatal:", err);
    process.exit(1);
});
