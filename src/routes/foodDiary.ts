import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import FoodDiary from "../models/FoodDiary";
import { IUser } from "../models/User";

const router = Router();

// GET /api/food-diary
router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { date, meal_type, limit = 50, offset = 0 } = req.query;

        const filter: Record<string, unknown> = { user_id: user._id };

        if (date) {
            const start = new Date(date as string);
            start.setHours(0, 0, 0, 0);
            const end = new Date(date as string);
            end.setHours(23, 59, 59, 999);
            filter.scanned_at = { $gte: start, $lte: end };
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
        const entry = await FoodDiary.create({ ...req.body, user_id: user._id });
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