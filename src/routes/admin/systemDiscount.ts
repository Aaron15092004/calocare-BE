import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAdmin } from "../../middleware/roleCheck";
import SystemSettings from "../../models/SystemSettings";
import { IUser } from "../../models/User";

const router = Router();

async function getSettings() {
    let doc = await SystemSettings.findOne({ key: "global" });
    if (!doc) {
        doc = await SystemSettings.create({ key: "global", global_discount_pct: 0, global_discount_expires: null });
    }
    return doc;
}

/**
 * GET /api/admin/system-discount
 * Returns current global discount settings.
 * Also exposed publicly so the subscription page can show the banner.
 */
router.get("/", authenticate, async (_req: Request, res: Response) => {
    try {
        const doc = await getSettings();
        const now = new Date();
        const isActive =
            doc.global_discount_pct > 0 &&
            (!doc.global_discount_expires || doc.global_discount_expires > now);

        res.json({
            discount_pct: isActive ? doc.global_discount_pct : 0,
            expires_at: doc.global_discount_expires,
            is_active: isActive,
            applicable_plans: doc.applicable_plans || [],
        });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

/**
 * PUT /api/admin/system-discount
 * Set or update the global discount. Admin only.
 * Body: { discount_pct: number (0-100), expires_at?: ISO string | null }
 */
router.put("/", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { discount_pct, expires_at, applicable_plans } = req.body;

        const pct = Number(discount_pct);
        if (isNaN(pct) || pct < 0 || pct > 100) {
            res.status(400).json({ error: "discount_pct must be between 0 and 100" });
            return;
        }

        const expiry = expires_at ? new Date(expires_at) : null;
        const plans = Array.isArray(applicable_plans) ? applicable_plans : [];

        const doc = await SystemSettings.findOneAndUpdate(
            { key: "global" },
            {
                $set: {
                    global_discount_pct: pct,
                    global_discount_expires: expiry,
                    applicable_plans: plans,
                    updated_by: (user._id as { toString(): string }).toString(),
                    updated_at: new Date(),
                },
            },
            { upsert: true, new: true },
        );

        res.json({
            discount_pct: doc.global_discount_pct,
            expires_at: doc.global_discount_expires,
            is_active: pct > 0,
            applicable_plans: doc.applicable_plans || [],
        });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

/**
 * DELETE /api/admin/system-discount
 * Remove the global discount (set to 0). Admin only.
 */
router.delete("/", authenticate, requireAdmin, async (_req: Request, res: Response) => {
    try {
        await SystemSettings.findOneAndUpdate(
            { key: "global" },
            { $set: { global_discount_pct: 0, global_discount_expires: null, updated_at: new Date() } },
            { upsert: true },
        );
        res.json({ discount_pct: 0, is_active: false });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

export default router;
