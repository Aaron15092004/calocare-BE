import { Router, Request, Response } from "express";
import multer from "multer";
import { parse } from "csv-parse";
import { authenticate } from "../middleware/auth";
import { requireAdminOrModerator, requireAdmin } from "../middleware/roleCheck";
import { IUser } from "../models/User";
import Food from "../models/Food";
import FoodGroup from "../models/FoodGroup";
import UsdaFood from "../models/UsdaFood";

const WWEIA_EXCLUDE = ["Baby food", "Infant formula", "Alcoholic beverages", "Dietary supplements"];

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// GET /api/foods — list with search/filter
// include_usda=true: supplement with UsdaFood when local results are sparse
router.get("/", async (req: Request, res: Response) => {
    try {
        const { q, food_group_id, is_approved, limit = 50, offset = 0, include_usda } = req.query;
        const filter: Record<string, unknown> = { is_deleted: { $ne: true } };

        if (q) {
            filter.$or = [
                { name_vi: { $regex: q as string, $options: "i" } },
                { name_en: { $regex: q as string, $options: "i" } },
                { search_keywords: { $in: [(q as string).toLowerCase()] } },
            ];
        }
        if (food_group_id) filter.food_group_id = food_group_id;
        if (is_approved !== undefined) filter.is_approved = is_approved === "true";

        const foods = await Food.find(filter)
            .populate("food_group_id", "name_vi name_en code")
            .sort({ sequence_number: 1, name_vi: 1 })
            .limit(Number(limit))
            .skip(Number(offset));

        const total = await Food.countDocuments(filter);

        // USDA fallback: if few local results and caller opts in, supplement from UsdaFood
        let data: unknown[] = foods;
        if (include_usda === "true" && foods.length < 5 && q) {
            const needed = 8 - foods.length;
            const usdaRaw = await UsdaFood.find({
                $or: [
                    { description_vi: { $regex: q as string, $options: "i" } },
                    { description_en: { $regex: q as string, $options: "i" } },
                ],
            })
                .select("description_vi description_en energy_kcal protein lipid glucid fiber fdc_id wweia_category")
                .limit(needed + 5)
                .lean();

            const usdaItems = usdaRaw
                .filter((u) => !u.wweia_category || !WWEIA_EXCLUDE.some((p) => u.wweia_category!.startsWith(p)))
                .slice(0, needed)
                .map((u) => ({
                    _id: u._id,
                    name_vi: u.description_vi || u.description_en,
                    name_en: u.description_en,
                    energy_kcal: u.energy_kcal,
                    protein: u.protein,
                    lipid: u.lipid,
                    glucid: u.glucid,
                    fiber: u.fiber,
                    fdc_id: u.fdc_id,
                    source_type: "usda",
                }));

            data = [...foods, ...usdaItems];
        }

        res.json({ data, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/foods/:id
router.get("/:id", async (req: Request, res: Response) => {
    try {
        const food = await Food.findById(req.params.id).populate("food_group_id", "name_vi name_en");
        if (!food) {
            res.status(404).json({ error: "Food not found" });
            return;
        }
        res.json(food);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/foods — any authenticated user (admin auto-approved, users pending review)
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const food = await Food.create({
            ...req.body,
            creator_id: user._id,
            is_approved: isAdmin ? (req.body.is_approved ?? false) : false,
        });
        res.status(201).json(food);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/foods/mine — foods created by current user
router.get("/mine", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const foods = await Food.find({ creator_id: user._id, is_deleted: { $ne: true } })
            .sort({ created_at: -1 });
        res.json({ data: foods, total: foods.length });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/foods/:id/submit — submit for community review
router.post("/:id/submit", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const food = await Food.findById(req.params.id);
        if (!food) { res.status(404).json({ error: "Food not found" }); return; }
        const isOwner = food.creator_id?.toString() === (user._id as any).toString();
        if (!isOwner) { res.status(403).json({ error: "Forbidden" }); return; }
        const updated = await Food.findByIdAndUpdate(
            req.params.id,
            { is_approved: false }, // pending approval
            { new: true },
        );
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/foods/:id/approve — admin only
router.post("/:id/approve", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await Food.findByIdAndUpdate(
            req.params.id,
            { is_approved: true },
            { new: true },
        );
        if (!updated) { res.status(404).json({ error: "Food not found" }); return; }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/foods/:id/reject — admin only
router.post("/:id/reject", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await Food.findByIdAndUpdate(
            req.params.id,
            { is_approved: false, is_deleted: true },
            { new: true },
        );
        if (!updated) { res.status(404).json({ error: "Food not found" }); return; }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/foods/import-csv
// Accepts multipart CSV, upserts by `code` field.
// food_group_id in CSV is a legacy integer → matched against FoodGroup.code.
router.post(
    "/import-csv",
    authenticate,
    requireAdminOrModerator,
    upload.single("file"),
    async (req: Request, res: Response) => {
        if (!req.file) {
            res.status(400).json({ error: "No CSV file uploaded" });
            return;
        }

        try {
            // Build FoodGroup code→ObjectId map once
            const allGroups = await FoodGroup.find({}, { code: 1 });
            const groupMap = new Map<number, string>();
            for (const g of allGroups) {
                if (g.code != null) groupMap.set(g.code, String(g._id));
            }

            // Parse CSV from buffer
            const rows = await new Promise<Record<string, string>[]>((resolve, reject) => {
                parse(req.file!.buffer, {
                    columns: true,
                    skip_empty_lines: true,
                    trim: true,
                    bom: true,
                }, (err, records: Record<string, string>[]) => (err ? reject(err) : resolve(records)));
            });

            let imported = 0;
            let updated = 0;
            const errors: { row: number; code: string; error: string }[] = [];

            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                try {
                    const csvCode = r.code?.trim();
                    if (!csvCode || !r.name_vi?.trim()) continue;

                    // Parse JSON fields safely
                    let search_keywords: string[] = [];
                    try { search_keywords = JSON.parse(r.search_keywords || "[]"); } catch {}

                    let nutrients_extended: Record<string, unknown> | undefined;
                    try { nutrients_extended = r.nutrients_extended ? JSON.parse(r.nutrients_extended) : undefined; } catch {}

                    const groupCode = parseInt(r.food_group_id, 10);
                    const food_group_id = groupMap.get(groupCode) || undefined;

                    const doc = {
                        code: csvCode,
                        name_vi: r.name_vi.trim(),
                        name_en: r.name_en?.trim() || undefined,
                        food_group_id,
                        sequence_number: r.sequence_number ? parseInt(r.sequence_number, 10) : undefined,
                        waste_percentage: r.waste_percentage ? parseFloat(r.waste_percentage) : 0,
                        water: r.water ? parseFloat(r.water) : undefined,
                        energy_kcal: r.energy_kcal ? parseFloat(r.energy_kcal) : 0,
                        protein: r.protein ? parseFloat(r.protein) : 0,
                        lipid: r.lipid ? parseFloat(r.lipid) : 0,
                        glucid: r.glucid ? parseFloat(r.glucid) : 0,
                        fiber: r.fiber ? parseFloat(r.fiber) : undefined,
                        ash: r.ash ? parseFloat(r.ash) : undefined,
                        nutrients_extended,
                        search_keywords,
                        source_reference: r.source_reference?.trim() || undefined,
                        notes: r.notes?.trim() || undefined,
                        is_approved: r.is_approved === "true" || r.is_approved === "1",
                        image_url: r.image_url?.trim() || undefined,
                    };

                    const existing = await Food.findOne({ code: csvCode });
                    if (existing) {
                        await Food.updateOne({ _id: existing._id }, { $set: doc });
                        updated++;
                    } else {
                        await Food.create(doc);
                        imported++;
                    }
                } catch (err) {
                    errors.push({ row: i + 2, code: r.code || "?", error: (err as Error).message });
                }
            }

            res.json({
                total: rows.length,
                imported,
                updated,
                errors,
                message: `Import complete: ${imported} new, ${updated} updated, ${errors.length} errors`,
            });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    },
);

// PUT /api/foods/:id — creator or admin
router.put("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const food = await Food.findById(req.params.id);
        if (!food) { res.status(404).json({ error: "Food not found" }); return; }
        const isOwner = food.creator_id?.toString() === (user._id as any).toString();
        if (!isAdmin && !isOwner) { res.status(403).json({ error: "Forbidden" }); return; }

        const updateData = { ...req.body };
        if (!isAdmin) {
            delete updateData.is_approved;
        }
        const updated = await Food.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/foods/:id  (soft delete) — creator or admin
router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const food = await Food.findById(req.params.id);
        if (!food) { res.status(404).json({ error: "Food not found" }); return; }
        const isOwner = food.creator_id?.toString() === (user._id as any).toString();
        if (!isAdmin && !isOwner) { res.status(403).json({ error: "Forbidden" }); return; }
        await Food.findByIdAndUpdate(req.params.id, { is_deleted: true });
        res.json({ message: "Food deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
