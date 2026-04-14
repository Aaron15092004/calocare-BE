import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import MealPlan from "../models/MealPlan";
import MealPlanItem from "../models/MealPlanItem";
import UserMealPlan from "../models/UserMealPlan";
import { IUser } from "../models/User";

const router = Router();

// GET /api/meal-plans — list plans (supports ?mine=true, ?community=true, ?pending=true)
router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { mine, community, pending, goal_type, limit = 50, offset = 0 } = req.query;
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
            // Admin: show all; otherwise show own + approved community
            const isAdmin = (user as any).role === "admin" || (user as any).role === "moderator";
            if (!isAdmin) {
                filter.$or = [
                    { creator_id: user._id },
                    { is_public: true, is_approved: true },
                ];
            }
        }

        if (goal_type) filter.goal_type = goal_type;

        const plans = await MealPlan.find(filter)
            .sort({ created_at: -1 })
            .limit(Number(limit))
            .skip(Number(offset));

        const total = await MealPlan.countDocuments(filter);
        res.json({ data: plans, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/meal-plans/:id
router.get("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const plan = await MealPlan.findById(req.params.id);
        if (!plan) {
            res.status(404).json({ error: "Meal plan not found" });
            return;
        }
        const items = await MealPlanItem.find({ meal_plan_id: plan._id })
            .populate("recipe_id", "name_vi name_en calories image_url")
            .populate("food_id", "name_vi name_en energy_kcal")
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

export default router;
