import cron from "node-cron";
import axios from "axios";
import { getEnrichmentService } from "./EnrichmentService";
import Recipe from "../../models/Recipe";
import Food from "../../models/Food";
import { isCloudinaryUrl } from "../CloudinaryService";

async function runImageHealthCheck(batchSize = 50): Promise<void> {
    // Find records with external (non-Cloudinary) image URLs
    const [recipes, foods] = await Promise.all([
        Recipe.find({
            image_url: { $nin: [null, ""] },
        }).select("_id image_url").limit(batchSize).lean(),
        Food.find({
            image_url: { $nin: [null, ""] },
        }).select("_id image_url").limit(batchSize).lean(),
    ]);

    const records = [
        ...recipes.map((r) => ({ model: "Recipe" as const, id: String(r._id), url: r.image_url as string })),
        ...foods.map((f) => ({ model: "Food" as const, id: String(f._id), url: f.image_url as string })),
    ].filter((r) => !isCloudinaryUrl(r.url));

    let cleared = 0;
    for (const record of records) {
        try {
            await axios.head(record.url, { timeout: 5000 });
        } catch {
            // Broken URL — clear it so the enrichment worker will re-fetch
            if (record.model === "Recipe") {
                await Recipe.updateOne({ _id: record.id }, { $unset: { image_url: 1, images: 1, image_attribution: 1 } });
            } else {
                await Food.updateOne({ _id: record.id }, { $unset: { image_url: 1 } });
            }
            cleared++;
        }
    }

    console.log(`[EnrichmentCron] Image health-check: checked ${records.length} external URLs, cleared ${cleared} broken`);
}

export function startEnrichmentCron(): void {
    // Every 10 minutes — keep well below Voyage AI 5 RPM free-tier limit
    cron.schedule("*/10 * * * *", async () => {
        try {
            await getEnrichmentService().runWorker();
        } catch (err) {
            console.error("[EnrichmentCron] Worker error:", err);
        }
    });

    // RAG-03: Weekly image backfill — Sunday 03:00 — fills missing images in batches
    cron.schedule("0 3 * * 0", async () => {
        try {
            const counts = await getEnrichmentService().runImageBackfill(100);
            console.log(`[EnrichmentCron] Image backfill complete: ${counts.recipes} recipes, ${counts.foods} foods queued`);
        } catch (err) {
            console.error("[EnrichmentCron] Image backfill error:", err);
        }
    });

    // RAG-05: Monthly stale data refresh — 1st of month 04:00 — re-queues items >90 days old
    cron.schedule("0 4 1 * *", async () => {
        try {
            const count = await getEnrichmentService().runStaleRefresh(90, 200);
            console.log(`[EnrichmentCron] Stale refresh queued ${count} items`);
        } catch (err) {
            console.error("[EnrichmentCron] Stale refresh error:", err);
        }
    });

    // Weekly image health-check — Sunday 04:00 — validates non-Cloudinary image URLs
    cron.schedule("0 4 * * 0", async () => {
        try {
            await runImageHealthCheck(50);
        } catch (err) {
            console.error("[EnrichmentCron] Image health-check error:", err);
        }
    });

    console.log("[EnrichmentCron] Started (worker: every 10 min | image backfill: weekly Sun 03:00 | health-check: weekly Sun 04:00 | stale refresh: monthly 1st 04:00)");
}
