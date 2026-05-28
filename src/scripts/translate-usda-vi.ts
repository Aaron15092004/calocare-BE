/**
 * Batch-translate USDA food English descriptions to Vietnamese.
 * Finds all UsdaFood records missing description_vi (or still equal to description_en)
 * and updates them using TranslationService (Groq).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/translate-usda-vi.ts
 *
 * Rate: ~30 items per Groq call, ~1s delay between batches.
 * For 10 000 items: ~5-6 minutes.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import UsdaFood from "../models/UsdaFood";
import { getTranslationService } from "../services/rag/TranslationService";

const BATCH_SIZE = 30;
const DELAY_MS = 1_200;

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    await mongoose.connect(process.env.MONGODB_URI!);
    console.log("[translate-usda-vi] Connected to MongoDB");

    const translation = getTranslationService();

    // Find records missing Vietnamese name or still using English as placeholder
    const total = await UsdaFood.countDocuments({
        $or: [
            { description_vi: { $exists: false } },
            { description_vi: null },
            { description_vi: "" },
        ],
    });
    console.log(`[translate-usda-vi] Found ${total} records to translate`);

    let processed = 0;
    let page = 0;

    while (processed < total) {
        const batch = await UsdaFood.find({
            $or: [
                { description_vi: { $exists: false } },
                { description_vi: null },
                { description_vi: "" },
            ],
        })
            .select("_id description_en")
            .limit(BATCH_SIZE)
            .skip(page * BATCH_SIZE)
            .lean();

        if (batch.length === 0) break;

        const enDescriptions = batch.map((f) => f.description_en);

        let viDescriptions: string[] = enDescriptions;
        try {
            viDescriptions = await translation.translateBatch(enDescriptions);
        } catch (err) {
            console.warn(`[translate-usda-vi] Batch ${page + 1} translation failed, using English:`, err);
        }

        const bulkOps = batch.map((f, idx) => ({
            updateOne: {
                filter: { _id: f._id },
                update: {
                    $set: {
                        description_vi: viDescriptions[idx] || f.description_en,
                    },
                },
            },
        }));

        await UsdaFood.bulkWrite(bulkOps);
        processed += batch.length;
        page++;

        process.stdout.write(`\r[translate-usda-vi] ${processed}/${total} (${Math.round((processed / total) * 100)}%)`);

        if (processed < total) await sleep(DELAY_MS);
    }

    console.log(`\n[translate-usda-vi] Done. Translated ${processed} USDA records.`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error("[translate-usda-vi] Fatal:", err);
    process.exit(1);
});
