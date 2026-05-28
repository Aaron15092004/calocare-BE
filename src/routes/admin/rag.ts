import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAdminOrModerator } from "../../middleware/roleCheck";
import Food from "../../models/Food";
import FoodVector from "../../models/FoodVector";
import Recipe from "../../models/Recipe";
import RecipeVector from "../../models/RecipeVector";
import EnrichmentQueue from "../../models/EnrichmentQueue";
import { getEnrichmentService } from "../../services/rag/EnrichmentService";
import { getFatSecretImportService, FatSecretImportService } from "../../services/rag/FatSecretImportService";

const router = Router();

// All admin RAG routes require admin/moderator role
router.use(authenticate, requireAdminOrModerator);

// GET /api/admin/rag/foods/pending?source=usda
router.get("/foods/pending", async (req: Request, res: Response) => {
    const source = req.query.source as string | undefined;
    const page = parseInt(req.query.page as string ?? "1");
    const limit = parseInt(req.query.limit as string ?? "20");

    const filter: Record<string, unknown> = { is_approved: false, is_deleted: false };
    if (source === "usda") {
        filter.source_reference = /^USDA-/;
    }

    const [foods, total] = await Promise.all([
        Food.find(filter)
            .sort({ created_at: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .select("name_vi name_en energy_kcal protein lipid glucid source_reference notes created_at")
            .lean(),
        Food.countDocuments(filter),
    ]);

    res.json({ foods, total, page, limit });
});

// PUT /api/admin/rag/foods/:id/approve
router.put("/foods/:id/approve", async (req: Request, res: Response) => {
    const food = await Food.findByIdAndUpdate(
        req.params.id,
        { is_approved: true },
        { new: true },
    ).lean();

    if (!food) {
        res.status(404).json({ error: "Food not found" });
        return;
    }

    await FoodVector.updateOne({ source_id: food._id }, { is_approved: true });

    res.json({ ok: true, food });
});

// DELETE /api/admin/rag/foods/:id/reject
router.delete("/foods/:id/reject", async (req: Request, res: Response) => {
    const food = await Food.findByIdAndUpdate(
        req.params.id,
        { is_deleted: true },
        { new: true },
    ).lean();

    if (!food) {
        res.status(404).json({ error: "Food not found" });
        return;
    }

    await FoodVector.deleteOne({ source_id: food._id });

    res.json({ ok: true });
});

// GET /api/admin/rag/recipes/pending — AI-generated recipes awaiting approval (no creator_id)
router.get("/recipes/pending", async (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string ?? "1");
    const limit = parseInt(req.query.limit as string ?? "20");

    const filter = { is_approved: false, is_deleted: false, creator_id: { $exists: false } };

    const [recipes, total] = await Promise.all([
        Recipe.find(filter)
            .sort({ created_at: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .select("name_vi name_en calories protein carbs fat meal_type created_at")
            .lean(),
        Recipe.countDocuments(filter),
    ]);

    res.json({ recipes, total, page, limit });
});

// PUT /api/admin/rag/recipes/:id/approve
router.put("/recipes/:id/approve", async (req: Request, res: Response) => {
    const recipe = await Recipe.findByIdAndUpdate(
        req.params.id,
        { is_approved: true, is_public: true },
        { new: true },
    ).lean();

    if (!recipe) {
        res.status(404).json({ error: "Recipe not found" });
        return;
    }

    await RecipeVector.updateOne({ source_id: recipe._id }, { is_approved: true });

    res.json({ ok: true, recipe });
});

// DELETE /api/admin/rag/recipes/:id/reject
router.delete("/recipes/:id/reject", async (req: Request, res: Response) => {
    const recipe = await Recipe.findByIdAndUpdate(
        req.params.id,
        { is_deleted: true },
        { new: true },
    ).lean();

    if (!recipe) {
        res.status(404).json({ error: "Recipe not found" });
        return;
    }

    await RecipeVector.deleteOne({ source_id: recipe._id });

    res.json({ ok: true });
});

// GET /api/admin/rag/enrichment-queue
router.get("/enrichment-queue", async (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    const page = parseInt(req.query.page as string ?? "1");
    const limit = parseInt(req.query.limit as string ?? "20");

    const filter = status ? { status } : {};
    const [jobs, total] = await Promise.all([
        EnrichmentQueue.find(filter)
            .sort({ created_at: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        EnrichmentQueue.countDocuments(filter),
    ]);

    res.json({ jobs, total, page, limit });
});

// POST /api/admin/rag/image-backfill — RAG-03: trigger image enrichment for records missing images
router.post("/image-backfill", async (req: Request, res: Response) => {
    const batchSize = Math.min(parseInt(req.query.batch as string ?? "50"), 500);
    const counts = await getEnrichmentService().runImageBackfill(batchSize);
    res.json({ ok: true, queued: counts });
});

// POST /api/admin/rag/stale-refresh — RAG-05: re-queue stale enrichment jobs
router.post("/stale-refresh", async (req: Request, res: Response) => {
    const staleDays = Math.min(parseInt(req.query.days as string ?? "90"), 365);
    const count = await getEnrichmentService().runStaleRefresh(staleDays);
    res.json({ ok: true, requeued: count });
});

// POST /api/admin/rag/fatsecret-import — batch-import FatSecret VN foods for a given query
// ?query=phở&limit=20  (limit max 50, default 20)
router.post("/fatsecret-import", async (req: Request, res: Response) => {
    if (!FatSecretImportService.isAvailable()) {
        res.status(503).json({ error: "FATSECRET_KEY / FATSECRET_SECRET chưa được cấu hình trong .env" });
        return;
    }

    const query = (req.query.query as string | undefined)?.trim();
    if (!query) {
        res.status(400).json({ error: "Thiếu tham số ?query=..." });
        return;
    }

    const limit = Math.min(parseInt(req.query.limit as string ?? "20"), 50);
    const result = await getFatSecretImportService().batchImportQuery(query, limit);
    res.json({ ok: true, ...result });
});

// GET /api/admin/notifications/pending-counts
router.get("/notifications/pending-counts", async (_req: Request, res: Response) => {
    const [pendingFoods, pendingRecipes, pendingEnrichment] = await Promise.all([
        Food.countDocuments({ is_approved: false, is_deleted: false }),
        Recipe.countDocuments({ is_approved: false, is_deleted: false, creator_id: { $exists: false } }),
        EnrichmentQueue.countDocuments({ status: "pending" }),
    ]);

    res.json({
        pending_foods: pendingFoods,
        pending_recipes: pendingRecipes,
        pending_enrichment: pendingEnrichment,
        total: pendingFoods + pendingRecipes + pendingEnrichment,
    });
});

export default router;
