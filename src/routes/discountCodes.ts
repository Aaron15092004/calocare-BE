import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import DiscountCode from "../models/DiscountCode";

const router = Router();

router.get("/", authenticate, requireAdmin, async (_req: Request, res: Response) => {
    try {
        const codes = await DiscountCode.find().sort({ created_at: -1 });
        res.json(codes);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/validate", authenticate, async (req: Request, res: Response) => {
    try {
        const { code, amount } = req.body;
        const discount = await DiscountCode.findOne({ code: code?.toUpperCase(), is_active: true });
        if (!discount) {
            res.status(404).json({ error: "Invalid or inactive discount code" });
            return;
        }
        const now = new Date();
        if (discount.starts_at && discount.starts_at > now) {
            res.status(400).json({ error: "Discount code not yet active" });
            return;
        }
        if (discount.expires_at && discount.expires_at < now) {
            res.status(400).json({ error: "Discount code expired" });
            return;
        }
        if (discount.max_uses && discount.used_count >= discount.max_uses) {
            res.status(400).json({ error: "Discount code usage limit reached" });
            return;
        }
        if (discount.min_purchase && amount < discount.min_purchase) {
            res.status(400).json({ error: `Minimum purchase amount: ${discount.min_purchase}` });
            return;
        }

        const discountAmount =
            discount.discount_type === "percentage"
                ? (amount * discount.discount_value) / 100
                : discount.discount_value;

        res.json({ valid: true, discount_amount: discountAmount, discount });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const code = await DiscountCode.create(req.body);
        res.status(201).json(code);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.put("/:id", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const code = await DiscountCode.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!code) { res.status(404).json({ error: "Code not found" }); return; }
        res.json(code);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.delete("/:id", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        await DiscountCode.findByIdAndDelete(req.params.id);
        res.json({ message: "Discount code deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;