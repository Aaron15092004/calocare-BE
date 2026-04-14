import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAdmin, requireAdminOrModerator } from "../../middleware/roleCheck";
import User from "../../models/User";

const router = Router();

// GET /api/admin/users
router.get("/", authenticate, requireAdminOrModerator, async (req: Request, res: Response) => {
    try {
        const { q, role, subscription_tier, is_banned, limit = 50, offset = 0 } = req.query;
        const filter: Record<string, unknown> = {};

        if (q) {
            filter.$or = [
                { email: { $regex: q as string, $options: "i" } },
                { display_name: { $regex: q as string, $options: "i" } },
            ];
        }
        if (role) filter.role = role;
        if (subscription_tier) filter.subscription_tier = subscription_tier;
        if (is_banned !== undefined) filter.is_banned = is_banned === "true";

        const users = await User.find(filter)
            .sort({ created_at: -1 })
            .limit(Number(limit))
            .skip(Number(offset))
            .select("-password -refresh_tokens");

        const total = await User.countDocuments(filter);
        res.json({ data: users, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// PUT /api/admin/users/:id — update role, ban, subscription
router.put("/:id", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const { role, is_banned, subscription_tier, subscription_expires_at } = req.body;
        const updated = await User.findByIdAndUpdate(
            req.params.id,
            {
                ...(role !== undefined && { role }),
                ...(is_banned !== undefined && { is_banned }),
                ...(subscription_tier !== undefined && { subscription_tier }),
                ...(subscription_expires_at !== undefined && { subscription_expires_at }),
            },
            { new: true },
        ).select("-password -refresh_tokens");

        if (!updated) {
            res.status(404).json({ error: "User not found" });
            return;
        }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/admin/users/:id
router.delete("/:id", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: "User deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;