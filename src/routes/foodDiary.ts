import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import FoodDiary from "../models/FoodDiary";
import { IUser } from "../models/User";
import { getFatSecretImportService, FatSecretImportService } from "../services/rag/FatSecretImportService";

const router = Router();

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
        // Strip fs_food_id (not in schema) before creating
        const foods = ((req.body.foods ?? []) as Record<string, unknown>[]).map(
            ({ fs_food_id: _, ...rest }) => rest,
        );
        const entry = await FoodDiary.create({ ...req.body, foods, user_id: user._id });
        res.status(201).json(entry);

        // Enrich any FatSecret foods into local DB (background, after response sent)
        if (FatSecretImportService.isAvailable()) {
            const foods = (req.body.foods ?? []) as { source?: string; fs_food_id?: string; dish_name?: string }[];
            for (const food of foods) {
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
        const { scan_result, meal_type, quantity = 1, weight_grams, date } = req.body;

        if (!scan_result) {
            res.status(400).json({ error: "scan_result is required" });
            return;
        }

        // Recalculate nutrition if user adjusted the gram weight
        let calories = scan_result.calories as number;
        let protein  = scan_result.protein  as number;
        let carbs    = scan_result.carbs    as number;
        let fat      = scan_result.fat      as number;

        if (weight_grams && scan_result.per_100g) {
            const f = (weight_grams as number) / 100;
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
            weight_grams: weight_grams ?? (scan_result.serving_size * qty),
            servings:     qty,
        };
        if (source === "food"   && scan_result.source_id) foodItem.food_id   = scan_result.source_id;
        if (source === "recipe" && scan_result.source_id) foodItem.recipe_id = scan_result.source_id;

        const entry = await FoodDiary.create({
            user_id:    user._id,
            scanned_at: date ? new Date(date as string) : new Date(),
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