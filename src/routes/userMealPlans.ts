import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { IUser } from "../models/User";
import UserMealPlan from "../models/UserMealPlan";
import UserMealPlanItem from "../models/UserMealPlanItem";
import MealPlanItem from "../models/MealPlanItem";

const ITEM_POPULATE = [
    { path: "recipe_id", select: "name_vi name_en calories protein carbs fat fiber description instructions image_url" },
    { path: "food_id",   select: "name_vi name_en energy_kcal image_url" },
];

const router = Router();

// GET /api/user-meal-plans/active-with-items
// Returns active plan + all items in a single round-trip. Used by MealPlan page.
router.get("/active-with-items", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;

        const plans = await UserMealPlan.find({ user_id: user._id, is_active: true })
            .populate("meal_plan_id")
            .sort({ created_at: -1 })
            .lean();

        const validPlan = plans.find((p) => p.meal_plan_id != null);
        if (!validPlan) {
            res.json({ plan: null, items: [] });
            return;
        }

        let items = await UserMealPlanItem.find({ user_meal_plan_id: validPlan._id })
            .populate(ITEM_POPULATE)
            .sort({ day_number: 1, sort_order: 1 })
            .lean();

        if (!items.length) {
            const mealPlanId = (validPlan.meal_plan_id as any)._id ?? validPlan.meal_plan_id;
            items = await MealPlanItem.find({ meal_plan_id: mealPlanId })
                .populate(ITEM_POPULATE)
                .sort({ day_number: 1, sort_order: 1 })
                .lean() as unknown as typeof items;
        }

        res.set("Cache-Control", "private, max-age=0, must-revalidate");
        res.json({ plan: validPlan, items });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/user-meal-plans — get user's active plans with full items
router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { is_active } = req.query;
        const filter: Record<string, unknown> = { user_id: user._id };
        if (is_active !== undefined) filter.is_active = is_active === "true";

        const plans = await UserMealPlan.find(filter)
            .populate("meal_plan_id")
            .sort({ created_at: -1 })
            .lean();

        res.json(plans);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/user-meal-plans/:id/items
router.get("/:id/items", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const plan = await UserMealPlan.findOne({ _id: req.params.id, user_id: user._id }).lean();
        if (!plan) {
            res.status(404).json({ error: "Plan not found" });
            return;
        }

        let items = await UserMealPlanItem.find({ user_meal_plan_id: plan._id })
            .populate(ITEM_POPULATE)
            .sort({ day_number: 1, sort_order: 1 })
            .lean();

        if (!items.length) {
            items = await MealPlanItem.find({ meal_plan_id: plan.meal_plan_id })
                .populate(ITEM_POPULATE)
                .sort({ day_number: 1, sort_order: 1 })
                .lean() as unknown as typeof items;
        }

        res.json(items);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/user-meal-plans — assign a plan to user
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { meal_plan_id, start_date } = req.body;

        // Deactivate existing active plans
        await UserMealPlan.updateMany({ user_id: user._id, is_active: true }, { is_active: false });

        const plan = await UserMealPlan.create({
            user_id: user._id,
            meal_plan_id,
            start_date: start_date || new Date(),
            is_active: true,
        });

        res.status(201).json(plan);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/user-meal-plans/:id
router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        await UserMealPlan.findOneAndDelete({ _id: req.params.id, user_id: user._id });
        res.json({ message: "Plan removed" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
