import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { IUser } from "../models/User";
import MealProgress from "../models/MealProgress";

const router = Router();

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
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const progress = await MealProgress.create({ ...req.body, user_id: user._id });
        res.status(201).json(progress);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/meal-progress/:id
router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        await MealProgress.findOneAndDelete({ _id: req.params.id, user_id: user._id });
        res.json({ message: "Progress deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;