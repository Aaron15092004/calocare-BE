import { z } from "zod";
import { Types } from "mongoose";
import { getLLMService, LLMMessage } from "./LLMService";
import { getFoodSearchService } from "./FoodSearchService";
import { getEnrichmentService } from "./EnrichmentService";
import { getFatSecretService } from "./FatSecretService";
import { getFatSecretImportService, FatSecretImportService } from "./FatSecretImportService";
import { getTranslationService } from "./TranslationService";
import { getImageService } from "./ImageService";
import MealPlan from "../../models/MealPlan";
import MealPlanItem from "../../models/MealPlanItem";
import User from "../../models/User";
import { trackAiUsage } from "../../utils/aiUsage";

export type GoalType = "weight_loss" | "muscle_gain" | "maintenance";

export type MealsPerDay = 3 | 4 | 5;
export type CookingStyle = "fresh" | "batch";

export interface GenerateMealPlanRequest {
    userId: string;
    duration_days: 7 | 21;
    goal: GoalType;
    meals_per_day?: MealsPerDay;
    cooking_style?: CookingStyle;
    preferences?: {
        dietary_preference?: string;
        allergies?: string[];
        cuisine_preferences?: string[];
        notes?: string;
    };
}

export interface DayPlan {
    day_number: number;
    meals: MealItem[];
    day_totals: NutritionTotals;
    substitutions: string[];
}

interface MealItem {
    meal_type: "breakfast" | "lunch" | "dinner" | "snack" | "morning_snack" | "afternoon_snack";
    food_name: string;
    food_id?: string;
    source_type?: "food" | "recipe" | "usda" | "ai_generated";
    fdc_id?: number;
    weight_grams: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    cooking_steps?: string[];
}

interface NutritionTotals {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}

// Per-meal-type list of real DB candidates so the fallback never invents recipes
interface CandidateEntry {
    source_id: string;
    source_type: "food" | "recipe" | "usda" | "ai_generated";
    name: string;
    energy_kcal?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
}
type MealTypeCandidates = Map<string, CandidateEntry[]>;

interface GenerateDayResult {
    plan: DayPlan;
    mealTypeCandidates: MealTypeCandidates;
}

// Macro splits per goal (protein%/carbs%/fat%)
const MACRO_SPLITS: Record<GoalType, [number, number, number]> = {
    weight_loss: [30, 40, 30],
    muscle_gain: [30, 50, 20],
    maintenance: [25, 45, 30],
};

// Calorie offset per goal
const CALORIE_OFFSET: Record<GoalType, number> = {
    weight_loss: -500,
    muscle_gain: 300,
    maintenance: 0,
};

// Meal type sets and calorie distributions per meals_per_day value
const MEAL_CONFIGS: Record<MealsPerDay, { types: string[]; dist: Record<string, number> }> = {
    3: {
        types: ["breakfast", "lunch", "dinner"],
        dist:  { breakfast: 0.30, lunch: 0.40, dinner: 0.30 },
    },
    4: {
        types: ["breakfast", "lunch", "dinner", "snack"],
        dist:  { breakfast: 0.25, lunch: 0.35, dinner: 0.30, snack: 0.10 },
    },
    5: {
        types: ["breakfast", "morning_snack", "lunch", "afternoon_snack", "dinner"],
        dist:  { breakfast: 0.20, morning_snack: 0.10, lunch: 0.30, afternoon_snack: 0.10, dinner: 0.30 },
    },
};

const SYSTEM_ROLE = "Bạn là chuyên gia dinh dưỡng người Việt Nam, tư vấn kế hoạch ăn uống thực tế, lành mạnh, khoa học, phù hợp văn hóa ẩm thực Việt và hướng dẫn của Bộ Y tế Việt Nam 2016.";

const BUSINESS_RULES = `TIÊU CHÍ KHOA HỌC (WHO + Bộ Y tế VN 2016):
- Protein: 0.8–1.2g/kg cân nặng/ngày; tăng lên 1.4–1.6g/kg nếu mục tiêu tăng cơ
- Chất xơ: ≥25g/ngày (rau xanh ≥300g/ngày, trái cây 2 khẩu phần/ngày)
- Chất béo bão hoà: <10% tổng calo (hạn chế mỡ động vật, ưu tiên dầu oliu/cá)
- Natri: <2000mg/ngày (hạn chế nước mắm, muối, đồ chiên mặn)
- Tránh ghép đôi kém: không uống trà/cà phê ngay sau bữa ăn giàu sắt (giảm hấp thu sắt)

TIÊU CHÍ LÀNH MẠNH:
- Ưu tiên thực phẩm nguyên chất (thịt, cá, rau, gạo, đậu) hơn thực phẩm chế biến sẵn
- Không chọn > 1 món chiên rán trong cùng 1 ngày
- Đa dạng nguồn protein: KHÔNG dùng cùng 1 loại đạm >2 ngày liên tiếp
- Mỗi ngày cần có ít nhất 1 nguồn đạm thực vật (đậu hũ/đậu xanh/đậu đỏ/nấm)
- Bao gồm ít nhất 1 món rau xanh mỗi bữa chính (trưa/tối)

KHẨU PHẦN CHUẨN VIỆT NAM:
- 1 bát cơm trắng = 150g nấu chín ≈ 200kcal
- 1 bát canh = 200ml ≈ 50–150kcal
- 1 phần protein chính = 80–120g thịt/cá nấu chín
- 1 phần rau xào = 100–150g`;

const GOAL_HINTS: Record<GoalType, string> = {
    weight_loss: "low-calorie lean high-fiber",
    muscle_gain: "high-protein lean",
    maintenance: "balanced nutritious",
};

// 7-slot protein rotation — ensures different protein sources appear in the search
// query each day so vector retrieval returns a varied candidate set.
const PROTEIN_ROTATIONS = [
    "chicken white fish",
    "shrimp seafood",
    "beef tofu",
    "eggs legumes beans",
    "pork crab",
    "duck mushroom",
    "salmon tuna",
];

const STARTER_CANDIDATES: Record<string, CandidateEntry[]> = {
    breakfast: [
        { source_id: "starter:chao-yen-mach-chuoi", source_type: "ai_generated", name: "Cháo yến mạch chuối", energy_kcal: 110, protein: 4, carbs: 20, fat: 2, fiber: 3 },
        { source_id: "starter:banh-mi-trung", source_type: "ai_generated", name: "Bánh mì trứng", energy_kcal: 230, protein: 10, carbs: 32, fat: 8, fiber: 2 },
        { source_id: "starter:pho-ga-it-beo", source_type: "ai_generated", name: "Phở gà ít béo", energy_kcal: 95, protein: 9, carbs: 12, fat: 3, fiber: 1 },
        { source_id: "starter:xoi-dau-xanh", source_type: "ai_generated", name: "Xôi đậu xanh", energy_kcal: 210, protein: 6, carbs: 40, fat: 3, fiber: 2 },
    ],
    lunch: [
        { source_id: "starter:com-ga-rau-xanh", source_type: "ai_generated", name: "Cơm gạo lứt ức gà rau xanh", energy_kcal: 145, protein: 13, carbs: 17, fat: 3, fiber: 3 },
        { source_id: "starter:bun-thit-nuong-rau", source_type: "ai_generated", name: "Bún thịt nướng rau", energy_kcal: 180, protein: 9, carbs: 22, fat: 6, fiber: 2 },
        { source_id: "starter:dau-hu-sot-ca-chua", source_type: "ai_generated", name: "Đậu hũ sốt cà chua cơm gạo lứt", energy_kcal: 130, protein: 7, carbs: 18, fat: 4, fiber: 3 },
        { source_id: "starter:ca-hap-com-rau", source_type: "ai_generated", name: "Cá hấp rau củ cơm trắng", energy_kcal: 120, protein: 12, carbs: 13, fat: 3, fiber: 2 },
    ],
    dinner: [
        { source_id: "starter:salad-ga-ap-chao", source_type: "ai_generated", name: "Salad gà áp chảo", energy_kcal: 110, protein: 14, carbs: 6, fat: 4, fiber: 3 },
        { source_id: "starter:canh-dau-hu-rau-cu", source_type: "ai_generated", name: "Canh đậu hũ rau củ", energy_kcal: 70, protein: 5, carbs: 8, fat: 2, fiber: 3 },
        { source_id: "starter:com-ca-hap-rau-luoc", source_type: "ai_generated", name: "Cơm cá hấp rau luộc", energy_kcal: 125, protein: 12, carbs: 14, fat: 3, fiber: 2 },
        { source_id: "starter:thit-nac-kho-rau", source_type: "ai_generated", name: "Thịt nạc kho rau luộc", energy_kcal: 155, protein: 13, carbs: 10, fat: 7, fiber: 2 },
    ],
    snack: [
        { source_id: "starter:chuoi", source_type: "ai_generated", name: "Chuối", energy_kcal: 89, protein: 1, carbs: 23, fat: 0.3, fiber: 2.6 },
        { source_id: "starter:sua-chua-khong-duong", source_type: "ai_generated", name: "Sữa chua không đường", energy_kcal: 61, protein: 3.5, carbs: 4.7, fat: 3.3, fiber: 0 },
        { source_id: "starter:tao", source_type: "ai_generated", name: "Táo", energy_kcal: 52, protein: 0.3, carbs: 14, fat: 0.2, fiber: 2.4 },
        { source_id: "starter:dau-hu-non", source_type: "ai_generated", name: "Đậu hũ non", energy_kcal: 55, protein: 5, carbs: 2, fat: 3, fiber: 1 },
    ],
};

const GOAL_LABELS: Record<GoalType, string> = {
    weight_loss: "Giảm cân",
    muscle_gain: "Tăng cơ",
    maintenance: "Duy trì cân nặng",
};

// Single tolerance used by prompt wording, retry condition, and serving-size adjuster
const CAL_TOLERANCE = 0.20;

