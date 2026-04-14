import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { IUser } from "../models/User";
import UserFavorite from "../models/UserFavorite";
import Food from "../models/Food";
import Recipe from "../models/Recipe";

const router = Router();

// GET /api/favorites?type=food|recipe
router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { type } = req.query;

        const filter: Record<string, unknown> = { user_id: user.id };
        if (type === "food" || type === "recipe") filter.item_type = type;

        const favorites = await UserFavorite.find(filter).sort({ created_at: -1 });

        // Populate food or recipe data
        const foodIds = favorites.filter((f) => f.item_type === "food").map((f) => f.item_id);
        const recipeIds = favorites.filter((f) => f.item_type === "recipe").map((f) => f.item_id);

        const [foods, recipes] = await Promise.all([
            foodIds.length
                ? Food.find({ _id: { $in: foodIds } }).select(
                      "name_vi name_en energy_kcal protein_g total_fat_g carbohydrate_g dietary_fiber_g image_url",
                  )
                : [],
            recipeIds.length
                ? Recipe.find({ _id: { $in: recipeIds } }).select(
                      "name_vi name_en calories protein carbs fat image_url",
                  )
                : [],
        ]);

        const foodMap = new Map(foods.map((f) => [String(f._id), f]));
        const recipeMap = new Map(recipes.map((r) => [String(r._id), r]));

        const result = favorites.map((fav) => ({
            _id: fav._id,
            item_type: fav.item_type,
            item_id: fav.item_id,
            created_at: fav.created_at,
            item:
                fav.item_type === "food"
                    ? foodMap.get(String(fav.item_id)) || null
                    : recipeMap.get(String(fav.item_id)) || null,
        }));

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/favorites — add favorite
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { item_type, item_id } = req.body;

        if (!item_type || !item_id) {
            res.status(400).json({ error: "item_type and item_id are required" });
            return;
        }
        if (item_type !== "food" && item_type !== "recipe") {
            res.status(400).json({ error: "item_type must be food or recipe" });
            return;
        }

        const fav = await UserFavorite.findOneAndUpdate(
            { user_id: user.id, item_type, item_id },
            { user_id: user.id, item_type, item_id },
            { upsert: true, new: true },
        );

        res.status(201).json(fav);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/favorites/:item_type/:item_id — remove favorite
router.delete("/:item_type/:item_id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { item_type, item_id } = req.params;

        await UserFavorite.deleteOne({ user_id: user.id, item_type, item_id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/favorites/check/:item_type/:item_id
router.get("/check/:item_type/:item_id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { item_type, item_id } = req.params;

        const exists = await UserFavorite.exists({ user_id: user.id, item_type, item_id });
        res.json({ is_favorite: !!exists });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
