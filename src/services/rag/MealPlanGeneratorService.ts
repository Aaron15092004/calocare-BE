import { z } from "zod";
import { Types } from "mongoose";
import { getLLMService, LLMMessage } from "./LLMService";
import { getFoodSearchService } from "./FoodSearchService";
import { getEnrichmentService } from "./EnrichmentService";
import { getFatSecretService } from "./FatSecretService";
import { getFatSecretImportService, FatSecretImportService } from "./FatSecretImportService";
import { getTranslationService } from "./TranslationService";
import MealPlan from "../../models/MealPlan";
import MealPlanItem from "../../models/MealPlanItem";
import User from "../../models/User";

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
    source_type?: "food" | "recipe" | "usda";
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
    source_type: "food" | "recipe" | "usda";
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

export class MealPlanGeneratorService {
    private readonly llm = getLLMService();
    private readonly search = getFoodSearchService();
    private readonly enrichment = getEnrichmentService();

    async generate(
        req: GenerateMealPlanRequest,
        onProgress: (event: "progress" | "day" | "done" | "error", data: unknown) => void,
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
        if (diet && diet !== "omnivore") bioLines.push(`chế độ ăn: ${diet}`);
        if (allergies?.length) bioLines.push(`tránh: ${allergies.join(", ")}`);
        const userBio = bioLines.length ? bioLines.join(" · ") : undefined;

        // Create MealPlan record
        const plan = await MealPlan.create({
            title: `Kế hoạch ${req.goal === "weight_loss" ? "giảm cân" : req.goal === "muscle_gain" ? "tăng cơ" : "duy trì"} ${req.duration_days} ngày`,
            total_days: req.duration_days,
            goal_type: req.goal,
            is_public: false,
            is_approved: false,
            creator_id: new Types.ObjectId(req.userId),
        });

        const recentFoodNames: string[] = [];
        const proteinSourceLog: string[] = [];
        let nextDayProteinHint: string | undefined;
        const days: DayPlan[] = [];
        const sourceBreakdown = { usda: 0, recipe: 0, food: 0, ai_generated: 0 };
        const recipeIdsForEnrichment = new Set<string>();

        for (let day = 1; day <= req.duration_days; day++) {
            onProgress("progress", { current_day: day, total_days: req.duration_days });

            let result: GenerateDayResult | null = null;
            let attempts = 0;

            while (!result && attempts < 3) {
                attempts++;
                try {
                    result = await this._generateDay(
                        day,
                        dailyTargets,
                        req,
                        recentFoodNames,
                        attempts,
                        userBio,
                        nextDayProteinHint,
                    );
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[MealPlanGenerator] Day ${day} attempt ${attempts} failed:`, msg, { userId: req.userId, goal: req.goal, mealsPerDay: req.meals_per_day });
                }
            }

            if (!result) continue;

            let { plan: dayPlan, mealTypeCandidates } = result;

            // TASK 4: Sync enrich USDA items → create real Food records from USDA data
            const usdaMeals = dayPlan.meals.filter((m) => m.source_type === "usda" && m.fdc_id != null);
            // UsdaFood source_id → enriched Recipe._id (processJob now returns Recipe._id)
            const enrichedRecipeIds = new Map<string, Types.ObjectId>();
            if (usdaMeals.length > 0) {
                const chunkSize = 5;
                for (let ci = 0; ci < usdaMeals.length; ci += chunkSize) {
                    const chunk = usdaMeals.slice(ci, ci + chunkSize);
                    await Promise.all(
                        chunk.map(async (m) => {
                            try {
                                const recipeObjId = await this.enrichment.processJob(m.fdc_id!, false);
                                if (recipeObjId && m.food_id) {
                                    enrichedRecipeIds.set(m.food_id, recipeObjId);
                                }
                            } catch (err) {
                                console.warn(`[MealPlanGenerator] Sync enrich fdc_id=${m.fdc_id}:`, err instanceof Error ? err.message : String(err));
                            }
                        }),
                    );
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

                if (meal.food_id && meal.source_type) {
                    source_type = meal.source_type;
                    if (meal.source_type === "recipe") {
                        recipe_id = new Types.ObjectId(meal.food_id);
                    } else if (meal.source_type === "usda") {
                        usda_food_id = new Types.ObjectId(meal.food_id);
                        const enriched = enrichedRecipeIds.get(meal.food_id);
                        if (enriched) {
                            recipe_id = enriched; // enriched USDA dish → Recipe._id
                        }
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
                    }
                }

                // Track source breakdown for logging
                const st = (source_type ?? "ai_generated") as keyof typeof sourceBreakdown;
                sourceBreakdown[st] = (sourceBreakdown[st] ?? 0) + 1;

                if (recipe_id) recipeIdsForEnrichment.add(recipe_id.toString());

                itemsToInsert.push({
                    meal_plan_id: plan._id,
                    day_number: day,
                    meal_type: meal.meal_type,
                    recipe_id,
                    food_id,
                    usda_food_id,
                    source_type,
                    serving_size: meal.weight_grams,
                    calories: meal.calories,
                    sort_order: i,
                });
            }

            if (itemsToInsert.length === 0) {
                console.warn(`[MealPlanGenerator] Day ${day}: 0 items to insert — all meals skipped (no DB candidates). Check vector store has data.`);
                continue;
            }

            // Scale serving sizes BEFORE commit so stored data is already calibrated
            const { meals: adjustedMeals, scaleFactor } = this._adjustDayCalories(dayPlan.meals, dailyTargets, day);
            if (scaleFactor !== 1) {
                const typedItems = itemsToInsert as Array<{ serving_size: number; calories: number }>;
                for (const item of typedItems) {
                    item.serving_size = Math.round(item.serving_size * scaleFactor);
                    item.calories     = Math.round(item.calories     * scaleFactor);
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
                    meal_plan_id: plan._id,
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

            // Protein diversity: track source, log streak, override hint for next day
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
            } else {
                nextDayProteinHint = undefined;
            }

            days.push(dayPlan);
            recentFoodNames.push(...dayPlan.meals.map((m) => m.food_name));
            // Keep up to 120 recent names (21 days × 5 meals = 105 + buffer).
            if (recentFoodNames.length > 120) recentFoodNames.splice(0, 10);

            onProgress("day", {
                day_number: day,
                plan: dayPlan,
                substitutions: dayPlan.substitutions,
            });
        }

        // Queue recipe enrichment for all recipes used in this plan
        if (recipeIdsForEnrichment.size > 0) {
            this.enrichment
                .queueRecipeEnrichment([...recipeIdsForEnrichment], { type: "meal_plan" })
                .catch((err) => console.warn("[MealPlanGenerator] queue recipe enrichment error:", err));
        }

        const planId = (plan._id as Types.ObjectId).toString();
        onProgress("done", { meal_plan_id: planId, days_generated: days.length, source_breakdown: sourceBreakdown });
        return { planId, source_breakdown: sourceBreakdown };
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
        const foodLookup = new Map<string, { source_id: string; source_type: "food" | "recipe" | "usda"; fdc_id?: number }>();
        const mealTypeCandidates: MealTypeCandidates = new Map();
        // candidate strings per meal type (name + optional portion hint)
        const candidatesByMeal: Record<string, string> = {};

        const mealConfig = MEAL_CONFIGS[req.meals_per_day ?? 4];
        const cookingHint = req.cooking_style === "batch" ? "batch-cook one-pot reheat" : "fresh quick-prep";
        // Use override if a protein streak was detected on the previous day; otherwise rotate normally
        const proteinHint = overrideProteinHint ?? PROTEIN_ROTATIONS[(day - 1) % PROTEIN_ROTATIONS.length];

        const searchResults = await Promise.all(
            mealConfig.types.map((mealType) => {
                const targetCal = Math.round(targets.calories * (mealConfig.dist[mealType] ?? 0.25));
                const query = `${mealType} ${req.preferences?.cuisine_preferences?.[0] ?? "Vietnamese"} ${GOAL_HINTS[req.goal]} ${cookingHint} ${proteinHint} ${targetCal}kcal`;
                return this.search.search({
                    query,
                    top_k: 8,
                    include_sources: ["food", "recipe", "usda"],
                    user_preferences: req.preferences as import("./FoodSearchService").UserPreferences | undefined,
                }).then((results) => ({ mealType, results }));
            }),
        );

        // P0-5: Check if ALL meal types have 0 candidates
        const allEmpty = searchResults.every(({ results }) => results.length === 0);
        if (allEmpty) {
            throw new Error(`Day ${day}: ALL meal types have 0 candidates from vector search. Vector store may be empty.`);
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
Mục tiêu: ${GOAL_LABELS[req.goal]} · ${cookingStyleLabel}${dietaryLine}${notesLine}

Chỉ tiêu ngày: ${targets.calories}kcal | P:${targets.protein}g | C:${targets.carbs}g | F:${targets.fat}g
Bữa ăn: ${mealConfig.types.join(", ")}

Danh sách thực phẩm (CHỈ CHỌN TRONG DANH SÁCH NÀY):
${candidatesBlock}

QUY TẮC BẮT BUỘC:
1. food_name copy CHÍNH XÁC từ danh sách (kể cả [...] nếu có)
2. Calories/protein/carbs/fat = TỔNG cho khẩu phần (không phải per 100g)
3. SỐ MÓN THEO TỪNG BỮA (văn hóa VN thực tế):
   · breakfast: 1 món đơn lẻ (phở/bún/bánh mì/cháo/xôi/cơm tấm — CHỈ 1 dòng)
   · morning_snack / afternoon_snack / snack: 1 món nhẹ (trái cây/sữa chua/hạt/sữa)
   · lunch: 1–2 món (1 đơn lẻ HOẶC cơm + 1 protein)
   · dinner: 2–3 món (cơm + protein + canh/rau — lặp meal_type để thêm)
4. cooking_steps: 2–4 bước nấu ngắn gọn thực tế bằng tiếng Việt
5. Tổng calories mỗi bữa ±20% mục tiêu
6. Đa dạng nguồn protein, không lặp cùng loại đạm trong ngày${avoidLine}

Ví dụ JSON hợp lệ:
{"meals":[
  {"meal_type":"breakfast","food_name":"Phở bò","weight_grams":400,"calories":450,"protein":25,"carbs":60,"fat":12,"cooking_steps":["Đun nước dùng xương bò sôi","Chan nước nóng vào tô bún, bày thịt bò tái","Thêm hành lá, rau thơm, chanh, ớt"]},
  {"meal_type":"snack","food_name":"Chuối","weight_grams":120,"calories":107,"protein":1,"carbs":27,"fat":0,"cooking_steps":["Bóc vỏ, ăn trực tiếp"]},
  {"meal_type":"lunch","food_name":"Cơm trắng","weight_grams":200,"calories":260,"protein":5,"carbs":58,"fat":1,"cooking_steps":["Vo gạo sạch, nấu cơm tỉ lệ 1:1.5"]},
  {"meal_type":"lunch","food_name":"Gà kho gừng","weight_grams":120,"calories":185,"protein":22,"carbs":3,"fat":9,"cooking_steps":["Ướp gà với gừng, nước mắm, đường 15 phút","Kho lửa vừa 20 phút đến khi nước sệt"]},
  {"meal_type":"dinner","food_name":"Cơm trắng","weight_grams":180,"calories":234,"protein":4,"carbs":52,"fat":1,"cooking_steps":["Nấu cơm"]},
  {"meal_type":"dinner","food_name":"Cá hồi áp chảo","weight_grams":150,"calories":250,"protein":30,"carbs":0,"fat":14,"cooking_steps":["Ướp cá với muối, tiêu, chanh 10 phút","Áp chảo mỗi mặt 3–4 phút lửa vừa"]},
  {"meal_type":"dinner","food_name":"Canh rau ngót","weight_grams":200,"calories":45,"protein":3,"carbs":7,"fat":1,"cooking_steps":["Lặt rau, rửa sạch","Nấu sôi nước, cho rau vào 5 phút, nêm muối"]}
]}

Trả về JSON hợp lệ (không markdown, không giải thích):`;

        // F4: Increase temperature on retry attempts
        const temperature = attemptNumber === 1 ? 0.2 : 0.4;
        const messages: LLMMessage[] = [
            { role: "system", content: `${SYSTEM_ROLE}\n\n${BUSINESS_RULES}` },
            { role: "user", content: prompt },
        ];
        const response = await this.llm.generate(messages, { temperature, maxTokens: 3500 });

        const cleanJson = (raw: string) => raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const text = cleanJson(response.content);
        let parsed: z.infer<typeof DayOutputSchema>;
        try {
            parsed = DayOutputSchema.parse(JSON.parse(text));
        } catch {
            // Give the LLM one correction chance before throwing to the outer retry loop
            console.warn(`[MealPlanGenerator] Day ${day} JSON parse failed — sending correction. Raw (200): ${text.slice(0, 200)}`);
            const correctionMessages: LLMMessage[] = [
                ...messages,
                { role: "assistant", content: response.content },
                { role: "user", content: "Phản hồi trên không phải JSON hợp lệ. Trả về JSON thuần túy duy nhất, bắt đầu bằng { và kết thúc bằng }, không có markdown, không có giải thích." },
            ];
            const correctionResp = await this.llm.generate(correctionMessages, { temperature: 0.1, maxTokens: 3500 });
            const correctedText = cleanJson(correctionResp.content);
            try {
                parsed = DayOutputSchema.parse(JSON.parse(correctedText));
            } catch (parseErr) {
                console.error(`[MealPlanGenerator] Day ${day} JSON still invalid after correction. Raw (500): ${correctedText.slice(0, 500)}`);
                throw parseErr;
            }
        }

        // Recalculate calories from macros (ground truth) and correct LLM's reported values.
        // LLM often reports calories independently of macros; macros are more reliable.
        const correctedMeals = parsed.meals.map((m) => {
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
        parsed = { meals: correctedMeals };

        const plan: DayPlan = {
            day_number: day,
            substitutions: [],
            meals: parsed.meals.map((m) => {
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

        return { plan, mealTypeCandidates };
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

        const scaleFactor = targets.calories / (totalCal || 1);
        console.log(`[MealPlanAudit] Day ${day}: scaling ×${scaleFactor.toFixed(3)} (${totalCal}→${targets.calories} kcal, ${(deviation * 100).toFixed(0)}% off)`);

        return {
            scaleFactor,
            meals: meals.map((m) => ({
                ...m,
                weight_grams: Math.round(m.weight_grams * scaleFactor),
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
                .filter((c) => (c.fiber ?? 0) >= 2 && !usedIds.has(c.source_id))
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
