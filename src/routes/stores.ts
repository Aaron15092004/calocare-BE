import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import { IUser } from "../models/User";
import Store from "../models/Store";
import PaymentTransaction from "../models/PaymentTransaction";
import User from "../models/User";

const router = Router();

const STORE_PRO_PRICE = 49000;
const STORE_MENU_LIMIT_BASIC = 20;

// GET /api/stores — public list (map / search)
router.get("/", async (req: Request, res: Response) => {
    try {
        const { q, category, city, limit = 50, offset = 0 } = req.query;
        const filter: Record<string, unknown> = { is_active: true };

        if (q) {
            filter.$or = [
                { name: { $regex: q as string, $options: "i" } },
                { description: { $regex: q as string, $options: "i" } },
            ];
        }
        if (category) filter.category = category;
        if (city) filter.city = { $regex: city as string, $options: "i" };

        const stores = await Store.find(filter)
            .select("-menu_items") // exclude menu in list view
            .sort({ subscription_tier: -1, views_count: -1 }) // pro first
            .limit(Number(limit))
            .skip(Number(offset));

        const total = await Store.countDocuments(filter);
        res.json({ data: stores, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/stores/mine — owner's own stores
router.get("/mine", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const stores = await Store.find({ owner_id: user._id }).sort({ created_at: -1 });
        res.json({ data: stores });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/stores/:id — store detail with menu
router.get("/:id", async (req: Request, res: Response) => {
    try {
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        // increment views (fire-and-forget)
        Store.updateOne({ _id: store._id }, { $inc: { views_count: 1 } }).exec();
        res.json(store);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/stores — register new store (any authenticated user)
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { name, description, address, city, phone, website, location, category, images } = req.body;

        if (!name || !address) {
            res.status(400).json({ error: "name and address are required" });
            return;
        }

        const store = await Store.create({
            owner_id: user._id,
            name,
            description,
            address,
            city,
            phone,
            website,
            location,
            category,
            images: images || [],
            subscription_tier: "basic",
            is_verified: false,
            is_active: true,
        });

        res.status(201).json(store);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// PUT /api/stores/:id — owner or admin updates store info
router.put("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (!isAdmin && store.owner_id.toString() !== (user._id as any).toString()) {
            res.status(403).json({ error: "Forbidden" }); return;
        }

        const { name, description, address, city, phone, website, location, category, images } = req.body;
        const updateData: Record<string, unknown> = {};
        if (name) updateData.name = name;
        if (description !== undefined) updateData.description = description;
        if (address) updateData.address = address;
        if (city !== undefined) updateData.city = city;
        if (phone !== undefined) updateData.phone = phone;
        if (website !== undefined) updateData.website = website;
        if (location !== undefined) updateData.location = location;
        if (category) updateData.category = category;
        if (images) updateData.images = images;

        const updated = await Store.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/stores/:id — owner or admin
router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (!isAdmin && store.owner_id.toString() !== (user._id as any).toString()) {
            res.status(403).json({ error: "Forbidden" }); return;
        }
        await Store.findByIdAndUpdate(req.params.id, { is_active: false });
        res.json({ message: "Store deactivated" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── Menu items ─────────────────────────────────────────────────────────────────

// POST /api/stores/:id/menu — add menu item
router.post("/:id/menu", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (store.owner_id.toString() !== (user._id as any).toString()) {
            res.status(403).json({ error: "Forbidden" }); return;
        }

        const isBasic = store.subscription_tier === "basic";
        if (isBasic && store.menu_items.length >= STORE_MENU_LIMIT_BASIC) {
            res.status(403).json({
                error: "menu_limit_reached",
                message: `Basic plan allows max ${STORE_MENU_LIMIT_BASIC} menu items. Upgrade to Store Pro for unlimited.`,
                limit: STORE_MENU_LIMIT_BASIC,
            });
            return;
        }

        const { name_vi, name_en, price, description, image_url, energy_kcal, protein, lipid, glucid, fiber } = req.body;
        store.menu_items.push({ name_vi, name_en, price, description, image_url, energy_kcal, protein, lipid, glucid, fiber, is_available: true });
        await store.save();
        res.json(store);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// PUT /api/stores/:id/menu/:itemId — update menu item
router.put("/:id/menu/:itemId", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (store.owner_id.toString() !== (user._id as any).toString()) {
            res.status(403).json({ error: "Forbidden" }); return;
        }
        const item = store.menu_items.id(req.params.itemId);
        if (!item) { res.status(404).json({ error: "Menu item not found" }); return; }
        Object.assign(item, req.body);
        await store.save();
        res.json(store);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/stores/:id/menu/:itemId — remove menu item
router.delete("/:id/menu/:itemId", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (store.owner_id.toString() !== (user._id as any).toString()) {
            res.status(403).json({ error: "Forbidden" }); return;
        }
        store.menu_items = store.menu_items.filter(
            (item) => item._id?.toString() !== req.params.itemId,
        ) as any;
        await store.save();
        res.json({ message: "Menu item removed" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── Store Pro upgrade ─────────────────────────────────────────────────────────

// POST /api/stores/:id/upgrade — initiate Store Pro payment
router.post("/:id/upgrade", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (store.owner_id.toString() !== (user._id as any).toString()) {
            res.status(403).json({ error: "Forbidden" }); return;
        }

        const { duration_months = 1, payment_method } = req.body;
        const amount = STORE_PRO_PRICE * duration_months;

        const tx = await PaymentTransaction.create({
            user_id: user._id,
            plan_type: "store_pro",
            target_type: "store",
            store_id: store._id,
            duration_months,
            amount,
            final_amount: amount,
            status: "pending",
            payment_method: payment_method || undefined,
        });

        const ref = `STORE${String(tx._id).slice(-8).toUpperCase()}`;
        res.status(201).json({
            transaction_id: tx._id,
            store_id: store._id,
            amount,
            final_amount: amount,
            status: "pending",
            payment_instructions: {
                method: payment_method || "bank_transfer",
                amount: amount.toLocaleString("vi-VN"),
                note: ref,
                message: `Chuyển ${amount.toLocaleString("vi-VN")}₫ với nội dung: ${ref}`,
            },
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/stores/:id/confirm-upgrade — admin confirms store payment
router.post("/:id/confirm-upgrade", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const { tx_id } = req.body;
        const tx = await PaymentTransaction.findById(tx_id);
        if (!tx || tx.plan_type !== "store_pro" || tx.target_type !== "store") {
            res.status(404).json({ error: "Transaction not found" }); return;
        }
        tx.status = "completed";
        tx.payment_ref = req.body.payment_ref || undefined;
        await tx.save();

        const now = new Date();
        const store = await Store.findById(tx.store_id);
        if (store) {
            const currentExpiry = store.subscription_expires_at && store.subscription_expires_at > now
                ? store.subscription_expires_at : now;
            const newExpiry = new Date(currentExpiry);
            newExpiry.setMonth(newExpiry.getMonth() + tx.duration_months);
            store.subscription_tier = "pro";
            store.subscription_expires_at = newExpiry;
            await store.save();
        }

        res.json({ message: "Store Pro activated", store });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/stores/:id/verify — admin verifies store
router.post("/:id/verify", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await Store.findByIdAndUpdate(
            req.params.id,
            { is_verified: true },
            { new: true },
        );
        if (!updated) { res.status(404).json({ error: "Store not found" }); return; }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
