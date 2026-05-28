/**
 * Embed existing foods collection into food_vectors.
 * Resume-safe: skips foods already in food_vectors.
 *
 * Usage: npx ts-node src/scripts/embed-existing-foods.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/database";
import Food, { IFood } from "../models/Food";
import FoodGroup from "../models/FoodGroup";
import FoodVector from "../models/FoodVector";
import { getEmbeddingService } from "../services/rag/EmbeddingService";
import { buildFoodSearchText } from "../utils/searchTextBuilder";
import { extractDietTags } from "../utils/dietTagger";

const BATCH_SIZE = 30;

type FoodLean = Omit<IFood, keyof mongoose.Document> & {
    _id: mongoose.Types.ObjectId;
    food_group_id?: mongoose.Types.ObjectId;
};

async function main() {
    await connectDB();
    console.log("[embed-foods] Connected to MongoDB");

    const embeddingService = getEmbeddingService();
    const total = await Food.countDocuments({ is_deleted: false });
    console.log(`[embed-foods] Total foods to process: ${total}`);

    // Pre-load food group names for lookup
    const groups = await FoodGroup.find().select("_id name_vi").lean();
    const groupMap = new Map(groups.map((g) => [g._id.toString(), g.name_vi]));

    let processed = 0;
    let inserted = 0;
    let skipped = 0;
    const startMs = Date.now();

    const batch: FoodLean[] = [];

    const processBatch = async (records: FoodLean[]) => {
        const ids = records.map((r) => r._id);
        const existing = await FoodVector.find({ source_id: { $in: ids } })
            .select("source_id")
            .lean();
        const existingSet = new Set(existing.map((e) => e.source_id.toString()));

        const toProcess = records.filter((r) => !existingSet.has(r._id.toString()));
        skipped += records.length - toProcess.length;
        if (toProcess.length === 0) return;

        const searchTexts = toProcess.map((food) => {
            const groupName = food.food_group_id
                ? groupMap.get(food.food_group_id.toString())
                : undefined;

            return buildFoodSearchText({
                name_vi: food.name_vi,
                name_en: food.name_en,
                food_group_name: groupName,
                search_keywords: food.search_keywords,
                energy_kcal: food.energy_kcal,
                protein: food.protein,
                lipid: food.lipid,
                glucid: food.glucid,
            });
        });

        const embeddings = await embeddingService.embedBatch(searchTexts, "document");

        const docs = toProcess.map((food, i) => ({
            source_id: food._id,
            source_type: "food" as const,
            embedding: embeddings[i],
            name: food.name_vi,
            diet_tags: extractDietTags(searchTexts[i]),
            is_approved: food.is_approved,
            embedding_model: "voyage-4-lite",
            embedding_version: 1,
        }));

        await FoodVector.insertMany(docs, { ordered: false }).catch(() => {/* skip duplicates */});
        inserted += docs.length;
    };

    const cursor = Food.find({ is_deleted: false }).lean().cursor();

    for await (const food of cursor) {
        processed++;
        batch.push(food as FoodLean);

        if (batch.length >= BATCH_SIZE) {
            await processBatch([...batch]);
            batch.length = 0;
            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
            console.log(
                `[embed-foods] ${processed}/${total} inserted=${inserted} skipped=${skipped} elapsed=${elapsed}s`,
            );
        }
    }

    if (batch.length > 0) await processBatch(batch);

    console.log(
        `[embed-foods] DONE: processed=${processed} inserted=${inserted} skipped=${skipped} elapsed=${((Date.now() - startMs) / 1000).toFixed(1)}s`,
    );
    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error("[embed-foods] Fatal:", err);
    process.exit(1);
});
