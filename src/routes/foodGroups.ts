import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import FoodGroup from "../models/FoodGroup";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
    try {
        const groups = await FoodGroup.find().sort({ name_vi: 1 });
        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const group = await FoodGroup.create(req.body);
        res.status(201).json(group);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.put("/:id", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const group = await FoodGroup.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!group) { res.status(404).json({ error: "Group not found" }); return; }
        res.json(group);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.delete("/:id", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        await FoodGroup.findByIdAndDelete(req.params.id);
        res.json({ message: "Group deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;