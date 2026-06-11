import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import FoodDiary from "../models/FoodDiary";
import { IUser } from "../models/User";
import { getFatSecretImportService, FatSecretImportService } from "../services/rag/FatSecretImportService";

const router = Router();

const NutritionSchema = z.object({
    calories: z.number().finite().min(0).max(10000),
    protein: z.number().finite().min(0).max(1000),
    carbs: z.number().finite().min(0).max(1000),
    fat: z.number().finite().min(0).max(1000),
    fiber: z.number().finite().min(0).max(1000).optional().default(0),
});

const FoodItemSchema = z.object({
    dish_name: z.string().min(1).max(200),
    source: z.enum(["recipe", "food", "ai_estimate", "usda", "fatsecret"]),
    matched_name: z.string().max(200).optional(),
    nutrition: NutritionSchema,
    weight_grams: z.number().finite().min(0).max(5000).optional(),
    servings: z.number().finite().min(0).max(100).optional(),
    recipe_id: z.string().optional(),
    food_id: z.string().optional(),
    usda_fdc_id: z.number().int().positive().optional(),
});

const CreateDiarySchema = z.object({
    foods: z.array(FoodItemSchema).min(1).max(20),
    totals: NutritionSchema,
    mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
    meal_type: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
    healthScore: z.number().finite().min(0).max(100).optional(),
    health_score: z.number().finite().min(0).max(100).optional(),
    vitamins: z.unknown().optional(),
    healthTips: z.unknown().optional(),
    health_tips: z.unknown().optional(),
    imageUrl: z.string().url().optional().or(z.literal("").transform(() => undefined)),
    image_url: z.string().url().optional().or(z.literal("").transform(() => undefined)),
    notes: z.string().max(1000).optional(),
});

const ScanResultSchema = z.object({
    name: z.string().min(1).max(200),
    source_type: z.enum(["recipe", "food", "ai_estimate", "usda"]).optional(),
    source_id: z.string().optional(),
    calories: z.number().finite().min(0).max(10000).optional(),
    protein: z.number().finite().min(0).max(1000).optional(),
    carbs: z.number().finite().min(0).max(1000).optional(),
    fat: z.number().finite().min(0).max(1000).optional(),
    serving_size: z.number().finite().min(1).max(5000).optional(),
    per_100g: z.object({
        calories: z.number().finite().min(0).max(3000),
        protein: z.number().finite().min(0).max(1000),
        carbs: z.number().finite().min(0).max(1000),
        fat: z.number().finite().min(0).max(1000),
    }).optional(),
});

const SaveAiScanSchema = z.object({
    scan_result: ScanResultSchema,
    meal_type: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
    quantity: z.number().finite().min(1).max(20).optional(),
    weight_grams: z.number().finite().min(1).max(5000).optional(),
    date: z.string().datetime().optional(),
});

