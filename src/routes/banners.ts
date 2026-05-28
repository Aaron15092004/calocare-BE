import { Router, Request, Response } from "express";
import Banner from "../models/Banner";

const router = Router();

// GET /api/banners — public, only active banners ordered by sort_order
router.get("/", async (_req: Request, res: Response) => {
    try {
        const banners = await Banner.find({ is_active: true }).sort({ sort_order: 1, created_at: -1 });
        res.json(banners);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

export default router;
