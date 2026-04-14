import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { IUser } from "../models/User";
import User from "../models/User";
import FoodDiary from "../models/FoodDiary";
import Food from "../models/Food";
import Recipe from "../models/Recipe";
import AISuggestedFood from "../models/AISuggestedFood";
import rateLimit from "express-rate-limit";

const router = Router();

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests" },
});

function guessMealType(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 10) return "breakfast";
  if (hour >= 10 && hour < 14) return "lunch";
  if (hour >= 14 && hour < 17) return "snack";
  return "dinner";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanJson(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```json")) s = s.slice(7);
  if (s.startsWith("```")) s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3);
  return s.trim();
}

// POST /api/analyze-food
router.post(
  "/",
  authenticate,
  analyzeLimiter,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as IUser;
      const { imageBase64, language = "vi" } = req.body;

      if (!imageBase64) {
        res.status(400).json({ error: "imageBase64 is required" });
        return;
      }

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

      // ── Check scan limit ──
      const fullUser = await User.findById(user._id);
      const tier = fullUser?.subscription_tier || "free";
      const limits: Record<string, number> = { free: 2, premium: 5, pro: 9999 };
      const dailyLimit = limits[tier] || 2;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayCount = await FoodDiary.countDocuments({
        user_id: user._id,
        scanned_at: { $gte: today, $lt: tomorrow },
        image_url: { $ne: null },
      });

      if (todayCount >= dailyLimit) {
        res.status(429).json({
          error: "scan_limit_reached",
          limit: dailyLimit,
          used: todayCount,
          tier,
        });
        return;
      }

      // ── STEP 1: Gemini identify dish names ──
      const identifyPrompt =
        language === "vi"
          ? `Nhìn ảnh này và cho biết tên các món ăn/thức uống. Chỉ trả về JSON, không markdown:\n{"dishes": ["tên món 1", "tên món 2"]}`
          : `Look at this image and identify the food/drink names. Return JSON only, no markdown:\n{"dishes": ["dish name 1", "dish name 2"]}`;

      const identifyResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: identifyPrompt },
                  {
                    inline_data: {
                      mime_type: "image/jpeg",
                      data: imageBase64.replace(/^data:image\/\w+;base64,/, ""),
                    },
                  },
                ],
              },
            ],
            generationConfig: { temperature: 0.1 },
          }),
        },
      );

      if (!identifyResponse.ok) {
        if (identifyResponse.status === 429) {
          res.status(429).json({ error: "AI rate limit. Try again later." });
          return;
        }
        throw new Error(`AI error: ${identifyResponse.status}`);
      }

      const identifyData = (await identifyResponse.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const identifyText =
        identifyData.candidates?.[0]?.content?.parts?.[0]?.text || "";

      let dishes: string[] = [];
      try {
        const parsed = JSON.parse(cleanJson(identifyText)) as { dishes?: string[] };
        dishes = parsed.dishes || [];
      } catch {
        dishes = [identifyText.trim()];
      }

      if (dishes.length === 0) throw new Error("Could not identify any food");

      // ── STEP 2: Search DB for each dish (Recipe → Food → AISuggestedFood) ──
      const results: Record<string, unknown>[] = [];

      for (const dish of dishes) {
        const q = dish.toLowerCase().trim();
        let matched = false;

        // 2a. Search approved recipes — exact name match only
        const exactPattern = new RegExp(`^${escapeRegex(q)}$`, "i");
        const recipeHits = await Recipe.find({
          is_approved: true,
          is_deleted: { $ne: true },
          $or: [
            { name_vi: { $regex: exactPattern } },
            { tags: { $in: [q] } },
          ],
        }).limit(3);

        if (recipeHits.length) {
          const best = recipeHits.sort((a, b) => {
            const aExact = a.name_vi.toLowerCase() === q ? 1 : 0;
            const bExact = b.name_vi.toLowerCase() === q ? 1 : 0;
            return bExact - aExact;
          })[0];

          results.push({
            dish_name: dish,
            source: "recipe",
            matched_name: best.name_vi,
            nutrition: {
              calories: best.calories || 0,
              protein: best.protein || 0,
              carbs: best.carbs || 0,
              fat: best.fat || 0,
              fiber: best.fiber || 0,
            },
            servings: best.servings || 1,
            weight_grams: null,
          });
          matched = true;
          continue;
        }

        // 2b. Search foods — exact name match only
        const foodHit = await Food.findOne({
          is_deleted: { $ne: true },
          $or: [
            { name_vi: { $regex: exactPattern } },
            { search_keywords: { $in: [q] } },
          ],
        });

        if (foodHit) {
          const refWeight = 100;
          results.push({
            dish_name: dish,
            source: "food",
            matched_name: foodHit.name_vi,
            nutrition: {
              calories: Math.round((foodHit.energy_kcal || 0) * refWeight / 100),
              protein: Math.round((foodHit.protein || 0) * refWeight / 100),
              carbs: Math.round((foodHit.glucid || 0) * refWeight / 100),
              fat: Math.round((foodHit.lipid || 0) * refWeight / 100),
              fiber: Math.round((foodHit.fiber || 0) * refWeight / 100),
            },
            weight_grams: refWeight,
          });
          matched = true;
          continue;
        }

        // 2c. Search AISuggestedFood cache — exact name match only
        const aiCacheHit = await AISuggestedFood.findOne({
          name: { $regex: exactPattern },
        });

        if (aiCacheHit) {
          const refWeight = aiCacheHit.reference_weight_grams;
          results.push({
            dish_name: dish,
            source: "ai_estimate",
            matched_name: aiCacheHit.name,
            nutrition: {
              calories: Math.round(aiCacheHit.calories_per_100g * refWeight / 100),
              protein: Math.round(aiCacheHit.protein_per_100g * refWeight / 100),
              carbs: Math.round(aiCacheHit.carbs_per_100g * refWeight / 100),
              fat: Math.round(aiCacheHit.fat_per_100g * refWeight / 100),
              fiber: Math.round(aiCacheHit.fiber_per_100g * refWeight / 100),
            },
            weight_grams: refWeight,
          });
          // Increment seen counter (fire-and-forget)
          AISuggestedFood.updateOne({ _id: aiCacheHit._id }, { $inc: { times_seen: 1 } }).exec();
          matched = true;
          continue;
        }

        if (!matched) {
          results.push({
            dish_name: dish,
            source: "none",
            matched_name: null,
            nutrition: null,
            weight_grams: null,
          });
        }
      }

      // ── STEP 3: AI estimate for unmatched + save to AISuggestedFood ──
      const unmatched = results.filter((r) => r.source === "none");
      if (unmatched.length > 0) {
        const unmatchedNames = unmatched.map((r) => r.dish_name).join(", ");
        const nutritionPrompt =
          language === "vi"
            ? `Ước tính dinh dưỡng cho 1 phần ăn thực tế của các món sau: ${unmatchedNames}\n\nTrả về JSON (không markdown), dinh dưỡng tính trên 100g:\n{"items": [{"name": "tên món", "weight_grams": 300, "calories_per_100g": 150, "protein_per_100g": 12, "carbs_per_100g": 20, "fat_per_100g": 5, "fiber_per_100g": 2}]}`
            : `Estimate nutrition for one realistic serving of: ${unmatchedNames}\n\nReturn JSON (no markdown), nutrition values per 100g:\n{"items": [{"name": "dish name", "weight_grams": 300, "calories_per_100g": 150, "protein_per_100g": 12, "carbs_per_100g": 20, "fat_per_100g": 5, "fiber_per_100g": 2}]}`;

        const nutResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: nutritionPrompt }] }],
              generationConfig: { temperature: 0.2 },
            }),
          },
        );

        if (nutResponse.ok) {
          const nutData = (await nutResponse.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          const nutText =
            nutData.candidates?.[0]?.content?.parts?.[0]?.text || "";

          try {
            const parsed = JSON.parse(cleanJson(nutText)) as {
              items?: {
                name?: string;
                weight_grams?: number;
                calories_per_100g?: number;
                protein_per_100g?: number;
                carbs_per_100g?: number;
                fat_per_100g?: number;
                fiber_per_100g?: number;
              }[];
            };

            if (parsed.items) {
              for (const aiItem of parsed.items) {
                const target = results.find(
                  (r) =>
                    r.source === "none" &&
                    (r.dish_name as string)
                      .toLowerCase()
                      .includes((aiItem.name || "").toLowerCase()),
                );
                if (target) {
                  const cal100 = aiItem.calories_per_100g || 0;
                  const pro100 = aiItem.protein_per_100g || 0;
                  const carb100 = aiItem.carbs_per_100g || 0;
                  const fat100 = aiItem.fat_per_100g || 0;
                  const fib100 = aiItem.fiber_per_100g || 0;
                  const weight = aiItem.weight_grams || 300;

                  target.source = "ai_estimate";
                  target.matched_name = aiItem.name || target.dish_name;
                  target.weight_grams = weight;
                  target.nutrition = {
                    calories: Math.round(cal100 * weight / 100),
                    protein: Math.round(pro100 * weight / 100),
                    carbs: Math.round(carb100 * weight / 100),
                    fat: Math.round(fat100 * weight / 100),
                    fiber: Math.round(fib100 * weight / 100),
                  };

                  // Save to AISuggestedFood cache (upsert)
                  AISuggestedFood.findOneAndUpdate(
                    { name: (aiItem.name || target.dish_name) as string },
                    {
                      $set: {
                        calories_per_100g: cal100,
                        protein_per_100g: pro100,
                        carbs_per_100g: carb100,
                        fat_per_100g: fat100,
                        fiber_per_100g: fib100,
                        reference_weight_grams: weight,
                      },
                      $inc: { times_seen: 1 },
                    },
                    { upsert: true, new: true },
                  ).exec();
                }
              }
            }
          } catch {
            /* fallback below */
          }
        }

        // Fallback for still-unmatched
        for (const r of results) {
          if (r.source === "none") {
            r.source = "ai_estimate";
            r.matched_name = r.dish_name;
            r.weight_grams = 300;
            r.nutrition = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
          }
        }
      }

      // ── STEP 4: Calculate totals ──
      const totals = results.reduce(
        (sum, r) => {
          const n = r.nutrition as Record<string, number> | null;
          return {
            calories: sum.calories + (n?.calories || 0),
            protein: sum.protein + (n?.protein || 0),
            carbs: sum.carbs + (n?.carbs || 0),
            fat: sum.fat + (n?.fat || 0),
            fiber: sum.fiber + (n?.fiber || 0),
          };
        },
        { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
      );

      // ── STEP 5: Estimate vitamins/minerals for the whole meal ──
      type VitaminEntry = { name: string; amount: number; unit: string; percent_dv: number };
      let vitamins: VitaminEntry[] = [];

      const mealSummary = results
        .map((r) => `${r.matched_name || r.dish_name} (${(r.weight_grams as number) || 300}g)`)
        .join(", ");

      const vitaminList = language === "vi"
        ? "Vitamin A, Vitamin C, Vitamin D, Vitamin E, Vitamin B1 (Thiamine), Vitamin B2 (Riboflavin), Vitamin B3 (Niacin), Vitamin B12, Canxi, Sắt, Kali, Magie, Kẽm, Natri, Phốt pho"
        : "Vitamin A, Vitamin C, Vitamin D, Vitamin E, Vitamin B1 (Thiamine), Vitamin B2 (Riboflavin), Vitamin B3 (Niacin), Vitamin B12, Calcium, Iron, Potassium, Magnesium, Zinc, Sodium, Phosphorus";

      const vitaminPrompt = language === "vi"
        ? `Ước tính vitamin và khoáng chất cho bữa ăn gồm: ${mealSummary}\n\nChỉ trả về JSON (không markdown), giá trị tổng cho toàn bữa:\n{"vitamins": [{"name": "Vitamin C", "amount": 15, "unit": "mg", "percent_dv": 17}]}\n\nCần ước tính: ${vitaminList}`
        : `Estimate vitamins and minerals for a meal of: ${mealSummary}\n\nReturn JSON only (no markdown), total values for the whole meal:\n{"vitamins": [{"name": "Vitamin C", "amount": 15, "unit": "mg", "percent_dv": 17}]}\n\nEstimate: ${vitaminList}`;

      try {
        const vitResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: vitaminPrompt }] }],
              generationConfig: { temperature: 0.1 },
            }),
          },
        );
        if (vitResponse.ok) {
          const vitData = (await vitResponse.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          const vitText = vitData.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const parsed = JSON.parse(cleanJson(vitText)) as {
            vitamins?: { name?: string; amount?: number; unit?: string; percent_dv?: number }[];
          };
          if (parsed.vitamins) {
            vitamins = parsed.vitamins
              .filter((v) => v.name && v.amount != null)
              .map((v) => ({
                name: v.name!,
                amount: v.amount!,
                unit: v.unit || "mg",
                percent_dv: v.percent_dv || 0,
              }));
          }
        }
      } catch { /* vitamins stay empty */ }

      res.json({ dishes: results, totals, vitamins, meal_type: guessMealType() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

export default router;
