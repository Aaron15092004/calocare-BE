/**
 * Embed existing recipes collection into recipe_vectors.
 * Resume-safe: skips recipes already in recipe_vectors.
 *
 * Usage: npx ts-node src/scripts/embed-existing-recipes.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/database";
import Recipe, { IRecipe } from "../models/Recipe";
import RecipeVector from "../models/RecipeVector";
import RecipeCategory from "../models/RecipeCategory";
import { getEmbeddingService } from "../services/rag/EmbeddingService";
import { buildRecipeSearchText } from "../utils/searchTextBuilder";
import { extractDietTags } from "../utils/dietTagger";

const BATCH_SIZE = 30;

type RecipeLean = Omit<IRecipe, keyof mongoose.Document> & {
    _id: mongoose.Types.ObjectId;
    category_id?: mongoose.Types.ObjectId;
};

async function main() {
    await connectDB();
    console.log("[embed-recipes] Connected to MongoDB");

    const embeddingService = getEmbeddingService();
    const total = await Recipe.countDocuments({ is_deleted: false });
    console.log(`[embed-recipes] Total recipes: ${total}`);

    // Pre-load category names for lookup
    const categories = await RecipeCategory.find().select("_id name_vi").lean();
    const categoryMap = new Map(categories.map((c) => [c._id.toString(), c.name_vi]));

    let processed = 0;
    let inserted = 0;
    let skipped = 0;
    const startMs = Date.now();

    const batch: RecipeLean[] = [];

    const processBatch = async (records: RecipeLean[]) => {
        const ids = records.map((r) => r._id);
        const existing = await RecipeVector.find({ source_id: { $in: ids } })
            .select("source_id")
            .lean();
        const existingSet = new Set(existing.map((e) => e.source_id.toString()));

        const toProcess = records.filter((r) => !existingSet.has(r._id.toString()));
        skipped += records.length - toProcess.length;
        if (toProcess.length === 0) return;

        const searchTexts = toProcess.map((recipe) => {
            const categoryName: string | undefined = recipe.category_id
                ? categoryMap.get(recipe.category_id.toString())
                : undefined;

            const instructions = Array.isArray(recipe.instructions)
                ? recipe.instructions.map((step) => {
                      if (typeof step === "string") return step;
                      if (step && typeof step === "object" && "description" in step)
                          return (step as { description: string }).description;
                      return JSON.stringify(step);
                  }).join(" ")
                : undefined;

            return buildRecipeSearchText({
                name: recipe.name_vi,
                description: recipe.description,
                category: categoryName,
                meal_type: recipe.meal_type,
                cuisine: recipe.cuisine_type,
                instructions,
                tags: recipe.tags,
                energy_kcal: recipe.calories,
                protein: recipe.protein,
                lipid: recipe.fat,
                glucid: recipe.carbs,
            });
        });

        const embeddings = await embeddingService.embedBatch(searchTexts, "document");

        const docs = toProcess.map((recipe, i) => ({
            source_id: recipe._id,
            source_type: "recipe" as const,
            embedding: embeddings[i],
            name: recipe.name_vi,
            diet_tags: extractDietTags(searchTexts[i]),
            is_approved: recipe.is_approved,
            embedding_model: "voyage-4-lite",
            embedding_version: 1,
        }));

        await RecipeVector.insertMany(docs, { ordered: false }).catch(() => {/* skip duplicates */});
        inserted += docs.length;
    };

    const cursor = Recipe.find({ is_deleted: false }).lean().cursor();

    for await (const recipe of cursor) {
        processed++;
        batch.push(recipe as RecipeLean);

        if (batch.length >= BATCH_SIZE) {
            await processBatch([...batch]);
            batch.length = 0;
            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
            console.log(
                `[embed-recipes] ${processed}/${total} inserted=${inserted} skipped=${skipped} elapsed=${elapsed}s`,
            );
        }
    }

    if (batch.length > 0) await processBatch(batch);

    console.log(
        `[embed-recipes] DONE: processed=${processed} inserted=${inserted} skipped=${skipped} elapsed=${((Date.now() - startMs) / 1000).toFixed(1)}s`,
    );
    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error("[embed-recipes] Fatal:", err);
    process.exit(1);
});
