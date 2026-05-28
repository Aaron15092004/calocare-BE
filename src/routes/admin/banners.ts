import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAdminOrModerator } from "../../middleware/roleCheck";
import Banner from "../../models/Banner";

const router = Router();

// GET /api/admin/banners
router.get("/", authenticate, requireAdminOrModerator, async (_req: Request, res: Response) => {
    try {
        const banners = await Banner.find().sort({ sort_order: 1, created_at: -1 });
        res.json(banners);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// POST /api/admin/banners
router.post("/", authenticate, requireAdminOrModerator, async (req: Request, res: Response) => {
    try {
        const banner = await Banner.create(req.body);
        res.status(201).json(banner);
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    }
});

// PUT /api/admin/banners/:id
router.put("/:id", authenticate, requireAdminOrModerator, async (req: Request, res: Response) => {
    try {
        const banner = await Banner.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!banner) return res.status(404).json({ error: "Banner not found" });
        res.json(banner);
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    }
});

// DELETE /api/admin/banners/:id
router.delete("/:id", authenticate, requireAdminOrModerator, async (req: Request, res: Response) => {
    try {
        await Banner.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

export default router;
