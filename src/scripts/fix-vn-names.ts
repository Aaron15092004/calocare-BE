/**
 * One-time DB cleanup for Vietnamese-first food/recipe names.
 *
 * 1. FS-sourced foods whose name_vi has no Vietnamese diacritics:
 *    - LLM-classify junk (cocktails, supplements, brand-only, non-food)
 *      → archived to `foods_removed` (soft delete, reversible) and removed
 *      from `foods` + `food_vectors`.
 *    - Remaining items (plus English-named USDA foods) get name_vi
 *      translated en→vi via TranslationService; the old English name is
 *      kept in name_en and appended to search_keywords.
 * 2. Changed foods/recipes are re-embedded (food_vectors / recipe_vectors).
 * 3. FS recipes with English names get the same translate + re-embed.
 * 4. FS recipes lacking RecipeIngredient links are queued for enrichment.
 * 5. Fixes known mojibake ("Rau r¨m" → "Rau răm").
 *
 * Idempotent: re-running finds nothing left to fix.
 * Usage: npx ts-node src/scripts/fix-vn-names.ts [--dry-run]
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/database";
import Food from "../models/Food";
import Recipe from "../models/Recipe";
import FoodGroup from "../models/FoodGroup";
import FoodVector from "../models/FoodVector";
import RecipeVector from "../models/RecipeVector";
import RecipeIngredient from "../models/RecipeIngredient";
import { getTranslationService } from "../services/rag/TranslationService";
import { getEmbeddingService } from "../services/rag/EmbeddingService";
import { getEnrichmentService } from "../services/rag/EnrichmentService";
import { buildFoodSearchText, buildRecipeSearchText } from "../utils/searchTextBuilder";
import { extractDietTags } from "../utils/dietTagger";

const DRY_RUN = process.argv.includes("--dry-run");
const VI_DIACRITICS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
const CLASSIFY_BATCH = 40;
const EMBED_BATCH = 30;

type LeanFood = {
    _id: mongoose.Types.ObjectId;
    name_vi: string;
    name_en?: string;
    source_reference?: string;
    search_keywords?: string[];
    food_group_id?: mongoose.Types.ObjectId;
    energy_kcal?: number;
    protein?: number;
    lipid?: number;
    glucid?: number;
    is_approved?: boolean;
};

// Deterministic junk detection. An LLM classifier was tried first but flagged
// real foods (Bánh Mì, Bò Kho, Coconut Milk, Bean Sprouts) as junk — deleting
// data demands near-zero false positives, so only unambiguous patterns match.
const ALCOHOL_RE = /\b(cocktail|gin|rum|vodka|whiskey|whisky|tequila|brandy|liqueur|martini|margarita|mojito|daiquiri|mai tai|tom collins|long island iced tea|sex on the beach|pina colada|bloody mary|sloe gin|alcoholic beverage|screwdriver|old fashioned|manhattan \(cocktail\)|fizz\b)\b/i;
const SUPPLEMENT_RE = /\b(whey|casein|protein (powder|isolate|concentrate|shake|blend)|soy protein (concentrate|isolate)|pre.?workout|creatine|bcaa|\bcla\b|dha|epa\b|fish oil|meal replacement|nutritional shake|mass gainer|weight gainer|multivitamin|prenatal|probiotics? (vanilla|chocolate)|amino acid|collagen peptide|isolate\b|\biso hd\b|cytocarb|vi-shape)\b/i;
// Exact junk names seen in the audit: brand fragments with no food meaning.
const EXACT_JUNK = new Set(["sun", "burn", "duo", "mix", "c4", "blast", "trai"]);

function classifyJunk(names: string[]): Set<number> {
    const junk = new Set<number>();
    names.forEach((name, i) => {
        const n = name.trim().toLowerCase();
        if (EXACT_JUNK.has(n) || ALCOHOL_RE.test(n) || SUPPLEMENT_RE.test(n)) junk.add(i);
    });
    return junk;
}

async function reembedFoods(ids: mongoose.Types.ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    const embedding = getEmbeddingService();
    const groups = await FoodGroup.find().select("_id name_vi").lean();
    const groupMap = new Map(groups.map((g) => [g._id.toString(), g.name_vi]));

    await FoodVector.deleteMany({ source_id: { $in: ids } });

    for (let i = 0; i < ids.length; i += EMBED_BATCH) {
        const chunk = await Food.find({ _id: { $in: ids.slice(i, i + EMBED_BATCH) } }).lean<LeanFood[]>();
        const texts = chunk.map((food) => buildFoodSearchText({
            name_vi: food.name_vi,
            name_en: food.name_en,
            food_group_name: food.food_group_id ? groupMap.get(food.food_group_id.toString()) : undefined,
            search_keywords: food.search_keywords,
            energy_kcal: food.energy_kcal,
            protein: food.protein,
            lipid: food.lipid,
            glucid: food.glucid,
        }));
        const embeddings = await embedding.embedBatch(texts, "document");
        const docs = chunk.map((food, j) => ({
            source_id: food._id,
            source_type: "food" as const,
            embedding: embeddings[j],
            name: food.name_vi,
            diet_tags: extractDietTags(texts[j]),
            is_approved: food.is_approved,
            embedding_model: "voyage-4-lite",
            embedding_version: 1,
        }));
        await FoodVector.insertMany(docs, { ordered: false }).catch(() => {});
        console.log(`[fix-vn] re-embedded foods ${Math.min(i + EMBED_BATCH, ids.length)}/${ids.length}`);
    }
}

async function reembedRecipes(ids: mongoose.Types.ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    const embedding = getEmbeddingService();
    await RecipeVector.deleteMany({ source_id: { $in: ids } });

    for (let i = 0; i < ids.length; i += EMBED_BATCH) {
        const chunk = await Recipe.find({ _id: { $in: ids.slice(i, i + EMBED_BATCH) } }).lean();
        const texts = chunk.map((r: Record<string, unknown>) => buildRecipeSearchText({
            name: r.name_vi as string,
            description: r.description as string | undefined,
            meal_type: r.meal_type as string | undefined,
            cuisine: r.cuisine_type as string | undefined,
            tags: r.tags as string[] | undefined,
            energy_kcal: r.calories as number | undefined,
            protein: r.protein as number | undefined,
            lipid: r.fat as number | undefined,
            glucid: r.carbs as number | undefined,
        }));
        const embeddings = await embedding.embedBatch(texts, "document");
        const docs = chunk.map((r: Record<string, unknown>, j: number) => ({
            source_id: r._id,
            source_type: "recipe" as const,
            embedding: embeddings[j],
            name: r.name_vi as string,
            diet_tags: extractDietTags(texts[j]),
            is_approved: r.is_approved as boolean | undefined,
            embedding_model: "voyage-4-lite",
            embedding_version: 1,
        }));
        await RecipeVector.insertMany(docs, { ordered: false }).catch(() => {});
        console.log(`[fix-vn] re-embedded recipes ${Math.min(i + EMBED_BATCH, ids.length)}/${ids.length}`);
    }
}

async function main() {
    await connectDB();
    console.log(`[fix-vn] Connected. ${DRY_RUN ? "DRY RUN — no writes." : "LIVE RUN."}`);
    const translator = getTranslationService();
    const db = mongoose.connection.db!;

    // ── Step 0: mojibake fix ────────────────────────────────────────────
    const mojibake = await Food.find({ name_vi: /¨/ }).lean<LeanFood[]>();
    for (const food of mojibake) {
        const fixed = food.name_vi.replace(/r¨m/gi, "răm").replace(/¨/g, "");
        console.log(`[fix-vn] mojibake: "${food.name_vi}" → "${fixed}"`);
        if (!DRY_RUN) await Food.updateOne({ _id: food._id }, { $set: { name_vi: fixed } });
    }

    // ── Step 1: FS foods with non-Vietnamese name_vi → junk filter ─────
    const fsAscii = await Food.find({
        source_reference: /^FS-/,
        name_vi: { $not: VI_DIACRITICS },
    }).lean<LeanFood[]>();
    console.log(`[fix-vn] FS foods with non-VN name_vi: ${fsAscii.length}`);

    const junkIdx = classifyJunk(fsAscii.map((f) => f.name_vi));
    const junkFoods = fsAscii.filter((_, i) => junkIdx.has(i));
    const keptFoods = fsAscii.filter((_, i) => !junkIdx.has(i));
    console.log(`[fix-vn] junk to remove: ${junkFoods.length}`);
    junkFoods.forEach((f) => console.log(`  [junk] ${f.name_vi} (${f.source_reference})`));

    if (!DRY_RUN && junkFoods.length > 0) {
        const removedDocs = junkFoods.map((f) => ({
            ...f,
            removed_reason: "llm_junk_classification",
            removed_at: new Date(),
        }));
        await db.collection("foods_removed").insertMany(removedDocs);
        const junkIds = junkFoods.map((f) => f._id);
        await FoodVector.deleteMany({ source_id: { $in: junkIds } });
        await Food.deleteMany({ _id: { $in: junkIds } });
        console.log(`[fix-vn] archived ${junkFoods.length} junk foods to foods_removed`);
    }

    // ── Step 2: translate kept FS + English-named USDA foods ───────────
    const usdaAscii = await Food.find({
        source_reference: /^USDA/,
        name_vi: { $not: VI_DIACRITICS },
    }).lean<LeanFood[]>();
    const toTranslate = [...keptFoods, ...usdaAscii];
    console.log(`[fix-vn] foods to translate: ${toTranslate.length} (FS kept ${keptFoods.length} + USDA ${usdaAscii.length})`);

    const changedFoodIds: mongoose.Types.ObjectId[] = [];
    if (toTranslate.length > 0) {
        const sourceNames = toTranslate.map((f) => f.name_en?.trim() || f.name_vi);
        if (DRY_RUN) {
            const preview = await translator.translateBatch(sourceNames.slice(0, 20));
            sourceNames.slice(0, 20).forEach((en, i) => console.log(`  [translate] "${en}" → "${preview[i]}"`));
            console.log(`  ... (${toTranslate.length - Math.min(20, toTranslate.length)} more in live run)`);
        } else {
            const translated = await translator.translateBatch(sourceNames);
            for (let i = 0; i < toTranslate.length; i++) {
                const food = toTranslate[i];
                const vi = translated[i]?.trim();
                if (!vi || vi === food.name_vi) continue;
                const keywords = new Set([...(food.search_keywords ?? []), food.name_vi, food.name_en ?? ""].filter(Boolean));
                await Food.updateOne(
                    { _id: food._id },
                    {
                        $set: {
                            name_vi: vi,
                            name_en: food.name_en?.trim() || food.name_vi,
                            search_keywords: [...keywords],
                        },
                    },
                );
                changedFoodIds.push(food._id);
            }
            console.log(`[fix-vn] translated ${changedFoodIds.length} food names`);
        }
    }

    // ── Step 3: re-embed changed foods ──────────────────────────────────
    if (!DRY_RUN) await reembedFoods(changedFoodIds);

    // ── Step 4: FS recipes with English names ───────────────────────────
    const fsRecipes = await Recipe.find({
        source_reference: /^FS-/,
        name_vi: { $not: VI_DIACRITICS },
    }).lean();
    console.log(`[fix-vn] FS recipes with non-VN names: ${fsRecipes.length}`);

    const changedRecipeIds: mongoose.Types.ObjectId[] = [];
    if (fsRecipes.length > 0 && !DRY_RUN) {
        const names = fsRecipes.map((r: Record<string, unknown>) => (r.name_en as string)?.trim() || (r.name_vi as string));
        const translated = await translator.translateBatch(names);
        for (let i = 0; i < fsRecipes.length; i++) {
            const recipe = fsRecipes[i] as Record<string, unknown>;
            const vi = translated[i]?.trim();
            if (!vi || vi === recipe.name_vi) continue;
            await Recipe.updateOne(
                { _id: recipe._id },
                { $set: { name_vi: vi, name_en: (recipe.name_en as string)?.trim() || (recipe.name_vi as string) } },
            );
            changedRecipeIds.push(recipe._id as mongoose.Types.ObjectId);
        }
        console.log(`[fix-vn] translated ${changedRecipeIds.length} recipe names`);
        await reembedRecipes(changedRecipeIds);
    }

    // ── Step 5: queue FS recipes lacking ingredient links ───────────────
    const fsRecipeIds = await Recipe.find({ source_reference: /^FS-/ }).select("_id").lean();
    const linked = new Set(
        (await RecipeIngredient.distinct("recipe_id", {
            recipe_id: { $in: fsRecipeIds.map((r) => r._id) },
        })).map((id: mongoose.Types.ObjectId) => id.toString()),
    );
    const unlinked = fsRecipeIds.filter((r) => !linked.has(r._id.toString())).map((r) => r._id.toString());
    console.log(`[fix-vn] FS recipes without ingredient links: ${unlinked.length}`);
    if (!DRY_RUN && unlinked.length > 0) {
        await getEnrichmentService().queueRecipeEnrichment(unlinked, { type: "admin" });
        console.log(`[fix-vn] queued ${unlinked.length} recipes for ingredient enrichment`);
    }

    console.log("[fix-vn] DONE.");
    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error("[fix-vn] Fatal:", err);
    process.exit(1);
});