// GET /api/food-diary
router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { date, start_date, end_date, meal_type, limit = 50, offset = 0 } = req.query;

        const filter: Record<string, unknown> = { user_id: user._id };

        if (date) {
            const start = new Date(date as string);
            start.setHours(0, 0, 0, 0);
            const end = new Date(date as string);
            end.setHours(23, 59, 59, 999);
            filter.scanned_at = { $gte: start, $lte: end };
        } else if (start_date || end_date) {
            const rangeFilter: Record<string, Date> = {};
            if (start_date) {
                const s = new Date(start_date as string);
                s.setHours(0, 0, 0, 0);
                rangeFilter.$gte = s;
            }
            if (end_date) {
                const e = new Date(end_date as string);
                e.setHours(23, 59, 59, 999);
                rangeFilter.$lte = e;
            }
            filter.scanned_at = rangeFilter;
        }

        if (meal_type) filter.meal_type = meal_type;

        const entries = await FoodDiary.find(filter)
            .sort({ scanned_at: -1 })
            .limit(Number(limit))
            .skip(Number(offset));

        const total = await FoodDiary.countDocuments(filter);
        res.json({ data: entries, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/food-diary
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const parsed = CreateDiarySchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: "Invalid diary payload", details: parsed.error.flatten() });
            return;
        }

        const payload = parsed.data;
        // Strip fs_food_id (not in schema) before creating
        const foods = (payload.foods as unknown as Record<string, unknown>[]).map(
            ({ fs_food_id: _, ...rest }) => rest,
        );
        const entry = await FoodDiary.create({
            foods,
            totals: payload.totals,
            meal_type: payload.meal_type ?? payload.mealType ?? "lunch",
            health_score: payload.health_score ?? payload.healthScore,
            vitamins: payload.vitamins,
            health_tips: payload.health_tips ?? payload.healthTips,
            image_url: payload.image_url ?? payload.imageUrl,
            notes: payload.notes,
            user_id: user._id,
        });
        res.status(201).json(entry);

        // Enrich any FatSecret foods into local DB (background, after response sent)
        if (FatSecretImportService.isAvailable()) {
            const originalFoods = (req.body.foods ?? []) as { source?: string; fs_food_id?: string; dish_name?: string }[];
            for (const food of originalFoods) {
                if (food.source === "fatsecret" && food.fs_food_id) {
                    getFatSecretImportService()
                        .upsertFullFoodWithViName(food.fs_food_id, food.dish_name ?? "")
                        .catch(() => {});
                }
            }
        }
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/food-diary/ai-scan — save a RAG scan result to diary
router.post("/ai-scan", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const parsed = SaveAiScanSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: "Invalid ai-scan payload", details: parsed.error.flatten() });
            return;
        }
        const { scan_result, meal_type, quantity = 1, weight_grams, date } = parsed.data;

        // Recalculate nutrition if user adjusted the gram weight
        let calories = scan_result.calories ?? 0;
        let protein  = scan_result.protein  ?? 0;
        let carbs    = scan_result.carbs    ?? 0;
        let fat      = scan_result.fat      ?? 0;

        if (weight_grams && scan_result.per_100g) {
            const f = weight_grams / 100;
            calories = scan_result.per_100g.calories * f;
            protein  = scan_result.per_100g.protein  * f;
            carbs    = scan_result.per_100g.carbs    * f;
            fat      = scan_result.per_100g.fat      * f;
        }

        const qty = Number(quantity);
        const totCal  = Math.round(calories * qty);
        const totProt = Math.round(protein  * qty * 10) / 10;
        const totCarb = Math.round(carbs    * qty * 10) / 10;
        const totFat  = Math.round(fat      * qty * 10) / 10;

        const source = (scan_result.source_type ?? "ai_estimate") as
            "recipe" | "food" | "ai_estimate" | "usda";

        const foodItem: Record<string, unknown> = {
            dish_name:    scan_result.name,
            source,
            matched_name: scan_result.name,
            nutrition: { calories: totCal, protein: totProt, carbs: totCarb, fat: totFat, fiber: 0 },
            weight_grams: weight_grams ?? ((scan_result.serving_size ?? 100) * qty),
            servings:     qty,
        };
        if (source === "food"   && scan_result.source_id) foodItem.food_id   = scan_result.source_id;
        if (source === "recipe" && scan_result.source_id) foodItem.recipe_id = scan_result.source_id;

        const entry = await FoodDiary.create({
            user_id:    user._id,
            scanned_at: date ? new Date(date) : new Date(),
            foods:      [foodItem],
            totals:     { calories: totCal, protein: totProt, carbs: totCarb, fat: totFat, fiber: 0 },
            meal_type:  meal_type ?? "lunch",
        });

        res.status(201).json(entry);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// PUT /api/food-diary/:id
router.put("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const entry = await FoodDiary.findOneAndUpdate(
            { _id: req.params.id, user_id: user._id },
            req.body,
            { new: true, runValidators: true },
        );
        if (!entry) {
            res.status(404).json({ error: "Entry not found" });
            return;
        }
        res.json(entry);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/food-diary/:id
router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const entry = await FoodDiary.findOneAndDelete({ _id: req.params.id, user_id: user._id });
        if (!entry) {
            res.status(404).json({ error: "Entry not found" });
            return;
        }
        res.json({ message: "Entry deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
