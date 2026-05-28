/**
 * GET /api/widget/daily-summary
 * Lightweight endpoint for home screen widget data.
 * Returns calories consumed, remaining, and macro progress for today.
 */
import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { IUser } from "../models/User";
import FoodDiary from "../models/FoodDiary";
import User from "../models/User";

const router = Router();
router.use(authenticate);

router.get("/daily-summary", async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const userId = user._id.toString();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [diaryEntries, userDoc] = await Promise.all([
        FoodDiary.find({
            user_id: userId,
            date: { $gte: today, $lt: tomorrow },
        })
            .select("calories protein carbs fat")
            .lean(),
        User.findById(userId)
            .select("daily_nutrition_goals display_name subscription_tier")
            .lean(),
    ]);

    const goals = userDoc?.daily_nutrition_goals ?? {};
    const calorieGoal = (goals.calories as number) ?? 2000;
    const proteinGoal = (goals.protein as number) ?? 120;
    const carbsGoal = (goals.carbs as number) ?? 250;
    const fatGoal = (goals.fat as number) ?? 65;

    const consumed = diaryEntries.reduce(
        (acc, e) => ({
            calories: acc.calories + ((e as any).calories ?? 0),
            protein: acc.protein + ((e as any).protein ?? 0),
            carbs: acc.carbs + ((e as any).carbs ?? 0),
            fat: acc.fat + ((e as any).fat ?? 0),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );

    res.json({
        date: today.toISOString().split("T")[0],
        display_name: userDoc?.display_name ?? "",
        calorie_goal: calorieGoal,
        calories_consumed: Math.round(consumed.calories),
        calories_remaining: Math.max(0, calorieGoal - Math.round(consumed.calories)),
        calorie_pct: Math.min(100, Math.round((consumed.calories / calorieGoal) * 100)),
        macros: {
            protein: { consumed: Math.round(consumed.protein * 10) / 10, goal: proteinGoal },
            carbs: { consumed: Math.round(consumed.carbs * 10) / 10, goal: carbsGoal },
            fat: { consumed: Math.round(consumed.fat * 10) / 10, goal: fatGoal },
        },
    });
});

export default router;
