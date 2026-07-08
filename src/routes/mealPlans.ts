import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import MealPlan from "../models/MealPlan";
import MealPlanItem from "../models/MealPlanItem";
import UserMealPlan from "../models/UserMealPlan";
import { IUser } from "../models/User";

// NOTE: the old blocking POST /generate (direct Gemini call, separate quota) was
// removed — the SSE endpoint POST /api/rag/generate-meal-plan is the single
// generation path used by both clients.

const router = Router();

// GET /api/meal-plans — list plans (supports ?mine=true, ?community=true, ?pending=true)
router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { mine, community, pending, goal_type, q, limit = 50, offset = 0 } = req.query;
        const filter: Record<string, unknown> = {};

        if (mine === "true") {
            filter.creator_id = user._id;
        } else if (community === "true") {
            filter.is_public = true;
            filter.is_approved = true;
        } else if (pending === "true") {
            filter.is_public = true;
            filter.is_approved = false;
        } else {
            const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
            if (!isAdmin) {
                filter.$or = [
                    { creator_id: user._id },
                    { is_public: true, is_approved: true },
                ];
            } else {
                // Admin sees own plans + submitted plans (is_public). Never other users' private drafts.
                filter.$or = [
                    { creator_id: user._id },
                    { is_public: true },
                ];
            }
        }

        if (goal_type) filter.goal_type = goal_type;
        // Server-side text search so community browsing doesn't rely on a
        // client-side filter over a capped page
        if (typeof q === "string" && q.trim()) {
            const regex = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            filter.$and = [{ $or: [{ title: regex }, { description: regex }, { tags: regex }] }];
        }
        // Hide in-flight/failed generations (legacy docs have no status field and pass)
        filter.status = { $nin: ["generating", "failed"] };

        const plans = await MealPlan.find(filter)
            .sort({ created_at: -1 })
            .limit(Math.min(Number(limit) || 50, 100))
            .skip(Number(offset) || 0);

        const total = await MealPlan.countDocuments(filter);
        res.json({ data: plans, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/meal-plans/mine/recovery — most recent AI-generated plan (last 24h)
// not yet linked to a UserMealPlan, so a client that disconnected mid-generation
// can find it again. Registered before /:id so the path isn't shadowed.
router.get("/mine/recovery", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const since = new Date(Date.now() - 24 * 3600 * 1000);
        // Only plans with an explicit status (new generator) — legacy drafts stay out
        const plan = await MealPlan.findOne({
            creator_id: user._id,
            created_at: { $gte: since },
            status: { $in: ["generating", "partial", "completed"] },
        })
            .sort({ created_at: -1 })
            .lean();

        if (!plan) {
            res.json({ plan: null });
            return;
        }
        const linked = await UserMealPlan.findOne({ user_id: user._id, meal_plan_id: plan._id }).lean();
        if (linked) {
            res.json({ plan: null });
            return;
        }
        res.json({
            plan: {
                _id: plan._id,
                title: plan.title,
                status: plan.status,
                generated_days: plan.generated_days ?? 0,
                total_days: plan.total_days,
                goal_type: plan.goal_type,
                generation_error: plan.generation_error,
                created_at: plan.created_at,
            },
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/meal-plans/templates — predefined template plans (MP-08)
// Registered BEFORE /:id — it used to be shadowed by the param route and 500'd.
router.get("/templates", authenticate, async (_req: Request, res: Response) => {
    try {
        const templates = await MealPlan.find({
            is_public: true,
            is_approved: true,
            tags: { $in: ["template"] },
        })
            .select("title description total_days goal_type tags")
            .sort({ title: 1 })
            .limit(20)
            .lean();

        // Group by goal_type
        const grouped: Record<string, typeof templates> = {};
        for (const t of templates) {
            const key = t.goal_type ?? "other";
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(t);
        }

        res.json({ templates, grouped });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// Visibility: private plans are readable only by their creator, someone who has
// the plan linked (cloned/activated before it was unpublished), or staff.
async function canViewPlan(user: IUser, plan: { _id: unknown; creator_id?: { toString(): string } | null; is_public: boolean; is_approved: boolean }): Promise<boolean> {
    const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
    if (isAdmin) return true;
    if (plan.creator_id?.toString() === (user._id as { toString(): string }).toString()) return true;
    if (plan.is_public && plan.is_approved) return true;
    const linked = await UserMealPlan.findOne({ user_id: user._id, meal_plan_id: plan._id }).lean();
    return linked !== null;
}

// GET /api/meal-plans/:id
router.get("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const plan = await MealPlan.findById(req.params.id);
        if (!plan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }
        if (!(await canViewPlan(user, plan))) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        const items = await MealPlanItem.find({ meal_plan_id: plan._id })
            .populate("recipe_id", "name_vi name_en calories protein carbs fat fiber description instructions image_url")
            .populate("food_id", "name_vi name_en energy_kcal protein lipid glucid fiber image_url")
            .populate("usda_food_id", "description_vi description_en energy_kcal protein lipid glucid fiber")
            .sort({ day_number: 1, sort_order: 1 });

        res.json({ ...plan.toObject(), items });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/meal-plans — any authenticated user can create
router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { items, ...planData } = req.body;

        // Non-admin plans start as private and unapproved
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const plan = await MealPlan.create({
            ...planData,
            creator_id: user._id,
            is_public: isAdmin ? (planData.is_public ?? false) : false,
            is_approved: isAdmin ? (planData.is_approved ?? false) : false,
        });

        if (items?.length) {
            await MealPlanItem.insertMany(
                items.map((item: Record<string, unknown>) => ({
                    ...item,
                    meal_plan_id: plan._id,
                })),
            );
        }

        res.status(201).json(plan);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// PUT /api/meal-plans/:id — creator or admin can update
router.put("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const plan = await MealPlan.findById(req.params.id);
        if (!plan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }

        const isOwner = plan.creator_id?.toString() === (user._id as any).toString();
        if (!isAdmin && !isOwner) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }

        const { items, ...planData } = req.body;

        // Non-admin cannot change approval status
        if (!isAdmin) {
            delete planData.is_approved;
            delete planData.is_public;
        }

        const updated = await MealPlan.findByIdAndUpdate(req.params.id, planData, { new: true });

        if (items !== undefined) {
            await MealPlanItem.deleteMany({ meal_plan_id: plan._id });
            if (items.length) {
                await MealPlanItem.insertMany(
                    items.map((item: Record<string, unknown>) => ({
                        ...item,
                        meal_plan_id: plan._id,
                    })),
                );
            }
        }

        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/meal-plans/:id — creator or admin can delete
router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
        const plan = await MealPlan.findById(req.params.id);
        if (!plan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }

        const isOwner = plan.creator_id?.toString() === (user._id as any).toString();
        if (!isAdmin && !isOwner) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }

        await MealPlan.findByIdAndDelete(req.params.id);
        await MealPlanItem.deleteMany({ meal_plan_id: plan._id });
        res.json({ message: "Meal plan deleted" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/meal-plans/:id/submit — user submits their plan for community review
router.post("/:id/submit", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const plan = await MealPlan.findById(req.params.id);
        if (!plan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }

        const isOwner = plan.creator_id?.toString() === (user._id as any).toString();
        if (!isOwner) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }

        const updated = await MealPlan.findByIdAndUpdate(
            req.params.id,
            { is_public: true, is_approved: false },
            { new: true },
        );
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/meal-plans/:id/approve — admin approves a submitted plan
router.post("/:id/approve", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await MealPlan.findByIdAndUpdate(
            req.params.id,
            { is_approved: true, is_public: true },
            { new: true },
        );
        if (!updated) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/meal-plans/:id/reject — admin rejects a submitted plan
router.post("/:id/reject", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await MealPlan.findByIdAndUpdate(
            req.params.id,
            { is_approved: false, is_public: false },
            { new: true },
        );
        if (!updated) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/meal-plans/:id/activate — unified activation used by all client
// entry points (own AI/manual plans AND community plans). Deactivates the
// previous active plan and links this one. Supersedes POST /user-meal-plans
// and /:id/clone, which stay for older mobile builds.
router.post("/:id/activate", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const plan = await MealPlan.findById(req.params.id);
        if (!plan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }
        if (!(await canViewPlan(user, plan))) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        if ((plan.status ?? "completed") === "generating") {
            res.status(409).json({ error: "plan_generating", message: "Thực đơn đang được tạo, vui lòng chờ hoàn tất." });
            return;
        }

        await UserMealPlan.updateMany({ user_id: user._id, is_active: true }, { is_active: false });
        const userPlan = await UserMealPlan.create({
            user_id: user._id,
            meal_plan_id: plan._id,
            start_date: new Date(),
            is_active: true,
        });

        res.status(201).json({
            user_meal_plan_id: userPlan._id,
            meal_plan_id: plan._id,
            start_date: userPlan.start_date,
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/meal-plans/:id/clone — user clones an approved community plan as their active plan
router.post("/:id/clone", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const sourcePlan = await MealPlan.findById(req.params.id);
        if (!sourcePlan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }
        if (!sourcePlan.is_approved || !sourcePlan.is_public) {
            res.status(403).json({ error: "Plan is not available for cloning" });
            return;
        }

        // Deactivate existing active plans
        await UserMealPlan.updateMany({ user_id: user._id, is_active: true }, { is_active: false });

        const userPlan = await UserMealPlan.create({
            user_id: user._id,
            meal_plan_id: sourcePlan._id,
            start_date: new Date(),
            is_active: true,
        });

        res.status(201).json(userPlan);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/meal-plans/:id/duplicate — copy own plan to a new editable draft (MP-07)
router.post("/:id/duplicate", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const source = await MealPlan.findById(req.params.id);
        if (!source) { res.status(404).json({ error: "Meal plan not found" }); return; }

        // Only allow duplicating own plans or public approved plans
        const isOwn = source.creator_id?.toString() === (user._id as { toString(): string }).toString();
        if (!isOwn && !(source.is_public && source.is_approved)) {
            res.status(403).json({ error: "Not allowed" });
            return;
        }

        const copy = await MealPlan.create({
            title: `${source.title} (bản sao)`,
            description: source.description,
            total_days: source.total_days,
            goal_type: source.goal_type,
            tags: source.tags,
            is_public: false,
            is_approved: false,
            creator_id: user._id,
        });

        // Deep-copy all items
        const items = await MealPlanItem.find({ meal_plan_id: source._id }).lean();
        if (items.length) {
            await MealPlanItem.insertMany(
                items.map(({ _id: _omit, ...item }) => ({ ...item, meal_plan_id: copy._id })),
            );
        }

        res.status(201).json({ id: copy._id, title: copy.title });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/meal-plans/:id/shopping-list — generate ingredients list from meal plan items (MP-09)
router.get("/:id/shopping-list", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const plan = await MealPlan.findById(req.params.id);
        if (!plan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }
        if (!(await canViewPlan(user, plan))) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        const items = await MealPlanItem.find({ meal_plan_id: req.params.id })
            .populate("food_id", "name_vi")
            .populate("recipe_id", "name_vi ingredients")
            .lean();

        if (!items.length) { res.json({ items: [] }); return; }

        const ingredientMap: Map<string, { name: string; sources: string[] }> = new Map();

        for (const item of items) {
            // From custom_food
            if (item.custom_food) {
                const key = item.custom_food.name.toLowerCase();
                if (!ingredientMap.has(key)) {
                    ingredientMap.set(key, { name: item.custom_food.name, sources: [] });
                }
                ingredientMap.get(key)!.sources.push(`Ngày ${item.day_number}`);
            }
            // From food_id
            const food = item.food_id as { name_vi?: string } | null;
            if (food?.name_vi) {
                const key = food.name_vi.toLowerCase();
                if (!ingredientMap.has(key)) {
                    ingredientMap.set(key, { name: food.name_vi, sources: [] });
                }
                ingredientMap.get(key)!.sources.push(`Ngày ${item.day_number}`);
            }
            // From recipe ingredients
            const recipe = item.recipe_id as { name_vi?: string; ingredients?: { name: string }[] } | null;
            if (recipe?.ingredients?.length) {
                for (const ing of recipe.ingredients) {
                    if (!ing.name) continue;
                    const key = ing.name.toLowerCase();
                    if (!ingredientMap.has(key)) {
                        ingredientMap.set(key, { name: ing.name, sources: [] });
                    }
                    ingredientMap.get(key)!.sources.push(recipe.name_vi ?? `Ngày ${item.day_number}`);
                }
            }
        }

        const list = Array.from(ingredientMap.values())
            .sort((a, b) => a.name.localeCompare(b.name, "vi"));

        res.json({ items: list, total: list.length });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});


export default router;
