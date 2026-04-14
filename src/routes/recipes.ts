import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import { IUser } from "../models/User";
import Recipe from "../models/Recipe";
import RecipeIngredient from "../models/RecipeIngredient";

const router = Router();

// GET /api/recipes
router.get("/", async (req: Request, res: Response) => {
    try {
        const { q, category_id, is_approved, is_public, mine, community, limit = 50, offset = 0 } = req.query;
        const filter: Record<string, unknown> = { is_deleted: { $ne: true } };

        if (q) {
            filter.$or = [
                { name_vi: { $regex: q as string, $options: "i" } },
                { name_en: { $regex: q as string, $options: "i" } },
                { tags: { $in: [(q as string).toLowerCase()] } },
            ];
        }
        if (category_id) filter.category_id = category_id;
        if (is_approved !== undefined) filter.is_approved = is_approved === "true";
        if (is_public !== undefined) filter.is_public = is_public === "true";

        // mine=true → filtered by creator in auth middleware below; handled at query level here
        if (mine === "true" && req.headers.authorization) {
            // Will be populated post-auth; handled in authenticated route
        }
        if (community === "true") {
            filter.is_approved = true;
            filter.is_public = true;
        }

        const recipes = await Recipe.find(filter)
            .populate("category_id", "name_vi name_en")
            .sort({ created_at: -1 })
            .limit(Number(limit))
            .skip(Number(offset));

        const total = await Recipe.countDocuments(filter);
        res.json({ data: recipes, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/recipes/mine — user's own recipes (authenticated)
router.get("/mine", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { q, limit = 100, offset = 0 } = req.query;
        const filter: Record<string, unknown> = {
            is_deleted: { $ne: true },
            creator_id: user._id,
        };
        if (q) {
            filter.$or = [
                { name_vi: { $regex: q as string, $options: "i" } },
                { name_en: { $regex: q as string, $options: "i" } },
            ];
        }
        const recipes = await Recipe.find(filter)
            .sort({ created_at: -1 })
            .limit(Number(limit))
            .skip(Number(offset));
        const total = await Recipe.countDocuments(filter);
        res.json({ data: recipes, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/recipes/:id — includes ingredients
router.get("/:id", async (req: Request, res: Response) => {
    try {
        const recipe = await Recipe.findById(req.params.id).populate(
            "category_id",
            "name_vi name_en",
        );
        if (!recipe) {
            res.status(404).json({ error: "Recipe not found" });
            return;
        }
        await Recipe.updateOne({ _id: recipe._id }, { $inc: { view_count: 1 } });

        const ingredients = await RecipeIngredient.find({ recipe_id: recipe._id }).populate(
            "food_id",
            "name_vi name_en energy_kcal protein lipid glucid fiber",
        );
        res.json({ ...recipe.toObject(), ingredients });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/recipes — any authenticated user
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { ingredients, ...recipeData } = req.body;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";

        if (recipeData.images?.length && !recipeData.image_url) {
            recipeData.image_url = recipeData.images[0];
        }

        const recipe = await Recipe.create({
            ...recipeData,
            creator_id: user._id,
            is_public: isAdmin ? (recipeData.is_public ?? false) : false,
            is_approved: isAdmin ? (recipeData.is_approved ?? false) : false,
        });

        if (ingredients?.length) {
            await RecipeIngredient.insertMany(
                ingredients.map((ing: Record<string, unknown>, idx: number) => ({
                    ...ing,
                    recipe_id: recipe._id,
                    sort_order: idx,
                })),
            );
        }

        res.status(201).json(recipe);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// PUT /api/recipes/:id — creator or admin
router.put("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const recipe = await Recipe.findById(req.params.id);
        if (!recipe) {
            res.status(404).json({ error: "Recipe not found" });
            return;
        }

        const isOwner = recipe.creator_id?.toString() === (user._id as any).toString();
        if (!isAdmin && !isOwner) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }

        const { ingredients, ...recipeData } = req.body;
        if (!isAdmin) {
            delete recipeData.is_approved;
            delete recipeData.is_public;
        }
        if (recipeData.images?.length) recipeData.image_url = recipeData.images[0];

        const updated = await Recipe.findByIdAndUpdate(req.params.id, recipeData, {
            new: true,
            runValidators: true,
        });

        if (ingredients !== undefined) {
            await RecipeIngredient.deleteMany({ recipe_id: recipe._id });
            if (ingredients.length) {
                await RecipeIngredient.insertMany(
                    ingredients.map((ing: Record<string, unknown>, idx: number) => ({
                        ...ing,
                        recipe_id: recipe._id,
                        sort_order: idx,
                    })),
                );
            }
        }

        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/recipes/:id — creator or admin (soft delete)
router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const recipe = await Recipe.findById(req.params.id);
        if (!recipe) {
            res.status(404).json({ error: "Recipe not found" });
            return;
        }

        const isOwner = recipe.creator_id?.toString() === (user._id as any).toString();
        if (!isAdmin && !isOwner) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }

        await Recipe.findByIdAndUpdate(req.params.id, { is_deleted: true });
        res.json({ message: "Recipe deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/recipes/:id/submit — user submits own recipe for community review
router.post("/:id/submit", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const recipe = await Recipe.findById(req.params.id);
        if (!recipe) {
            res.status(404).json({ error: "Recipe not found" });
            return;
        }
        const isOwner = recipe.creator_id?.toString() === (user._id as any).toString();
        if (!isOwner) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        const updated = await Recipe.findByIdAndUpdate(
            req.params.id,
            { is_public: true, is_approved: false },
            { new: true },
        );
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/recipes/:id/approve — admin only
router.post("/:id/approve", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await Recipe.findByIdAndUpdate(
            req.params.id,
            { is_approved: true, is_public: true },
            { new: true },
        );
        if (!updated) {
            res.status(404).json({ error: "Recipe not found" });
            return;
        }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/recipes/:id/reject — admin only
router.post("/:id/reject", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await Recipe.findByIdAndUpdate(
            req.params.id,
            { is_approved: false, is_public: false },
            { new: true },
        );
        if (!updated) {
            res.status(404).json({ error: "Recipe not found" });
            return;
        }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
