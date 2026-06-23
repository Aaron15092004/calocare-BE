import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { IUser } from "../models/User";
import MealProgress from "../models/MealProgress";
import FoodDiary from "../models/FoodDiary";
import UserMealPlan from "../models/UserMealPlan";
import UserMealPlanItem from "../models/UserMealPlanItem";
import MealPlanItem from "../models/MealPlanItem";

const router = Router();

const MEAL_TYPES = [
    "breakfast",
    "lunch",
    "dinner",
    "snack",
    "morning_snack",
    "afternoon_snack",
] as const;

const CompleteMealSchema = z.object({
    user_meal_plan_id: z.string().min(1),
    day_number: z.number().int().min(1).max(366),
    meal_type: z.enum(MEAL_TYPES),
    notes: z.string().max(1000).optional(),
});

type Nutrition = {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number;
};

function numberOrZero(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function roundedNutrition(nutrition: Nutrition): Nutrition {
    return {
        calories: Math.round(nutrition.calories),
        protein: Math.round(nutrition.protein * 10) / 10,
        carbs: Math.round(nutrition.carbs * 10) / 10,
        fat: Math.round(nutrition.fat * 10) / 10,
        fiber: Math.round(nutrition.fiber * 10) / 10,
    };
}

function diaryMealType(mealType: (typeof MEAL_TYPES)[number]): "breakfast" | "lunch" | "dinner" | "snack" {
    if (mealType === "morning_snack" || mealType === "afternoon_snack") return "snack";
    return mealType;
}

/**
 * Meal plan items carry the authoritative planned calories. For database foods
 * the nutrition is per 100g, while recipes and AI custom foods are per serving.
 */
function toDiaryFood(item: any) {
    const recipe = item.recipe_id;
    const food = item.food_id;
    const usda = item.usda_food_id;
    const custom = item.custom_food;
    const plannedCalories = numberOrZero(item.calories);

    let name = "Món trong thực đơn";
    let source: "recipe" | "food" | "usda" | "ai_estimate" = "ai_estimate";
    let recipeId: unknown;
    let foodId: unknown;
    let usdaFdcId: number | undefined;
    let base: Nutrition = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
    let scale = 1;
    let weightGrams: number | undefined;

    if (recipe) {
        name = recipe.name_vi || recipe.name_en || name;
        source = "recipe";
        recipeId = recipe._id;
        base = {
            calories: numberOrZero(recipe.calories),
            protein: numberOrZero(recipe.protein),
            carbs: numberOrZero(recipe.carbs),
            fat: numberOrZero(recipe.fat),
            fiber: numberOrZero(recipe.fiber),
        };
        if (plannedCalories > 0 && base.calories > 0) scale = plannedCalories / base.calories;
    } else if (food) {
        name = food.name_vi || food.name_en || name;
        source = "food";
        foodId = food._id;
        base = {
            calories: numberOrZero(food.energy_kcal),
            protein: numberOrZero(food.protein),
            carbs: numberOrZero(food.glucid),
            fat: numberOrZero(food.lipid),
            fiber: numberOrZero(food.fiber),
        };
        weightGrams = numberOrZero(item.serving_size) || 100;
        scale = plannedCalories > 0 && base.calories > 0
            ? plannedCalories / base.calories
            : weightGrams / 100;
    } else if (usda) {
        name = usda.description_vi || usda.description_en || name;
        source = "usda";
        usdaFdcId = numberOrZero(usda.fdc_id) || undefined;
        base = {
            calories: numberOrZero(usda.energy_kcal),
            protein: numberOrZero(usda.protein),
            carbs: numberOrZero(usda.glucid),
            fat: numberOrZero(usda.lipid),
            fiber: numberOrZero(usda.fiber),
        };
        weightGrams = numberOrZero(item.serving_size) || 100;
        scale = plannedCalories > 0 && base.calories > 0
            ? plannedCalories / base.calories
            : weightGrams / 100;
    } else if (custom) {
        name = custom.name || name;
        base = {
            calories: numberOrZero(custom.calories_kcal),
            protein: numberOrZero(custom.protein_g),
            carbs: numberOrZero(custom.carbs_g),
            fat: numberOrZero(custom.fat_g),
            fiber: numberOrZero(custom.fiber_g),
        };
        if (plannedCalories > 0 && base.calories > 0) scale = plannedCalories / base.calories;
    }

    const nutrition = roundedNutrition({
        calories: plannedCalories > 0 ? plannedCalories : base.calories * scale,
        protein: base.protein * scale,
        carbs: base.carbs * scale,
        fat: base.fat * scale,
        fiber: base.fiber * scale,
    });

    return {
        dish_name: name,
        matched_name: name,
        source,
        nutrition,
        ...(weightGrams ? { weight_grams: weightGrams } : {}),
        ...(recipeId ? { recipe_id: recipeId } : {}),
        ...(foodId ? { food_id: foodId } : {}),
        ...(usdaFdcId ? { usda_fdc_id: usdaFdcId } : {}),
    };
}

// GET /api/meal-progress
router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { day_number, meal_type, user_meal_plan_id } = req.query;
        const filter: Record<string, unknown> = { user_id: user._id };
        if (day_number) filter.day_number = Number(day_number);
        if (meal_type) filter.meal_type = meal_type;
        if (user_meal_plan_id) filter.user_meal_plan_id = user_meal_plan_id;

        const progress = await MealProgress.find(filter).sort({ completed_at: -1 });
        res.json(progress);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/meal-progress
// Completes a whole planned meal and records its verified nutrition in the diary.
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const parsed = CompleteMealSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: "Invalid meal completion payload", details: parsed.error.flatten() });
            return;
        }

        const { user_meal_plan_id, day_number, meal_type, notes } = parsed.data;
        const userPlan = await UserMealPlan.findOne({ _id: user_meal_plan_id, user_id: user._id }).lean();
        if (!userPlan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }

        const existing = await MealProgress.findOne({
            user_id: user._id,
            user_meal_plan_id,
            day_number,
            meal_type,
        });
        if (existing) {
            res.status(409).json({ error: "meal_already_completed", progress: existing });
            return;
        }

        const populate = [
            { path: "recipe_id", select: "name_vi name_en calories protein carbs fat fiber" },
            { path: "food_id", select: "name_vi name_en energy_kcal protein lipid glucid fiber" },
            { path: "usda_food_id", select: "fdc_id description_vi description_en energy_kcal protein lipid glucid fiber" },
        ];
        let items = await UserMealPlanItem.find({ user_meal_plan_id, day_number, meal_type })
            .populate(populate)
            .sort({ sort_order: 1 })
            .lean();

        // Most plans use shared MealPlanItem records; user-specific rows are optional.
        if (!items.length) {
            items = await MealPlanItem.find({
                meal_plan_id: userPlan.meal_plan_id,
                day_number,
                meal_type,
            })
                .populate(populate)
                .sort({ sort_order: 1 })
                .lean() as unknown as typeof items;
        }

        if (!items.length) {
            res.status(404).json({ error: "meal_items_not_found" });
            return;
        }

        const foods = items.map(toDiaryFood);
        const totals = roundedNutrition(foods.reduce<Nutrition>(
            (sum, food) => ({
                calories: sum.calories + food.nutrition.calories,
                protein: sum.protein + food.nutrition.protein,
                carbs: sum.carbs + food.nutrition.carbs,
                fat: sum.fat + food.nutrition.fat,
                fiber: sum.fiber + food.nutrition.fiber,
            }),
            { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
        ));

        const diaryEntry = await FoodDiary.create({
            user_id: user._id,
            foods,
            totals,
            meal_type: diaryMealType(meal_type),
            notes,
        });

        try {
            const progress = await MealProgress.create({
                user_id: user._id,
                user_meal_plan_id,
                day_number,
                meal_type,
                recipe_id: foods.find((food) => food.recipe_id)?.recipe_id,
                diary_entry_id: diaryEntry._id,
                notes,
            });
            res.status(201).json({ ...progress.toObject(), diary_entry: diaryEntry });
        } catch (error) {
            await FoodDiary.deleteOne({ _id: diaryEntry._id, user_id: user._id });
            throw error;
        }
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/meal-progress/:id
router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const progress = await MealProgress.findOneAndDelete({ _id: req.params.id, user_id: user._id });
        if (!progress) {
            res.status(404).json({ error: "Progress not found" });
            return;
        }

        if (progress.diary_entry_id) {
            await FoodDiary.deleteOne({ _id: progress.diary_entry_id, user_id: user._id });
        }
        res.json({ message: "Progress deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
