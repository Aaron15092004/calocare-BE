import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import RecipeCategory from "../models/RecipeCategory";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
    try {
        const cats = await RecipeCategory.find().sort({ sort_order: 1 });
        res.json(cats);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const cat = await RecipeCategory.create(req.body);
        res.status(201).json(cat);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.put("/:id", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const cat = await RecipeCategory.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!cat) { res.status(404).json({ error: "Category not found" }); return; }
        res.json(cat);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.delete("/:id", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        await RecipeCategory.findByIdAndDelete(req.params.id);
        res.json({ message: "Category deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;