const MealItemSchema = z.object({
    meal_type: z.enum(["breakfast", "lunch", "dinner", "snack", "morning_snack", "afternoon_snack"]),
    food_name: z.string(),
    weight_grams: z.number().positive(),
    calories: z.number().nonnegative(),
    protein: z.number().nonnegative(),
    carbs: z.number().nonnegative(),
    fat: z.number().nonnegative(),
    cooking_steps: z.array(z.string()).max(5).optional(),
});

// Allow up to 3 items per slot (e.g. breakfast: cơm + trứng + canh), up to 5 slots
const DayOutputSchema = z.object({
    meals: z.array(MealItemSchema).min(2).max(15),
});

// Multi-day batch output: same per-day meal schema wrapped in a `days` array
const BatchDaySchema = z.object({
    day_number: z.number().int().positive().optional(),
    meals: z.array(MealItemSchema).min(2).max(15),
});
const BatchOutputSchema = z.object({
    days: z.array(BatchDaySchema).min(1),
});

// Candidate pool fetched ONCE for the whole plan (vector searches + FatSecret
// supplement hoisted out of the per-day loop). displayByMeal is index-aligned
// with mealTypeCandidates entries and includes portion hints for the prompt.
interface CandidatePool {
    foodLookup: Map<string, { source_id: string; source_type: "food" | "recipe" | "usda" | "ai_generated"; fdc_id?: number }>;
    mealTypeCandidates: MealTypeCandidates;
    displayByMeal: Record<string, string[]>;
    mealTypeTargets: Record<string, number>;
}

// Days per LLM call. 21 → 7×3; 7 → 3+3+1 (remainder chunk).
const BATCH_SIZE = 3;
// Wall-clock ceiling for one generation run; on expiry the plan is finalized
// as partial with whatever days were persisted instead of hanging forever.
const GENERATION_DEADLINE_MS = 15 * 60_000;
// Per-day output budget; total per call capped at 8000 so the Gemini 2.0 Flash
// fallback (8192 max output tokens) can still serve a full batch.
const MAX_TOKENS_PER_DAY = 3500;
const MAX_TOKENS_PER_CALL = 8000;

// Shared example meal list used by both single-day and batch prompts
const EXAMPLE_MEALS_JSON = `[
  {"meal_type":"breakfast","food_name":"Phở bò","weight_grams":400,"calories":450,"protein":25,"carbs":60,"fat":12,"cooking_steps":["Đun nước dùng xương bò sôi","Chan nước nóng vào tô bún, bày thịt bò tái","Thêm hành lá, rau thơm, chanh, ớt"]},
  {"meal_type":"snack","food_name":"Chuối","weight_grams":120,"calories":107,"protein":1,"carbs":27,"fat":0,"cooking_steps":["Bóc vỏ, ăn trực tiếp"]},
  {"meal_type":"lunch","food_name":"Cơm trắng","weight_grams":200,"calories":260,"protein":5,"carbs":58,"fat":1,"cooking_steps":["Vo gạo sạch, nấu cơm tỉ lệ 1:1.5"]},
  {"meal_type":"lunch","food_name":"Gà kho gừng","weight_grams":120,"calories":185,"protein":22,"carbs":3,"fat":9,"cooking_steps":["Ướp gà với gừng, nước mắm, đường 15 phút","Kho lửa vừa 20 phút đến khi nước sệt"]},
  {"meal_type":"dinner","food_name":"Cơm trắng","weight_grams":180,"calories":234,"protein":4,"carbs":52,"fat":1,"cooking_steps":["Nấu cơm"]},
  {"meal_type":"dinner","food_name":"Cá hồi áp chảo","weight_grams":150,"calories":250,"protein":30,"carbs":0,"fat":14,"cooking_steps":["Ướp cá với muối, tiêu, chanh 10 phút","Áp chảo mỗi mặt 3–4 phút lửa vừa"]},
  {"meal_type":"dinner","food_name":"Canh rau ngót","weight_grams":200,"calories":45,"protein":3,"carbs":7,"fat":1,"cooking_steps":["Lặt rau, rửa sạch","Nấu sôi nước, cho rau vào 5 phút, nêm muối"]}
]`;

export class MealPlanGeneratorService {
    private readonly llm = getLLMService();
    private readonly search = getFoodSearchService();
    private readonly enrichment = getEnrichmentService();

