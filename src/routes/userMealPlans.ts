import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { IUser } from "../models/User";
import UserMealPlan from "../models/UserMealPlan";
import UserMealPlanItem from "../models/UserMealPlanItem";
import MealPlanItem from "../models/MealPlanItem";

const router = Router();

// GET /api/user-meal-plans — get user's active plans with full items
router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { is_active } = req.query;
        const filter: Record<string, unknown> = { user_id: user._id };
        if (is_active !== undefined) filter.is_active = is_active === "true";

        const plans = await UserMealPlan.find(filter)
            .populate("meal_plan_id")
            .sort({ created_at: -1 });

        res.json(plans);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/user-meal-plans/:id/items
router.get("/:id/items", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const plan = await UserMealPlan.findOne({ _id: req.params.id, user_id: user._id });
        if (!plan) {
            res.status(404).json({ error: "Plan not found" });
            return;
        }

        // Use user_meal_plan_items if they exist, else fall back to meal_plan_items
        let items = await UserMealPlanItem.find({ user_meal_plan_id: plan._id })
            .populate("recipe_id", "name_vi name_en calories image_url")
            .populate("food_id", "name_vi name_en energy_kcal")
            .sort({ day_number: 1, sort_order: 1 });

        if (!items.length) {
            items = (await MealPlanItem.find({ meal_plan_id: plan.meal_plan_id })
                .populate("recipe_id", "name_vi name_en calories image_url")
                .populate("food_id", "name_vi name_en energy_kcal")
                .sort({ day_number: 1, sort_order: 1 })) as typeof items;
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