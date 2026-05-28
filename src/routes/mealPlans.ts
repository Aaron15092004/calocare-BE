import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import MealPlan from "../models/MealPlan";
import MealPlanItem from "../models/MealPlanItem";
import UserMealPlan from "../models/UserMealPlan";
import Recipe from "../models/Recipe";
import User, { IUser } from "../models/User";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_BASE  = "https://generativelanguage.googleapis.com/v1beta/models";

function cleanJson(raw: string): string {
    let s = raw.trim();
    if (s.startsWith("```json")) s = s.slice(7);
    if (s.startsWith("```"))     s = s.slice(3);
    if (s.endsWith("```"))       s = s.slice(0, -3);
    return s.trim();
}

async function callGemini(apiKey: string, body: object): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
        const res = await fetch(
            `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
                body: JSON.stringify(body),
                signal: controller.signal,
            },
        );
        if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
        const data = (await res.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    } finally {
        clearTimeout(timer);
    }
}

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
            .populate("recipe_id", "name_vi name_en calories protein carbs fat fiber description instructions image_url")
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

// GET /api/meal-plans/templates — predefined template plans (MP-08)
// Returns approved public plans tagged as templates, grouped by goal
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

// GET /api/meal-plans/:id/shopping-list — generate ingredients list from meal plan items (MP-09)
router.get("/:id/shopping-list", authenticate, async (req: Request, res: Response) => {
    try {
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

// POST /api/meal-plans/generate — CaloCare AI personalized meal plan (Premium = 7d, Pro = 21d)
router.post("/generate", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const tier: string = (user as any).subscription_tier ?? "free";

        if (tier === "free") {
            res.status(403).json({ error: "Tính năng này yêu cầu gói Premium hoặc Pro." });
            return;
        }

        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        if (!GEMINI_API_KEY) {
            res.status(500).json({ error: "AI chưa được cấu hình." });
            return;
        }

        const totalDays = tier === "pro" ? 21 : 7;

        const fullUser = await User.findById(user._id);
        const prefs    = (fullUser?.preferences as Record<string, unknown>) ?? {};
        const goals    = (fullUser?.daily_nutrition_goals ?? {}) as Record<string, unknown>;

        const age      = (prefs.age as number) || 25;
        const gender   = (prefs.gender as string) === "female" ? "Nữ" : "Nam";
        const weight   = (prefs.weight_kg as number) || 60;
        const height   = (prefs.height_cm as number) || 165;
        const activityMap: Record<string, string> = {
            sedentary:  "Ít vận động",
            light:      "Nhẹ (1–2 ngày/tuần)",
            moderate:   "Vừa (3–5 ngày/tuần)",
            active:     "Nhiều (6–7 ngày/tuần)",
            veryActive: "Rất nhiều (cường độ cao hàng ngày)",
        };
        const activity = activityMap[(prefs.activity_level as string) ?? ""] ?? "Vừa phải";
        const targetCal = (goals.calories as number) || 2000;

        const {
            diet_type = "omnivore",
            foods_to_avoid = "",
            cuisine = "mixed",
            goal_type = "health",
            cheat_day = false,
            specific_foods = "",
            custom_calories,
        } = req.body;

        // Allow user to override their profile calorie goal
        const effectiveCalories = custom_calories ? Number(custom_calories) : targetCal;

        const dietLabel: Record<string, string> = {
            omnivore:   "Ăn đa dạng (cả thịt và rau)",
            vegetarian: "Ăn chay có trứng/sữa",
            vegan:      "Ăn thuần chay",
        };
        const cuisineLabel: Record<string, string> = {
            vietnamese:    "Ưu tiên món Việt",
            international: "Ưu tiên món quốc tế",
            mixed:         "Kết hợp Việt và quốc tế",
        };
        const goalLabel: Record<string, string> = {
            weight_loss: "Giảm cân",
            muscle_gain: "Tăng cơ / Tăng cân",
            maintain:    "Duy trì cân nặng",
            health:      "Ăn uống lành mạnh",
        };

        const cheatDayNote = cheat_day
            ? `\nCheat day: Cho phép 1 ngày ăn tự do (thứ Bảy hoặc Chủ Nhật) — ngày đó không giới hạn món, nhưng vẫn ghi nhận calories. Đánh dấu ngày đó bằng description "🎉 Cheat day".`
            : "";
        const specificFoodsNote = specific_foods
            ? `\nYêu cầu thực phẩm cụ thể: ${specific_foods} — phải xuất hiện ít nhất 1 lần trong thực đơn.`
            : "";

        const prompt = `Bạn là CaloCare AI – chuyên gia dinh dưỡng thông minh. Hãy tạo thực đơn cá nhân hóa ${totalDays} ngày CHI TIẾT cho người dùng sau:

Hồ sơ: Tuổi ${age}, ${gender}, ${weight}kg, cao ${height}cm, hoạt động: ${activity}
Mục tiêu: ${goalLabel[goal_type] || "Ăn uống lành mạnh"} · ${effectiveCalories} kcal/ngày
Chế độ ăn: ${dietLabel[diet_type] || dietLabel["omnivore"]}
Ẩm thực: ${cuisineLabel[cuisine] || cuisineLabel["mixed"]}
${foods_to_avoid ? `Tránh: ${foods_to_avoid}` : ""}${cheatDayNote}${specificFoodsNote}

QUY TẮC BẮT BUỘC:
1. Mỗi ngày: breakfast + lunch + dinner + snack (4 bữa)
2. Tổng calo/ngày ≈ ${effectiveCalories} kcal (±150 chấp nhận được)
3. Macro: Protein 25-35%, Carbs 40-50%, Fat 20-30%
4. Không lặp cùng món quá 2 lần trong ${totalDays} ngày
5. Nguyên liệu dễ mua ở Việt Nam
6. Mỗi món PHẢI có: danh sách nguyên liệu (3-7 nguyên liệu) VÀ hướng dẫn nấu (3-5 bước)

Trả lời CHỈ bằng JSON hợp lệ:
{
  "title": "Tên thực đơn ngắn gọn",
  "description": "Mô tả 1-2 câu về thực đơn và lợi ích",
  "goal_type": "${goal_type}",
  "days": [
    {
      "day_number": 1,
      "meals": [
        {
          "meal_type": "breakfast",
          "name": "Tên món ăn",
          "description": "Mô tả ngắn 1 câu",
          "calories_kcal": 380,
          "protein_g": 18,
          "carbs_g": 48,
          "fat_g": 10,
          "fiber_g": 4,
          "serving_description": "1 tô (350g)",
          "ingredients": [
            { "name": "Tên nguyên liệu", "amount": "80g", "kcal": 280 }
          ],
          "steps": [
            "Bước 1: mô tả cụ thể.",
            "Bước 2: mô tả cụ thể."
          ]
        }
      ]
    }
  ]
}`;

        const raw = await callGemini(GEMINI_API_KEY, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.35, maxOutputTokens: 16384 },
        });

        type AIMeal = {
            meal_type: string;
            name: string;
            description?: string;
            calories_kcal: number;
            protein_g: number;
            carbs_g: number;
            fat_g: number;
            fiber_g?: number;
            serving_description?: string;
            ingredients?: { name: string; amount: string; kcal: number }[];
            steps?: string[];
        };
        type AIDay = { day_number: number; meals: AIMeal[] };
        let parsed: { title: string; description: string; goal_type: string; days: AIDay[] };

        try {
            parsed = JSON.parse(cleanJson(raw));
        } catch {
            res.status(500).json({ error: "AI trả về định dạng không hợp lệ, vui lòng thử lại." });
            return;
        }

        if (!parsed.days || !Array.isArray(parsed.days) || parsed.days.length === 0) {
            res.status(500).json({ error: "AI không tạo được thực đơn hợp lệ, vui lòng thử lại." });
            return;
        }

        // Create MealPlan header
        const plan = await MealPlan.create({
            title:       parsed.title || `Thực đơn ${totalDays} ngày cá nhân hóa`,
            description: parsed.description || "",
            total_days:  totalDays,
            goal_type:   parsed.goal_type || goal_type,
            tags:        ["AI", "CaloCare AI", tier === "pro" ? "21 ngày" : "7 ngày"],
            creator_id:  user._id,
            is_public:   false,
            is_approved: false,
        });

        // Batch-create Recipe records for all AI-generated meals
        type RecipeEntry = { day: number; meal_type: string; sort_order: number };
        const recipeEntries: RecipeEntry[] = [];
        const recipeInputs: object[] = [];
        let sortOrder = 0;

        for (const day of parsed.days) {
            if (!Array.isArray(day.meals)) continue;
            for (const meal of day.meals) {
                recipeEntries.push({ day: day.day_number, meal_type: meal.meal_type, sort_order: sortOrder++ });
                recipeInputs.push({
                    name_vi:           meal.name,
                    description:       meal.description || "",
                    calories:          Number(meal.calories_kcal) || 0,
                    protein:           Number(meal.protein_g) || 0,
                    carbs:             Number(meal.carbs_g) || 0,
                    fat:               Number(meal.fat_g) || 0,
                    fiber:             Number(meal.fiber_g) || 0,
                    servings:          1,
                    meal_type:         meal.meal_type as "breakfast" | "lunch" | "dinner" | "snack",
                    cuisine_type:      cuisine,
                    tags:              ["AI", "cá nhân hóa"],
                    is_public:         false,
                    is_approved:       false,
                    ai_training_approved: false,
                    images:            [],
                    instructions: [
                        { type: "ingredients", items: meal.ingredients ?? [] },
                        { type: "steps",       items: meal.steps ?? [] },
                    ],
                });
            }
        }

        const savedRecipes = await Recipe.insertMany(recipeInputs);

        const itemDocs = recipeEntries.map((entry, i) => ({
            meal_plan_id: plan._id,
            day_number:   entry.day,
            meal_type:    entry.meal_type,
            recipe_id:    savedRecipes[i]._id,
            sort_order:   entry.sort_order,
        }));
        await MealPlanItem.insertMany(itemDocs);

        res.status(201).json({
            plan_id:     (plan._id as any).toString(),
            title:       plan.title,
            description: plan.description,
            total_days:  plan.total_days,
            goal_type:   plan.goal_type,
            days:        parsed.days,
        });
    } catch (error) {
        const err = error as any;
        if (err.name === "AbortError") {
            res.status(504).json({ error: "AI mất quá nhiều thời gian, vui lòng thử lại." });
        } else {
            res.status(500).json({ error: err.message || "Lỗi tạo thực đơn." });
        }
    }
});

export default router;