    async generate(
        req: GenerateMealPlanRequest,
        onProgress: (event: "created" | "progress" | "day" | "done" | "error", data: unknown) => void,
    ): Promise<{ planId: string; source_breakdown: { usda: number; recipe: number; food: number; ai_generated: number } }> {
        const user = await User.findById(req.userId)
            .select("daily_nutrition_goals display_name preferences")
            .lean();

        // Build personalization bio — declared early so TDEE can use profile data
        const prefs = (user as any)?.preferences as Record<string, unknown> | undefined;
        const w      = prefs?.weight_kg    as number | undefined;
        const h      = prefs?.height_cm   as number | undefined;
        const age    = prefs?.age          as number | undefined;
        const gender = prefs?.gender       as string | undefined;
        const activity  = prefs?.activity_level     as string | undefined;
        const allergies = prefs?.allergies           as string[] | undefined;
        const diet      = prefs?.dietary_preference  as string | undefined;

        const effectiveReq: GenerateMealPlanRequest = {
            ...req,
            preferences: {
                ...(req.preferences ?? {}),
                dietary_preference: req.preferences?.dietary_preference ?? diet,
                allergies: this._uniqueStrings([
                    ...(Array.isArray(allergies) ? allergies : []),
                    ...(req.preferences?.allergies ?? []),
                ]),
            },
        };
        const effectiveDiet = effectiveReq.preferences?.dietary_preference;
        const effectiveAllergies = effectiveReq.preferences?.allergies;

        // Auto-TDEE via Mifflin-St Jeor if profile is complete; fall back to stored goal
        const tdee = this._calculateTDEE({ weight_kg: w, height_cm: h, age, gender, activity_level: activity });
        const baseCalories = tdee ?? user?.daily_nutrition_goals?.calories ?? 2000;
        const dailyCalories = baseCalories + CALORIE_OFFSET[req.goal];
        const [pPct, cPct, fPct] = MACRO_SPLITS[req.goal];

        const dailyTargets = {
            calories: dailyCalories,
            protein: Math.round((dailyCalories * pPct) / 100 / 4),  // 4 kcal/g
            carbs:   Math.round((dailyCalories * cPct) / 100 / 4),
            fat:     Math.round((dailyCalories * fPct) / 100 / 9),  // 9 kcal/g
        };

        const bmi = w && h ? Math.round((w / ((h / 100) ** 2)) * 10) / 10 : undefined;
        const bmiCat = bmi
            ? bmi < 18.5 ? "gầy" : bmi < 23 ? "bình thường" : bmi < 25 ? "thừa cân" : "béo phì"
            : undefined;
        const activityLabels: Record<string, string> = {
            sedentary: "ít vận động", light: "vận động nhẹ", moderate: "vận động vừa",
            active: "vận động nhiều", veryActive: "cường độ cao hàng ngày",
        };
        const bioLines: string[] = [];
        if (user?.display_name) bioLines.push(`Tên: ${user.display_name}`);
        if (age) bioLines.push(`${age} tuổi`);
        if (gender) bioLines.push(gender === "male" ? "Nam" : gender === "female" ? "Nữ" : gender);
        if (w) bioLines.push(`${w}kg`);
        if (h) bioLines.push(`${h}cm`);
        if (bmi) bioLines.push(`BMI ${bmi}(${bmiCat})`);
        if (activity) bioLines.push(activityLabels[activity] ?? activity);
        if (tdee) bioLines.push(`TDEE ~${tdee}kcal/ngày`);
        if (effectiveDiet && effectiveDiet !== "omnivore") bioLines.push(`chế độ ăn: ${effectiveDiet}`);
        if (effectiveAllergies?.length) bioLines.push(`tránh: ${effectiveAllergies.join(", ")}`);
        const userBio = bioLines.length ? bioLines.join(" · ") : undefined;

        // Create MealPlan record up-front with status "generating" so a client
        // that disconnects can recover it later (see /api/meal-plans/mine/recovery).
        const plan = await MealPlan.create({
            title: `Kế hoạch ${req.goal === "weight_loss" ? "giảm cân" : req.goal === "muscle_gain" ? "tăng cơ" : "duy trì"} ${req.duration_days} ngày`,
            total_days: req.duration_days,
            goal_type: req.goal,
            is_public: false,
            is_approved: false,
            creator_id: new Types.ObjectId(req.userId),
            status: "generating",
            generated_days: 0,
        });
        trackAiUsage("meal_plan");
        trackAiUsage("meal_plan_day", req.duration_days);
        onProgress("created", { meal_plan_id: (plan._id as Types.ObjectId).toString() });

        const recentFoodNames: string[] = [];
        const proteinSourceLog: string[] = [];
        let nextDayProteinHint: string | undefined;
        const days: DayPlan[] = [];
        const completedDayNumbers: number[] = [];
        const sourceBreakdown = { usda: 0, recipe: 0, food: 0, ai_generated: 0 };
        const recipeIdsForEnrichment = new Set<string>();
        // Wall-clock guard: a stuck provider must not hold the request forever.
        const deadline = Date.now() + GENERATION_DEADLINE_MS;

        try {
        // Fetch the candidate pool ONCE for the whole plan (vector + FatSecret),
        // then generate days in batches of BATCH_SIZE per LLM call.
        const allergyTerms = this._buildAllergyTerms(effectiveReq.preferences?.allergies);
        const pool = await this._buildCandidatePool(dailyTargets, effectiveReq, allergyTerms);

        const batches = this._chunkDays(req.duration_days, BATCH_SIZE);
        for (const batchDays of batches) {
            if (Date.now() > deadline) {
                console.warn(`[MealPlanGenerator] Deadline exceeded after ${days.length} days — finalizing as partial`, { userId: req.userId });
                break;
            }
            onProgress("progress", { current_day: batchDays[0], total_days: req.duration_days });

            const proteinHints = batchDays.map((d, i) =>
                i === 0 && nextDayProteinHint
                    ? nextDayProteinHint
                    : PROTEIN_ROTATIONS[(d - 1) % PROTEIN_ROTATIONS.length]);

            // Batch generation: 1 retry per batch (correction attempt handled inside)
            let batchPlans: (DayPlan | null)[] | null = null;
            for (let attempt = 1; attempt <= 2 && !batchPlans; attempt++) {
                try {
                    batchPlans = await this._generateBatch(
                        batchDays, dailyTargets, effectiveReq, pool, recentFoodNames,
                        attempt, userBio, proteinHints, allergyTerms,
                    );
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[MealPlanGenerator] Batch days ${batchDays.join(",")} attempt ${attempt} failed:`, msg, { userId: req.userId, goal: req.goal, mealsPerDay: req.meals_per_day });
                }
            }
            if (!batchPlans) batchPlans = batchDays.map(() => null);

            for (let i = 0; i < batchDays.length; i++) {
                const day = batchDays[i];
                if (i > 0) onProgress("progress", { current_day: day, total_days: req.duration_days });

                let dayPlan = batchPlans[i];
                let dayCandidates = pool.mealTypeCandidates;

                // Repair path: regenerate ONLY this day with the single-day call
                // (attempt 2 = higher temp; attempt 3 tolerates deviation → scaling)
                if (!dayPlan) {
                    for (let attempt = 2; attempt <= 3 && !dayPlan; attempt++) {
                        try {
                            const repaired = await this._generateDay(
                                day, dailyTargets, effectiveReq, recentFoodNames,
                                attempt, userBio, proteinHints[i],
                            );
                            dayPlan = repaired.plan;
                            dayCandidates = repaired.mealTypeCandidates;
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            console.error(`[MealPlanGenerator] Day ${day} repair attempt ${attempt} failed:`, msg, { userId: req.userId, goal: req.goal, mealsPerDay: req.meals_per_day });
                        }
                    }
                }
                if (!dayPlan) continue;

                const finalized = await this._persistAndEmitDay(
                    day, dayPlan, dayCandidates, plan._id as Types.ObjectId, dailyTargets,
                    sourceBreakdown, recipeIdsForEnrichment, proteinSourceLog, onProgress,
                );
                if (!finalized.ok) continue;

                days.push(finalized.dayPlan);
                completedDayNumbers.push(day);
                // Persist progress so a disconnected client can poll/recover the plan
                await MealPlan.updateOne(
                    { _id: plan._id },
                    { $set: { generated_days: days.length } },
                ).catch(() => {});
                recentFoodNames.push(...finalized.dayPlan.meals.map((m) => m.food_name));
                // Keep up to 120 recent names (21 days × 5 meals = 105 + buffer).
                if (recentFoodNames.length > 120) recentFoodNames.splice(0, 10);
                nextDayProteinHint = finalized.nextDayProteinHint;
            }
        }

        // Finalize: keep whatever was generated instead of deleting hours of work.
        // 0 days → nothing usable, clean up and fail (route refunds quota).
        if (days.length === 0) {
            await MealPlanItem.deleteMany({ meal_plan_id: plan._id });
            await MealPlan.deleteOne({ _id: plan._id });
            throw new Error(`Không tạo được kế hoạch ${req.duration_days} ngày. Vui lòng thử lại.`);
        }

        let planStatus: "completed" | "partial" = "completed";
        if (days.length < req.duration_days) {
            planStatus = "partial";
            await this._finalizeAsPartial(plan._id as Types.ObjectId, completedDayNumbers, req.duration_days);
        } else {
            await MealPlan.updateOne(
                { _id: plan._id },
                { $set: { status: "completed", generated_days: days.length } },
            );
        }

        // Queue recipe enrichment for all recipes used in this plan (partial plans too)
        if (recipeIdsForEnrichment.size > 0) {
            this.enrichment
                .queueRecipeEnrichment([...recipeIdsForEnrichment], { type: "meal_plan" })
                .catch((err) => console.warn("[MealPlanGenerator] queue recipe enrichment error:", err));
        }

        const planId = (plan._id as Types.ObjectId).toString();
        onProgress("done", {
            meal_plan_id: planId,
            days_generated: days.length,
            plan_status: planStatus,
            requested_days: req.duration_days,
            source_breakdown: sourceBreakdown,
        });
        return { planId, source_breakdown: sourceBreakdown };

        } catch (err) {
            // Unexpected mid-run failure. Salvage persisted days as a partial plan
            // rather than leaving an orphaned "generating" doc (or deleting work).
            if (days.length > 0) {
                console.error("[MealPlanGenerator] Unexpected failure — salvaging partial plan:", err instanceof Error ? err.message : String(err), { userId: req.userId, daysKept: days.length });
                await this._finalizeAsPartial(plan._id as Types.ObjectId, completedDayNumbers, req.duration_days).catch(() => {});
                const planId = (plan._id as Types.ObjectId).toString();
                onProgress("done", {
                    meal_plan_id: planId,
                    days_generated: days.length,
                    plan_status: "partial",
                    requested_days: req.duration_days,
                    source_breakdown: sourceBreakdown,
                });
                return { planId, source_breakdown: sourceBreakdown };
            }
            await MealPlanItem.deleteMany({ meal_plan_id: plan._id }).catch(() => {});
            await MealPlan.deleteOne({ _id: plan._id }).catch(() => {});
            throw err;
        }
    }

    // Compact day numbering (a middle day can fail while later days succeed) so
    // the plan reads Ngày 1..N without holes, then mark the plan as partial.
    // Ascending order guarantees the target slot is always free.
    private async _finalizeAsPartial(
        planId: Types.ObjectId,
        completedDayNumbers: number[],
        requestedDays: number,
    ): Promise<void> {
        const daysKept = completedDayNumbers.length;
        const renumberOps = completedDayNumbers
            .map((oldDay, idx) => ({ oldDay, newDay: idx + 1 }))
            .filter(({ oldDay, newDay }) => oldDay !== newDay)
            .map(({ oldDay, newDay }) => ({
                updateMany: {
                    filter: { meal_plan_id: planId, day_number: oldDay },
                    update: { $set: { day_number: newDay } },
                },
            }));
        if (renumberOps.length > 0) {
            await MealPlanItem.bulkWrite(renumberOps, { ordered: true });
        }
        await MealPlan.updateOne(
            { _id: planId },
            {
                $set: {
                    status: "partial",
                    total_days: daysKept,
                    generated_days: daysKept,
                    generation_error: `Tạo được ${daysKept}/${requestedDays} ngày do gián đoạn`,
                    description: `Kế hoạch ${daysKept} ngày (mục tiêu ban đầu ${requestedDays} ngày — một số ngày tạo không thành công).`,
                },
            },
        );
    }

    // Split 1..duration into consecutive chunks of `size` (e.g. 7 → [1-3],[4-6],[7])
    private _chunkDays(duration: number, size: number): number[][] {
        const chunks: number[][] = [];
        for (let start = 1; start <= duration; start += size) {
            const chunk: number[] = [];
            for (let d = start; d <= Math.min(start + size - 1, duration); d++) chunk.push(d);
            chunks.push(chunk);
        }
        return chunks;
    }

    // Persist one validated day (items, calorie scaling, fiber top-up, protein
    // streak tracking) and emit the per-day SSE event. USDA enrichment is
    // fire-and-forget — it must never block generation.
    private async _persistAndEmitDay(
        day: number,
        dayPlanIn: DayPlan,
        mealTypeCandidates: MealTypeCandidates,
        planId: Types.ObjectId,
        dailyTargets: NutritionTotals,
        sourceBreakdown: { usda: number; recipe: number; food: number; ai_generated: number },
        recipeIdsForEnrichment: Set<string>,
        proteinSourceLog: string[],
        onProgress: (event: "progress" | "day" | "done" | "error", data: unknown) => void,
    ): Promise<{ ok: boolean; dayPlan: DayPlan; nextDayProteinHint?: string }> {
        let dayPlan = dayPlanIn;

        // USDA enrichment moved OFF the critical path: fire-and-forget.
        // Meals keep their usda_food_id reference; the enriched Recipe is
        // created in the background for future plans/searches.
        for (const m of dayPlan.meals) {
            if (m.source_type === "usda" && m.fdc_id != null) {
                void this.enrichment.processJob(m.fdc_id, false).catch((err) =>
                    console.warn(`[MealPlanGenerator] Background enrich fdc_id=${m.fdc_id}:`, err instanceof Error ? err.message : String(err)));
            }
        }

        const itemsToInsert: object[] = [];
        console.log(`[MealPlanGenerator] Day ${day}: LLM returned ${dayPlan.meals.length} meals`);
        for (let i = 0; i < dayPlan.meals.length; i++) {
            let meal = dayPlan.meals[i];
            let recipe_id: Types.ObjectId | undefined;
            let food_id: Types.ObjectId | undefined;
            let usda_food_id: Types.ObjectId | undefined;
            let source_type: string | undefined;
            let custom_food: {
                name: string;
                calories_kcal: number;
                protein_g: number;
                carbs_g: number;
                fat_g: number;
                fiber_g?: number;
                serving_description?: string;
                description?: string;
            } | undefined;

            if (meal.food_id && meal.source_type) {
                source_type = meal.source_type;
                if (meal.source_type === "recipe") {
                    recipe_id = new Types.ObjectId(meal.food_id);
                } else if (meal.source_type === "usda") {
                    usda_food_id = new Types.ObjectId(meal.food_id);
                } else if (meal.source_type === "ai_generated") {
                    custom_food = this._toCustomFood(meal);
                } else {
                    food_id = new Types.ObjectId(meal.food_id);
                }
            } else {
                // LLM invented a name not in the DB lookup.
                // Use the top real candidate and override calories/macros with its
                // actual DB nutrition to avoid serving hallucinated nutritional data.
                const fallback = mealTypeCandidates.get(meal.meal_type)?.[0];
                if (!fallback) {
                    console.warn(`[MealPlanGenerator] Day ${day} ${meal.meal_type}: no DB candidate, skipping meal`);
                    continue;
                }
                dayPlan.substitutions.push(`"${meal.food_name}" → "${fallback.name}"`);
                source_type = fallback.source_type;
                if (fallback.source_type === "recipe") {
                    recipe_id = new Types.ObjectId(fallback.source_id);
                } else if (fallback.source_type === "usda") {
                    usda_food_id = new Types.ObjectId(fallback.source_id);
                } else if (fallback.source_type === "ai_generated") {
                    custom_food = this._toCustomFood({
                        ...meal,
                        food_name: fallback.name,
                        source_type: "ai_generated",
                    });
                } else {
                    food_id = new Types.ObjectId(fallback.source_id);
                }
                // Override LLM-invented nutrition with verified DB values
                if (fallback.energy_kcal != null) {
                    meal = {
                        ...meal,
                        food_name: fallback.name,
                        calories: Math.round((fallback.energy_kcal ?? 0) * meal.weight_grams / 100),
                        protein: Math.round((fallback.protein ?? 0) * meal.weight_grams / 100 * 10) / 10,
                        carbs:   Math.round((fallback.carbs   ?? 0) * meal.weight_grams / 100 * 10) / 10,
                        fat:     Math.round((fallback.fat     ?? 0) * meal.weight_grams / 100 * 10) / 10,
                    };
                    if (fallback.source_type === "ai_generated") {
                        custom_food = this._toCustomFood(meal);
                    }
                }
            }

            if (source_type === "ai_generated" && !custom_food) {
                custom_food = this._toCustomFood(meal);
            }

            // Track source breakdown for logging
            const st = (source_type ?? "ai_generated") as keyof typeof sourceBreakdown;
            sourceBreakdown[st] = (sourceBreakdown[st] ?? 0) + 1;

            if (recipe_id) recipeIdsForEnrichment.add(recipe_id.toString());

            itemsToInsert.push({
                meal_plan_id: planId,
                day_number: day,
                meal_type: meal.meal_type,
                recipe_id,
                food_id,
                usda_food_id,
                custom_food,
                source_type,
                serving_size: meal.weight_grams,
                calories: meal.calories,
                // Keep the LLM's cooking guidance (used to be discarded);
                // renderers prefer recipe_id.instructions when a Recipe exists
                cooking_steps: meal.cooking_steps?.length ? meal.cooking_steps : undefined,
                sort_order: i,
            });
        }

        if (itemsToInsert.length === 0) {
            console.warn(`[MealPlanGenerator] Day ${day}: 0 items to insert — all meals skipped (no DB candidates). Check vector store has data.`);
            return { ok: false, dayPlan };
        }

        // Scale serving sizes BEFORE commit so stored data is already calibrated
        const { meals: adjustedMeals, scaleFactor } = this._adjustDayCalories(dayPlan.meals, dailyTargets, day);
        if (scaleFactor !== 1) {
            const typedItems = itemsToInsert as Array<{
                serving_size: number;
                calories: number;
                custom_food?: {
                    calories_kcal: number;
                    protein_g: number;
                    carbs_g: number;
                    fat_g: number;
                    serving_description?: string;
                };
            }>;
            for (let idx = 0; idx < typedItems.length; idx++) {
                const item = typedItems[idx];
                const adjustedMeal = adjustedMeals[idx];
                item.serving_size = adjustedMeal?.weight_grams ?? Math.round(item.serving_size * scaleFactor);
                item.calories = adjustedMeal?.calories ?? Math.round(item.calories * scaleFactor);
                if (item.custom_food && adjustedMeal) {
                    item.custom_food.calories_kcal = adjustedMeal.calories;
                    item.custom_food.protein_g = adjustedMeal.protein;
                    item.custom_food.carbs_g = adjustedMeal.carbs;
                    item.custom_food.fat_g = adjustedMeal.fat;
                    item.custom_food.serving_description = `${adjustedMeal.weight_grams}g`;
                }
            }
            dayPlan = {
                ...dayPlan,
                meals: adjustedMeals,
                day_totals: {
                    calories: adjustedMeals.reduce((s, m) => s + m.calories, 0),
                    protein:  adjustedMeals.reduce((s, m) => s + m.protein,  0),
                    carbs:    adjustedMeals.reduce((s, m) => s + m.carbs,    0),
                    fat:      adjustedMeals.reduce((s, m) => s + m.fat,      0),
                },
            };
        }

        // Auto-add high-fiber item if day is fiber-deficient (requires actual fiber data from DB)
        const fiberCandidate = this._findHighFiberCandidate(mealTypeCandidates, dayPlan.meals);
        if (fiberCandidate) {
            const fw = 150;
            const fcal = Math.round((fiberCandidate.energy_kcal ?? 0) * fw / 100);
            dayPlan.meals.push({
                meal_type: "dinner",
                food_name: fiberCandidate.name,
                food_id: fiberCandidate.source_id,
                source_type: fiberCandidate.source_type,
                weight_grams: fw,
                calories: fcal,
                protein: Math.round((fiberCandidate.protein ?? 0) * fw / 100 * 10) / 10,
                carbs:   Math.round((fiberCandidate.carbs   ?? 0) * fw / 100 * 10) / 10,
                fat:     Math.round((fiberCandidate.fat     ?? 0) * fw / 100 * 10) / 10,
            });
            const fiberRef = fiberCandidate.source_type === "recipe"
                ? { recipe_id: new Types.ObjectId(fiberCandidate.source_id) }
                : { food_id: new Types.ObjectId(fiberCandidate.source_id) };
            itemsToInsert.push({
                meal_plan_id: planId,
                day_number: day,
                meal_type: "dinner",
                ...fiberRef,
                source_type: fiberCandidate.source_type,
                serving_size: fw,
                calories: fcal,
                sort_order: itemsToInsert.length,
            });
            console.log(`[MealPlanAudit] Day ${day}: added high-fiber item "${fiberCandidate.name}" (fiber~${fiberCandidate.fiber?.toFixed(1)}g/100g)`);
        }

        await MealPlanItem.insertMany(itemsToInsert);

        // Off the critical path: fill Unsplash images for AI-only items of this
        // day (recipe/food items get images via their own enrichment pipeline).
        this._fillCustomFoodImages(planId, day);

        // Protein diversity: track source, log streak, override hint for next day
        let nextDayProteinHint: string | undefined;
        const dayProtein = this._detectProteinSource(dayPlan.meals);
        proteinSourceLog.push(dayProtein);
        if (proteinSourceLog.length >= 3 &&
            proteinSourceLog[proteinSourceLog.length - 1] === dayProtein &&
            proteinSourceLog[proteinSourceLog.length - 2] === dayProtein &&
            dayProtein !== "other") {
            const avoid: Record<string, string[]> = {
                poultry: ["shrimp seafood", "beef tofu", "eggs legumes beans", "salmon tuna"],
                beef:    ["chicken white fish", "shrimp seafood", "eggs legumes beans", "salmon tuna"],
                pork:    ["chicken white fish", "shrimp seafood", "beef tofu", "duck mushroom"],
                fish:    ["shrimp seafood", "beef tofu", "eggs legumes beans", "pork crab"],
                seafood: ["chicken white fish", "beef tofu", "eggs legumes beans", "salmon tuna"],
                egg:     ["chicken white fish", "shrimp seafood", "beef tofu", "salmon tuna"],
                legume:  ["chicken white fish", "shrimp seafood", "pork crab", "duck mushroom"],
            };
            const options = avoid[dayProtein] ?? PROTEIN_ROTATIONS;
            nextDayProteinHint = options[day % options.length];
            console.log(`[MealPlanGenerator] Day ${day}: protein "${dayProtein}" 3-day streak — next day hint: "${nextDayProteinHint}"`);
        }

        // SSE contract: one `day` event per day, same shape as before
        onProgress("day", {
            day_number: day,
            plan: dayPlan,
            substitutions: dayPlan.substitutions,
        });

        return { ok: true, dayPlan, nextDayProteinHint };
    }

    // Fetch the candidate pool ONCE for the whole plan: per-meal-type vector
    // searches with a larger top_k plus a single FatSecret supplement pass for
    // sparse meal types. Adapted from the old per-day retrieval in _generateDay.
    private async _buildCandidatePool(
        targets: NutritionTotals,
        req: GenerateMealPlanRequest,
        allergyTerms: string[],
    ): Promise<CandidatePool> {
        const foodLookup: CandidatePool["foodLookup"] = new Map();
        const mealTypeCandidates: MealTypeCandidates = new Map();
        const displayByMeal: Record<string, string[]> = {};
        const mealTypeTargets: Record<string, number> = {};

        const mealConfig = MEAL_CONFIGS[req.meals_per_day ?? 4];
        const cookingHint = req.cooking_style === "batch" ? "batch-cook one-pot reheat" : "fresh quick-prep";
        // Whole-plan pool: include the full protein rotation vocabulary so one
        // query returns a varied set covering every rotation slot.
        const proteinTerms = PROTEIN_ROTATIONS.join(" ");

        const searchResults = await Promise.all(
            mealConfig.types.map((mealType) => {
                const targetCal = Math.round(targets.calories * (mealConfig.dist[mealType] ?? 0.25));
                const query = `${mealType} ${req.preferences?.cuisine_preferences?.[0] ?? "Vietnamese"} ${GOAL_HINTS[req.goal]} ${cookingHint} ${proteinTerms} ${targetCal}kcal`;
                return this.search.search({
                    query,
                    top_k: 20, // ~2.5x the old per-day top_k 8 — one pool serves the whole plan
                    include_sources: ["food", "recipe", "usda"],
                    user_preferences: req.preferences as import("./FoodSearchService").UserPreferences | undefined,
                }).then((results) => ({
                    mealType,
                    results: results.filter((r) => !this._containsBlockedAllergen(r.name, allergyTerms)),
                }));
            }),
        );

        // P0-5: Keep generation alive with starter candidates so early/dev DBs
        // do not make the core meal-plan feature feel broken.
        const allEmpty = searchResults.every(({ results }) => results.length === 0);
        if (allEmpty) {
            console.warn("[MealPlanGenerator] Candidate pool: all vector candidates empty — using starter AI-generated candidates.");
        }

        for (const { mealType, results } of searchResults) {
            mealTypeTargets[mealType] = Math.round(targets.calories * (mealConfig.dist[mealType] ?? 0.25));

            const typedCandidates: CandidateEntry[] = [];
            const displays: string[] = [];

            for (const r of results) {
                if (!r.name) continue;
                const portionHint = r.portions?.[0] ? ` [${r.portions[0].description}=${r.portions[0].gram_weight}g]` : "";
                const entry = {
                    source_id: r.source_id,
                    source_type: r.source_type as "food" | "recipe" | "usda",
                    fdc_id: r.fdc_id,
                };
                foodLookup.set(r.name.toLowerCase(), entry);
                if (portionHint) foodLookup.set((r.name + portionHint).toLowerCase(), entry);

                // Store actual DB nutrition so fallback meals use verified data
                typedCandidates.push({
                    source_id: r.source_id,
                    source_type: entry.source_type,
                    name: r.name,
                    energy_kcal: r.energy_kcal,
                    protein: r.protein,
                    carbs: r.glucid,
                    fat: r.lipid,
                    fiber: (r as any).fiber,
                });
                displays.push(r.name + portionHint);
            }

            if (typedCandidates.length === 0) {
                const starterCandidates = this._starterCandidatesForMeal(mealType, req, allergyTerms);
                for (const starter of starterCandidates) {
                    foodLookup.set(starter.name.toLowerCase(), {
                        source_id: starter.source_id,
                        source_type: starter.source_type,
                    });
                    foodLookup.set(`${starter.name} [ước tính]`.toLowerCase(), {
                        source_id: starter.source_id,
                        source_type: starter.source_type,
                    });
                    typedCandidates.push(starter);
                    displays.push(`${starter.name} [ước tính]`);
                }
            }

            mealTypeCandidates.set(mealType, typedCandidates);
            displayByMeal[mealType] = displays;
            if (typedCandidates.length === 0) {
                console.warn(`[MealPlanGenerator] Candidate pool ${mealType}: 0 candidates from vector search. Vector store may be empty.`);
            }
        }

        // FatSecret supplement — runs ONCE per plan, only for meal types that
        // still have 0 candidates. Upserts to local Food DB so items get real _ids.
        if (FatSecretImportService.isAvailable()) {
            const sparseTypes = mealConfig.types.filter(
                (mt) => (mealTypeCandidates.get(mt)?.length ?? 0) === 0,
            );
            if (sparseTypes.length > 0) {
                const fsService  = getFatSecretService();
                const fsImport   = getFatSecretImportService();
                const translation = getTranslationService();

                await Promise.all(
                    sparseTypes.map(async (mealType) => {
                        try {
                            const mealHint = mealType.includes("snack") ? "snack" : mealType;
                            const query = `${mealHint} Vietnamese ${GOAL_HINTS[req.goal]}`;
                            const FATSECRET_TIMEOUT_MS = 3000;
                            const fsItems = await Promise.race([
                                fsService.searchFoodsV5(query, 8),
                                new Promise<never>((_, reject) =>
                                    setTimeout(() => reject(new Error("FatSecret timeout")), FATSECRET_TIMEOUT_MS),
                                ),
                            ]);
                            if (fsItems.length === 0) return;

                            // Translate English FatSecret names → Vietnamese in one batch
                            const enNames = fsItems.map((f) => f.food_name);
                            let viNames = enNames;
                            try {
                                viNames = await translation.translateBatch(enNames);
                            } catch { /* keep English on failure */ }

                            const typedCandidates = mealTypeCandidates.get(mealType) ?? [];
                            const displays = displayByMeal[mealType] ?? [];

                            for (let i = 0; i < fsItems.length; i++) {
                                const fs     = fsItems[i];
                                const viName = viNames[i] || fs.food_name;
                                if (this._containsBlockedAllergen(`${viName} ${fs.food_name}`, allergyTerms)) continue;
                                // Upsert synchronously so we get a real MongoDB _id
                                const food = await fsImport.upsertFromV5Food(fs, viName);
                                if (!food) continue;

                                const entry = {
                                    source_id:   (food._id as Types.ObjectId).toString(),
                                    source_type: "food" as const,
                                };
                                foodLookup.set(viName.toLowerCase(), entry);
                                foodLookup.set(fs.food_name.toLowerCase(), entry);
                                typedCandidates.push({ ...entry, name: viName });
                                displays.push(viName);
                            }

                            mealTypeCandidates.set(mealType, typedCandidates);
                            displayByMeal[mealType] = displays;
                        } catch (err) {
                            console.warn(
                                `[MealPlanGenerator] FatSecret supplement for ${mealType} failed:`,
                                err instanceof Error ? err.message : String(err),
                            );
                        }
                    }),
                );
            }
        }

        return { foodLookup, mealTypeCandidates, displayByMeal, mealTypeTargets };
    }

    // Build the per-batch candidate block: prefer names not yet used in the plan
    // so consecutive batches see fresh options; refill with used ones if sparse.
    private _candidateBlockFor(pool: CandidatePool, usedNames: string[]): string {
        const used = new Set(usedNames.map((n) => this._normalizeText(n)));
        return Object.entries(pool.displayByMeal)
            .map(([mealType, displays]) => {
                const entries = pool.mealTypeCandidates.get(mealType) ?? [];
                const fresh: string[] = [];
                const alreadyUsed: string[] = [];
                displays.forEach((display, i) => {
                    const name = entries[i]?.name ?? display;
                    (used.has(this._normalizeText(name)) ? alreadyUsed : fresh).push(display);
                });
                const chosen = (fresh.length >= 6 ? fresh : [...fresh, ...alreadyUsed]).slice(0, 16);
                return `[${mealType} — ~${pool.mealTypeTargets[mealType]}kcal]\n${chosen.join("; ")}`;
            })
            .join("\n\n");
    }

    // Shared prompt rules for single-day and batch prompts (batch adds rules 8–9)
    private _buildRulesBlock(avoidLine: string, batchDayNumbers?: number[]): string {
        const base = `QUY TẮC BẮT BUỘC:
1. food_name copy CHÍNH XÁC từ danh sách (kể cả [...] nếu có)
2. Calories/protein/carbs/fat = TỔNG cho khẩu phần (không phải per 100g)
3. SỐ MÓN THEO TỪNG BỮA (văn hóa VN thực tế):
   · breakfast: 1 món đơn lẻ (phở/bún/bánh mì/cháo/xôi/cơm tấm — CHỈ 1 dòng)
   · morning_snack / afternoon_snack / snack: 1 món nhẹ (trái cây/sữa chua/hạt/sữa)
   · lunch: 1–2 món (1 đơn lẻ HOẶC cơm + 1 protein)
   · dinner: 2–3 món (cơm + protein + canh/rau — lặp meal_type để thêm)
4. cooking_steps: 3–5 bước nấu CỤ THỂ bằng tiếng Việt — ghi rõ định lượng nguyên liệu chính (vd "200g thịt gà", "2 thìa nước mắm"), thời gian và lửa (vd "kho lửa vừa 20 phút"). Món ăn liền (trái cây, sữa chua) chỉ cần 1 bước.
5. Tổng calories mỗi bữa ±20% mục tiêu
6. Đa dạng nguồn protein, không lặp cùng loại đạm trong ngày
7. TUYỆT ĐỐI không chọn món chứa dị ứng/kiêng bắt buộc của người dùng${avoidLine}`;
        if (!batchDayNumbers) return base;
        return `${base}
8. Trả về ĐÚNG ${batchDayNumbers.length} ngày trong mảng "days", day_number lần lượt: ${batchDayNumbers.join(", ")}
9. KHÔNG lặp lại món chính (bữa trưa/tối) giữa các ngày trong cùng phản hồi — đổi nguồn đạm theo gợi ý từng ngày`;
    }

    // Parse LLM JSON output against a schema, giving the model ONE correction
    // chance before throwing to the caller's retry loop.
    private async _parseWithCorrection<S extends z.ZodTypeAny>(
        schema: S,
        messages: LLMMessage[],
        firstContent: string,
        label: string,
        maxTokens: number,
    ): Promise<z.infer<S>> {
        const cleanJson = (raw: string) => raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const text = cleanJson(firstContent);
        try {
            return schema.parse(JSON.parse(text));
        } catch {
            console.warn(`[MealPlanGenerator] ${label} JSON parse failed — sending correction. Raw (200): ${text.slice(0, 200)}`);
            const correctionMessages: LLMMessage[] = [
                ...messages,
                { role: "assistant", content: firstContent },
                { role: "user", content: "Phản hồi trên không phải JSON hợp lệ. Trả về JSON thuần túy duy nhất, bắt đầu bằng { và kết thúc bằng }, không có markdown, không có giải thích." },
            ];
            const correctionResp = await this.llm.generate(correctionMessages, { temperature: 0.1, maxTokens });
            const correctedText = cleanJson(correctionResp.content);
            try {
                return schema.parse(JSON.parse(correctedText));
            } catch (parseErr) {
                console.error(`[MealPlanGenerator] ${label} JSON still invalid after correction. Raw (500): ${correctedText.slice(0, 500)}`);
                throw parseErr;
            }
        }
    }

    // Recalculate calories from macros (ground truth) and correct LLM's reported
    // values. LLM often reports calories independently of macros; macros are more reliable.
    private _correctMealCalories(meals: z.infer<typeof MealItemSchema>[]): z.infer<typeof MealItemSchema>[] {
        return meals.map((m) => {
            const macroCalories = Math.round(m.protein * 4 + m.carbs * 4 + m.fat * 9);
            const reportedCalories = m.calories;
            // If the reported calories deviate > 20% from macro-derived, use macros
            const macroDeviation = reportedCalories > 0
                ? Math.abs(reportedCalories - macroCalories) / macroCalories
                : 1;
            return macroDeviation > 0.2
                ? { ...m, calories: macroCalories }
                : m;
        });
    }

    // Resolve meal names against the candidate lookup and assemble a DayPlan
    private _toDayPlan(
        day: number,
        meals: z.infer<typeof MealItemSchema>[],
        dayTotals: NutritionTotals,
        foodLookup: CandidatePool["foodLookup"],
    ): DayPlan {
        return {
            day_number: day,
            substitutions: [],
            meals: meals.map((m) => {
                // Try exact name first; strip portion hint `[...]` as fallback
                const match = foodLookup.get(m.food_name.toLowerCase())
                    ?? foodLookup.get(m.food_name.replace(/\s*\[.*?\]$/, "").trim().toLowerCase());
                return {
                    ...m,
                    // Normalize stored name: strip portion hint so recentFoodNames stays clean
                    food_name: m.food_name.replace(/\s*\[.*?\]$/, "").trim(),
                    food_id: match?.source_id,
                    source_type: match?.source_type,
                    fdc_id: match?.fdc_id,
                };
            }),
            day_totals: dayTotals,
        };
    }

    // Generate a batch of consecutive days in ONE LLM call. Returns one entry
    // per requested day; null = that day failed validation and needs the
    // single-day repair path (_generateDay).
    private async _generateBatch(
        dayNumbers: number[],
        targets: NutritionTotals,
        req: GenerateMealPlanRequest,
        pool: CandidatePool,
        recentFoodNames: string[],
        attemptNumber: number,
        userBio: string | undefined,
        proteinHints: string[],
        allergyTerms: string[],
    ): Promise<(DayPlan | null)[]> {
        const mealConfig = MEAL_CONFIGS[req.meals_per_day ?? 4];
        const cookingStyleLabel = req.cooking_style === "batch"
            ? "Nấu 1 lần ăn cả ngày (chỉ trong ngày hôm đó, không phải cả tuần)"
            : "Nấu tươi từng bữa";
        const dietaryLine = req.preferences?.dietary_preference
            ? `\n- Chế độ ăn: ${req.preferences.dietary_preference}` : "";
        const allergyLine = req.preferences?.allergies?.length
            ? `\n- Dị ứng/kiêng bắt buộc: ${req.preferences.allergies.join(", ")}` : "";
        const notesLine = req.preferences?.notes
            ? `\n- Ghi chú: ${req.preferences.notes}` : "";
        const avoidLine = recentFoodNames.length
            ? `\n- KHÔNG ĐƯỢC chọn lại các món đã dùng gần đây: ${recentFoodNames.join(", ")}` : "";

        const candidatesBlock = this._candidateBlockFor(pool, recentFoodNames);
        const hintLines = dayNumbers.map((d, i) => `Ngày ${d}: ${proteinHints[i]}`).join(" · ");
        const bioline = userBio ? `\nNgười dùng: ${userBio}` : "";
        const first = dayNumbers[0];
        const last = dayNumbers[dayNumbers.length - 1];

        const prompt = `== Kế hoạch bữa ăn: Ngày ${first}–${last}/${req.duration_days} (${dayNumbers.length} ngày trong 1 phản hồi) ==${bioline}
Mục tiêu: ${GOAL_LABELS[req.goal]} · ${cookingStyleLabel}${dietaryLine}${allergyLine}${notesLine}

Chỉ tiêu MỖI NGÀY: ${targets.calories}kcal | P:${targets.protein}g | C:${targets.carbs}g | F:${targets.fat}g
Bữa ăn mỗi ngày: ${mealConfig.types.join(", ")}
Gợi ý nguồn đạm theo ngày: ${hintLines}

Danh sách thực phẩm (CHỈ CHỌN TRONG DANH SÁCH NÀY):
${candidatesBlock}

${this._buildRulesBlock(avoidLine, dayNumbers)}

Ví dụ JSON hợp lệ (mảng "days" phải có đủ ${dayNumbers.length} ngày):
{"days":[
  {"day_number":${first},"meals":${EXAMPLE_MEALS_JSON}}
]}

Trả về JSON hợp lệ (không markdown, không giải thích):`;

        // Same retry temperature policy as the single-day path
        const temperature = attemptNumber === 1 ? 0.2 : 0.4;
        const maxTokens = Math.min(MAX_TOKENS_PER_DAY * dayNumbers.length, MAX_TOKENS_PER_CALL);
        const messages: LLMMessage[] = [
            { role: "system", content: `${SYSTEM_ROLE}\n\n${BUSINESS_RULES}` },
            { role: "user", content: prompt },
        ];
        const response = await this.llm.generate(messages, { temperature, maxTokens });
        const parsed = await this._parseWithCorrection(
            BatchOutputSchema, messages, response.content, `Batch days ${first}-${last}`, maxTokens,
        );

        // Map returned days to requested day numbers (by day_number when valid, else by order)
        const byDay = new Map<number, z.infer<typeof BatchDaySchema>>();
        parsed.days.forEach((d, i) => {
            const dn = d.day_number != null && dayNumbers.includes(d.day_number) ? d.day_number : dayNumbers[i];
            if (dn != null && !byDay.has(dn)) byDay.set(dn, d);
        });

        return dayNumbers.map((day) => {
            const batchDay = byDay.get(day);
            if (!batchDay) {
                console.warn(`[MealPlanGenerator] Batch response missing day ${day} — will repair with single-day call`);
                return null;
            }

            const correctedMeals = this._correctMealCalories(batchDay.meals);

            const unsafeMeal = correctedMeals.find((m) => this._containsBlockedAllergen(m.food_name, allergyTerms));
            if (unsafeMeal) {
                console.warn(`[MealPlanGenerator] Day ${day}: meal "${unsafeMeal.food_name}" violates allergy constraints — will repair with single-day call`);
                return null;
            }

            const dayTotals = correctedMeals.reduce(
                (acc, m) => ({
                    calories: acc.calories + m.calories,
                    protein: acc.protein + m.protein,
                    carbs: acc.carbs + m.carbs,
                    fat: acc.fat + m.fat,
                }),
                { calories: 0, protein: 0, carbs: 0, fat: 0 },
            );

            const calDev = Math.abs(dayTotals.calories - targets.calories) / targets.calories;
            if (calDev > CAL_TOLERANCE) {
                console.warn(
                    `[MealPlanGenerator] Day ${day} calorie deviation ${(calDev * 100).toFixed(0)}% exceeds ` +
                    `${CAL_TOLERANCE * 100}% threshold (target ${targets.calories}, got ${dayTotals.calories}) — will repair with single-day call`,
                );
                return null;
            }

            return this._toDayPlan(day, correctedMeals, dayTotals, pool.foodLookup);
        });
    }

    // TODO(post-deploy): _createSystemRecipe is BLOCKED.
    // This method created Recipe documents with AI-estimated nutrition when the LLM
    // suggested a meal name not present in the DB. Those recipes were stored without
    // approval and corrupted the vector index with hallucinated data.
    // Re-enable only as a human-review queue: create recipe with needs_review=true,
    // surface in admin panel, require admin approval before embedding + serving.
    //
    // private async _createSystemRecipe(meal: MealItem): Promise<Types.ObjectId> { ... }

    private async _generateDay(
        day: number,
        targets: NutritionTotals,
        req: GenerateMealPlanRequest,
        recentFoodNames: string[],
        attemptNumber: number = 1,
        userBio?: string,
        overrideProteinHint?: string,
    ): Promise<GenerateDayResult> {
        const mealTypeTargets: Record<string, number> = {};
        // Value: { source_id, source_type, fdc_id }; keyed by both plain name and name+portionHint
        const foodLookup = new Map<string, { source_id: string; source_type: "food" | "recipe" | "usda" | "ai_generated"; fdc_id?: number }>();
        const mealTypeCandidates: MealTypeCandidates = new Map();
        // candidate strings per meal type (name + optional portion hint)
        const candidatesByMeal: Record<string, string> = {};

        const mealConfig = MEAL_CONFIGS[req.meals_per_day ?? 4];
        const cookingHint = req.cooking_style === "batch" ? "batch-cook one-pot reheat" : "fresh quick-prep";
        // Use override if a protein streak was detected on the previous day; otherwise rotate normally
        const proteinHint = overrideProteinHint ?? PROTEIN_ROTATIONS[(day - 1) % PROTEIN_ROTATIONS.length];
        const allergyTerms = this._buildAllergyTerms(req.preferences?.allergies);

        const searchResults = await Promise.all(
            mealConfig.types.map((mealType) => {
                const targetCal = Math.round(targets.calories * (mealConfig.dist[mealType] ?? 0.25));
                const query = `${mealType} ${req.preferences?.cuisine_preferences?.[0] ?? "Vietnamese"} ${GOAL_HINTS[req.goal]} ${cookingHint} ${proteinHint} ${targetCal}kcal`;
                return this.search.search({
                    query,
                    top_k: 8,
                    include_sources: ["food", "recipe", "usda"],
                    user_preferences: req.preferences as import("./FoodSearchService").UserPreferences | undefined,
                }).then((results) => ({
                    mealType,
                    results: results.filter((r) => !this._containsBlockedAllergen(r.name, allergyTerms)),
                }));
            }),
        );

        // P0-5: Check if ALL meal types have 0 verified candidates. We keep
        // generation alive with starter candidates below so early/dev DBs do not
        // make the core meal-plan feature feel broken.
        const allEmpty = searchResults.every(({ results }) => results.length === 0);
        if (allEmpty) {
            console.warn(`[MealPlanGenerator] Day ${day}: all vector candidates empty — using starter AI-generated candidates.`);
        }

        for (const { mealType, results } of searchResults) {
            const targetCal = Math.round(targets.calories * (mealConfig.dist[mealType] ?? 0.25));
            mealTypeTargets[mealType] = targetCal;

            const typedCandidates: CandidateEntry[] = [];
            const candidateNames: string[] = [];

            for (const r of results) {
                if (!r.name) continue;
                const portionHint = r.portions?.[0] ? ` [${r.portions[0].description}=${r.portions[0].gram_weight}g]` : "";
                const entry = {
                    source_id: r.source_id,
                    source_type: r.source_type as "food" | "recipe" | "usda",
                    fdc_id: r.fdc_id,
                };
                foodLookup.set(r.name.toLowerCase(), entry);
                if (portionHint) foodLookup.set((r.name + portionHint).toLowerCase(), entry);

                // Store actual DB nutrition so fallback meals use verified data
                typedCandidates.push({
                    source_id: r.source_id,
                    source_type: entry.source_type,
                    name: r.name,
                    energy_kcal: r.energy_kcal,
                    protein: r.protein,
                    carbs: r.glucid,
                    fat: r.lipid,
                    fiber: (r as any).fiber,
                });
                candidateNames.push(r.name + portionHint);
            }

            if (typedCandidates.length === 0) {
                const starterCandidates = this._starterCandidatesForMeal(mealType, req, allergyTerms);
                for (const starter of starterCandidates) {
                    foodLookup.set(starter.name.toLowerCase(), {
                        source_id: starter.source_id,
                        source_type: starter.source_type,
                    });
                    foodLookup.set(`${starter.name} [ước tính]`.toLowerCase(), {
                        source_id: starter.source_id,
                        source_type: starter.source_type,
                    });
                    typedCandidates.push(starter);
                    candidateNames.push(`${starter.name} [ước tính]`);
                }
            }

            candidatesByMeal[mealType] = candidateNames.join("; ");
            mealTypeCandidates.set(mealType, typedCandidates);
            if (typedCandidates.length === 0) {
                console.warn(`[MealPlanGenerator] Day ${day} ${mealType}: 0 candidates from vector search. Vector store may be empty.`);
            }
        }

        // FatSecret supplement — fills in meal types that have 0 vector search candidates.
        // Searches FatSecret v5 with an English query, translates names to Vietnamese,
        // upserts to local Food DB (so they appear in future vector searches), then adds
        // them to the candidate list for this day's prompt.
        if (FatSecretImportService.isAvailable()) {
            const sparseTypes = mealConfig.types.filter(
                (mt) => (mealTypeCandidates.get(mt)?.length ?? 0) === 0,
            );
            if (sparseTypes.length > 0) {
                const fsService  = getFatSecretService();
                const fsImport   = getFatSecretImportService();
                const translation = getTranslationService();

                await Promise.all(
                    sparseTypes.map(async (mealType) => {
                        try {
                            const mealHint = mealType.includes("snack") ? "snack" : mealType;
                            const query = `${proteinHint} ${mealHint} Vietnamese ${GOAL_HINTS[req.goal]}`;
                            const FATSECRET_TIMEOUT_MS = 3000;
                            const fsItems = await Promise.race([
                                fsService.searchFoodsV5(query, 8),
                                new Promise<never>((_, reject) =>
                                    setTimeout(() => reject(new Error("FatSecret timeout")), FATSECRET_TIMEOUT_MS),
                                ),
                            ]);
                            if (fsItems.length === 0) return;

                            // Translate English FatSecret names → Vietnamese in one batch
                            const enNames = fsItems.map((f) => f.food_name);
                            let viNames = enNames;
                            try {
                                viNames = await translation.translateBatch(enNames);
                            } catch { /* keep English on failure */ }

                            const typedCandidates = mealTypeCandidates.get(mealType) ?? [];
                            const extraNames: string[] = [];

                            for (let i = 0; i < fsItems.length; i++) {
                                const fs     = fsItems[i];
                                const viName = viNames[i] || fs.food_name;
                                if (this._containsBlockedAllergen(`${viName} ${fs.food_name}`, allergyTerms)) continue;
                                // Upsert synchronously so we get a real MongoDB _id
                                const food = await fsImport.upsertFromV5Food(fs, viName);
                                if (!food) continue;

                                const entry = {
                                    source_id:   (food._id as import("mongoose").Types.ObjectId).toString(),
                                    source_type: "food" as const,
                                };
                                foodLookup.set(viName.toLowerCase(), entry);
                                foodLookup.set(fs.food_name.toLowerCase(), entry);
                                typedCandidates.push({ ...entry, name: viName });
                                extraNames.push(viName);
                            }

                            mealTypeCandidates.set(mealType, typedCandidates);
                            if (extraNames.length > 0) {
                                const existing = candidatesByMeal[mealType] ?? "";
                                candidatesByMeal[mealType] = existing
                                    ? `${existing}; ${extraNames.join("; ")}`
                                    : extraNames.join("; ");
                            }
                        } catch (err) {
                            console.warn(
                                `[MealPlanGenerator] FatSecret supplement for ${mealType} failed:`,
                                err instanceof Error ? err.message : String(err),
                            );
                        }
                    }),
                );
            }
        }

        // TASK 8: rich user context for the prompt
        const cookingStyleLabel = req.cooking_style === "batch"
            ? "Nấu 1 lần ăn cả ngày (chỉ trong ngày hôm đó, không phải cả tuần)"
            : "Nấu tươi từng bữa";
        const dietaryLine = req.preferences?.dietary_preference
            ? `\n- Chế độ ăn: ${req.preferences.dietary_preference}` : "";
        const allergyLine = req.preferences?.allergies?.length
            ? `\n- Dị ứng/kiêng bắt buộc: ${req.preferences.allergies.join(", ")}` : "";
        const notesLine = req.preferences?.notes
            ? `\n- Ghi chú: ${req.preferences.notes}` : "";
        // Pass the full recent-names window (up to 60) so the LLM avoids repeating items
        const avoidLine = recentFoodNames.length
            ? `\n- KHÔNG ĐƯỢC chọn lại các món đã dùng gần đây: ${recentFoodNames.join(", ")}` : "";

        const candidatesBlock = Object.entries(candidatesByMeal)
            .map(([m, c]) => `[${m} — ~${mealTypeTargets[m]}kcal]\n${c}`)
            .join("\n\n");

        const bioline = userBio ? `\nNgười dùng: ${userBio}` : "";
        const prompt = `== Kế hoạch bữa ăn: Ngày ${day}/${req.duration_days} ==${bioline}
Mục tiêu: ${GOAL_LABELS[req.goal]} · ${cookingStyleLabel}${dietaryLine}${allergyLine}${notesLine}

Chỉ tiêu ngày: ${targets.calories}kcal | P:${targets.protein}g | C:${targets.carbs}g | F:${targets.fat}g
Bữa ăn: ${mealConfig.types.join(", ")}

Danh sách thực phẩm (CHỈ CHỌN TRONG DANH SÁCH NÀY):
${candidatesBlock}

${this._buildRulesBlock(avoidLine)}

Ví dụ JSON hợp lệ:
{"meals":${EXAMPLE_MEALS_JSON}}

Trả về JSON hợp lệ (không markdown, không giải thích):`;

        // F4: Increase temperature on retry attempts
        const temperature = attemptNumber === 1 ? 0.2 : 0.4;
        const messages: LLMMessage[] = [
            { role: "system", content: `${SYSTEM_ROLE}\n\n${BUSINESS_RULES}` },
            { role: "user", content: prompt },
        ];
        const response = await this.llm.generate(messages, { temperature, maxTokens: MAX_TOKENS_PER_DAY });

        const parsed = await this._parseWithCorrection(
            DayOutputSchema, messages, response.content, `Day ${day}`, MAX_TOKENS_PER_DAY,
        );

        const correctedMeals = this._correctMealCalories(parsed.meals);

        const unsafeMeal = correctedMeals.find((m) => this._containsBlockedAllergen(m.food_name, allergyTerms));
        if (unsafeMeal) {
            throw new Error(`Day ${day}: meal "${unsafeMeal.food_name}" violates allergy constraints — retrying`);
        }

        const dayTotals = correctedMeals.reduce(
            (acc, m) => ({
                calories: acc.calories + m.calories,
                protein: acc.protein + m.protein,
                carbs: acc.carbs + m.carbs,
                fat: acc.fat + m.fat,
            }),
            { calories: 0, protein: 0, carbs: 0, fat: 0 },
        );

        const calDev = Math.abs(dayTotals.calories - targets.calories) / targets.calories;
        if (calDev > CAL_TOLERANCE && attemptNumber < 3) {
            throw new Error(
                `Day ${day} calorie deviation ${(calDev * 100).toFixed(0)}% exceeds ${CAL_TOLERANCE * 100}% threshold ` +
                `(target ${targets.calories}, got ${dayTotals.calories}) — retrying`,
            );
        }
        if (calDev > CAL_TOLERANCE) {
            // Still over tolerance after all attempts — _adjustDayCalories will scale serving sizes
            console.warn(
                `[MealPlanGenerator] Day ${day} deviation ${(calDev * 100).toFixed(0)}% after ${attemptNumber} attempts — will scale servings`,
            );
        }
        // Use macro-corrected meals instead of raw LLM output
        const plan = this._toDayPlan(day, correctedMeals, dayTotals, foodLookup);

        return { plan, mealTypeCandidates };
    }

    private _uniqueStrings(values: Array<string | undefined | null>): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const value of values) {
            const cleaned = typeof value === "string" ? value.trim() : "";
            if (!cleaned) continue;
            const key = this._normalizeText(cleaned);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(cleaned);
        }
        return result;
    }

    private _normalizeText(value: string): string {
        return value
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/đ/g, "d")
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    private _buildAllergyTerms(allergies?: string[]): string[] {
        if (!allergies?.length) return [];
        const aliasGroups: string[][] = [
            ["peanut", "lac", "dau phong", "đậu phộng", "lạc"],
            ["seafood", "hai san", "hải sản", "tom", "tôm", "cua", "crab", "muc", "mực", "squid", "ngheu", "nghêu", "so", "sò", "hau", "hàu"],
            ["fish", "ca", "cá", "salmon", "tuna"],
            ["shrimp", "tom", "tôm"],
            ["crab", "cua"],
            ["egg", "trung", "trứng"],
            ["milk", "sua", "sữa", "dairy", "phomai", "pho mai", "cheese", "yogurt", "sua chua", "sữa chua"],
            ["soy", "dau nanh", "đậu nành", "tofu", "dau hu", "đậu hũ", "dau phu", "đậu phụ"],
            ["gluten", "wheat", "bot mi", "bột mì", "banh mi", "bánh mì", "mi", "mì"],
            ["beef", "bo", "bò"],
            ["pork", "heo", "lợn", "lon", "thit heo", "thịt heo"],
            ["chicken", "ga", "gà"],
            ["nuts", "hat", "hạt", "cashew", "hat dieu", "hạt điều", "almond", "hanh nhan", "hạnh nhân"],
        ];

        const normalizedAllergies = allergies.map((a) => this._normalizeText(a)).filter(Boolean);
        const terms = new Set<string>(normalizedAllergies);
        for (const allergy of normalizedAllergies) {
            for (const group of aliasGroups) {
                const normalizedGroup = group.map((term) => this._normalizeText(term));
                if (normalizedGroup.some((term) => allergy.includes(term) || term.includes(allergy))) {
                    normalizedGroup.forEach((term) => terms.add(term));
                }
            }
        }
        return [...terms].filter((term) => term.length >= 2);
    }

    private _containsBlockedAllergen(name: string | undefined, allergyTerms: string[]): boolean {
        if (!name || allergyTerms.length === 0) return false;
        const normalized = ` ${this._normalizeText(name)} `;
        return allergyTerms.some((term) => normalized.includes(` ${term} `));
    }

    private _starterCandidatesForMeal(
        mealType: string,
        req: GenerateMealPlanRequest,
        allergyTerms: string[],
    ): CandidateEntry[] {
        const key = mealType.includes("snack") ? "snack" : mealType;
        const candidates = STARTER_CANDIDATES[key] ?? STARTER_CANDIDATES.snack;
        const diet = req.preferences?.dietary_preference;
        return candidates
            .filter((c) => !this._containsBlockedAllergen(c.name, allergyTerms))
            .filter((c) => this._isDietCompatible(c.name, diet))
            .slice(0, 8);
    }

    private _isDietCompatible(name: string, diet?: string): boolean {
        if (!diet || diet === "omnivore") return true;
        const normalized = this._normalizeText(name);
        const meatTerms = ["ga", "bo", "heo", "lon", "thit", "ca", "tom", "cua", "muc", "hai san", "pork", "beef", "chicken", "fish", "shrimp"];
        const animalTerms = [...meatTerms, "trung", "sua", "sua chua", "pho mai", "egg", "milk", "yogurt", "cheese"];
        if (diet === "vegan") return !animalTerms.some((term) => normalized.includes(term));
        if (diet === "vegetarian") return !meatTerms.some((term) => normalized.includes(term));
        if (diet === "pescatarian") {
            const landMeatTerms = ["ga", "bo", "heo", "lon", "thit", "pork", "beef", "chicken"];
            return !landMeatTerms.some((term) => normalized.includes(term));
        }
        return true;
    }

    // Fire-and-forget Unsplash image fill for a day's ai_generated items.
    // ImageService enforces its own hourly quota (returns null / throws
    // UnsplashRateLimitError when exhausted) so this can never run away.
    private _fillCustomFoodImages(planId: Types.ObjectId, day: number): void {
        void (async () => {
            const items = await MealPlanItem.find({
                meal_plan_id: planId,
                day_number: day,
                source_type: "ai_generated",
                image_url: { $exists: false },
            }).select("_id custom_food").lean();

            for (const item of items) {
                const name = (item as { custom_food?: { name?: string } }).custom_food?.name;
                if (!name) continue;
                const result = await getImageService().fetchFoodImage(`${name} vietnamese food`);
                if (result?.url) {
                    await MealPlanItem.updateOne({ _id: item._id }, { $set: { image_url: result.url } });
                }
            }
        })().catch((err) => {
            // Rate limit or transient failure — items simply stay imageless
            console.warn(`[MealPlanGenerator] image fill day ${day}:`, err instanceof Error ? err.message : String(err));
        });
    }

    private _toCustomFood(meal: MealItem) {
        return {
            name: meal.food_name.replace(/\s*\[.*?\]$/, "").trim(),
            calories_kcal: meal.calories,
            protein_g: meal.protein,
            carbs_g: meal.carbs,
            fat_g: meal.fat,
            serving_description: `${meal.weight_grams}g`,
            description: "Ước tính bởi CaloVie để tạo bản nháp thực đơn khi dữ liệu món ăn chưa đủ.",
        };
    }

    // Mifflin-St Jeor TDEE. Returns null if required profile fields are missing.
    private _calculateTDEE(prefs: {
        weight_kg?: number;
        height_cm?: number;
        age?: number;
        gender?: string;
        activity_level?: string;
    }): number | null {
        const { weight_kg: w, height_cm: h, age, gender, activity_level } = prefs;
        if (!w || !h || !age || !gender) return null;

        const bmr = gender === "female"
            ? 10 * w + 6.25 * h - 5 * age - 161
            : 10 * w + 6.25 * h - 5 * age + 5;

        const factors: Record<string, number> = {
            sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, veryActive: 1.9,
        };
        return Math.round(bmr * (factors[activity_level ?? ""] ?? 1.55));
    }

    // Scale meals to hit calorie target before DB commit.
    // Returns adjusted meals + the scale factor (1 = no change).
    private _adjustDayCalories(
        meals: MealItem[],
        targets: NutritionTotals,
        day: number,
    ): { meals: MealItem[]; scaleFactor: number } {
        const totalCal  = meals.reduce((s, m) => s + m.calories, 0);
        const totalProt = meals.reduce((s, m) => s + m.protein,  0);
        const deviation = totalCal > 0 ? Math.abs(totalCal - targets.calories) / targets.calories : 1;

        if (totalProt < targets.protein * 0.75) {
            console.warn(`[MealPlanAudit] Day ${day}: protein ${totalProt.toFixed(0)}g vs target ${targets.protein}g — low protein.`);
        }
        if (deviation <= CAL_TOLERANCE) return { meals, scaleFactor: 1 };

        const rawScaleFactor = targets.calories / (totalCal || 1);
        const scaleFactor = Math.max(0.6, Math.min(1.8, rawScaleFactor));
        if (scaleFactor !== rawScaleFactor) {
            console.warn(`[MealPlanAudit] Day ${day}: requested scale ×${rawScaleFactor.toFixed(3)} clamped to ×${scaleFactor.toFixed(3)} to avoid unrealistic portions`);
        }
        console.log(`[MealPlanAudit] Day ${day}: scaling ×${scaleFactor.toFixed(3)} (${totalCal}→${targets.calories} kcal, ${(deviation * 100).toFixed(0)}% off)`);

        return {
            scaleFactor,
            meals: meals.map((m) => ({
                ...m,
                weight_grams: Math.round(Math.max(20, Math.min(1500, m.weight_grams * scaleFactor))),
                calories:     Math.round(m.calories     * scaleFactor),
                protein:      Math.round(m.protein      * scaleFactor * 10) / 10,
                carbs:        Math.round(m.carbs         * scaleFactor * 10) / 10,
                fat:          Math.round(m.fat           * scaleFactor * 10) / 10,
            })),
        };
    }

    // Returns the dominant protein source category for a day's meals.
    private _detectProteinSource(meals: MealItem[]): string {
        const keywords: [string, string[]][] = [
            ["poultry",  ["gà", "chicken", "vịt", "duck"]],
            ["beef",     ["bò", "beef"]],
            ["pork",     ["heo", "lợn", "pork", "sườn", "thịt ba chỉ"]],
            ["fish",     ["cá", "fish", "salmon", "cá hồi", "cá thu", "tuna", "cá ngừ"]],
            ["seafood",  ["tôm", "shrimp", "cua", "crab", "mực", "squid", "hải sản"]],
            ["egg",      ["trứng", "egg"]],
            ["legume",   ["đậu hũ", "tofu", "đậu phụ", "đậu xanh", "đậu đỏ", "bean", "legume", "nấm", "mushroom"]],
        ];
        const mainMeals = meals.filter((m) => m.meal_type === "lunch" || m.meal_type === "dinner");
        const counts: Record<string, number> = {};
        for (const meal of mainMeals) {
            const lower = meal.food_name.toLowerCase();
            for (const [source, kws] of keywords) {
                if (kws.some((k) => lower.includes(k))) {
                    counts[source] = (counts[source] ?? 0) + 1;
                    break;
                }
            }
        }
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        return sorted[0]?.[0] ?? "other";
    }

    // Finds the highest-fiber candidate not already used in this day's meals.
    // Returns null if no candidate has meaningful fiber data (>= 2g/100g).
    private _findHighFiberCandidate(
        mealTypeCandidates: MealTypeCandidates,
        existingMeals: MealItem[],
    ): CandidateEntry | null {
        const usedIds = new Set(existingMeals.map((m) => m.food_id).filter(Boolean));
        for (const mealType of ["dinner", "afternoon_snack", "snack"] as const) {
            const candidates = mealTypeCandidates.get(mealType) ?? [];
            const sorted = [...candidates]
                .filter((c) => c.source_type !== "ai_generated" && (c.fiber ?? 0) >= 2 && !usedIds.has(c.source_id))
                .sort((a, b) => (b.fiber ?? 0) - (a.fiber ?? 0));
            if (sorted.length > 0) {
                // Only auto-add if current day's fiber looks low — heuristic: no candidate in existing meals has fiber data
                const dayHasFiber = existingMeals.some((m) => {
                    const cands = mealTypeCandidates.get(m.meal_type) ?? [];
                    return cands.some((c) => c.source_id === m.food_id && (c.fiber ?? 0) >= 2);
                });
                if (!dayHasFiber) return sorted[0];
            }
        }
        return null;
    }
}

let _instance: MealPlanGeneratorService | null = null;
export function getMealPlanGeneratorService(): MealPlanGeneratorService {
    if (!_instance) _instance = new MealPlanGeneratorService();
    return _instance;
}
