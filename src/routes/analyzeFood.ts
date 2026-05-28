import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { ragRateLimit } from "../middleware/ragRateLimit";
import { IUser } from "../models/User";
import Food from "../models/Food";
import Recipe from "../models/Recipe";
import AISuggestedFood from "../models/AISuggestedFood";
import UsdaFood from "../models/UsdaFood";
import { getFatSecretService } from "../services/rag/FatSecretService";
import {
  getFatSecretImportService,
  FatSecretImportService,
} from "../services/rag/FatSecretImportService";

const router = Router();

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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

async function callGemini(apiKey: string, body: object): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
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
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      if (res.status === 429)
        throw Object.assign(
          new Error(`Gemini rate limit${errorBody ? ` - ${errorBody.slice(0, 300)}` : ""}`),
          { status: 429 },
        );
      throw new Error(`Gemini error: ${res.status}${errorBody ? ` - ${errorBody.slice(0, 300)}` : ""}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/analyze-food
router.post(
  "/",
  authenticate,
  ragRateLimit("scan"),
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

      const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

      // ── Step 1: Gemini identifies dishes with both Vi+En names + gram weights ──
      // Gemini returns both languages directly — no separate translation step needed.
      const identifyPrompt =
        `Identify every food/drink item in this image. Estimate each portion weight in grams from visual portion size. Return ONLY JSON, no markdown:\n` +
        `{"dishes":[{"name_vi":"Gỏi cuốn","name_en":"fresh spring rolls","weight_grams":300}]}`;

      let identifyText: string;
      try {
        identifyText = await callGemini(GEMINI_API_KEY, {
          contents: [
            {
              role: "user",
              parts: [
                { text: identifyPrompt },
                { inline_data: { mime_type: "image/jpeg", data: cleanBase64 } },
              ],
            },
          ],
          generationConfig: { temperature: 0.1 },
        });
      } catch (err: any) {
        if (err.status === 429) {
          console.error("[analyzeFood] Gemini 429:", err.message);
          res.status(429).json({ error: err.message || "Gemini rate limit. Try again later." });
          return;
        }
        throw err;
      }

      type IdentifiedDish = { name_vi: string; name_en: string; weight_grams: number };
      let identifiedDishes: IdentifiedDish[] = [];
      try {
        const parsed = JSON.parse(cleanJson(identifyText)) as { dishes?: unknown[] };
        identifiedDishes = ((parsed.dishes || []) as any[])
          .map((d) => ({
            name_vi: ((d.name_vi || d.name || "") as string).trim(),
            name_en: ((d.name_en || d.name || "") as string).trim(),
            weight_grams: Math.max(10, (d.weight_grams as number) || 200),
          }))
          .filter((d) => d.name_vi.length > 0 || d.name_en.length > 0);
      } catch {
        identifiedDishes = [];
      }

      if (identifiedDishes.length === 0) throw new Error("Could not identify any food");

      // ── Step 2: Search pipeline per dish ─────────────────────────────────
      // Order: FatSecret v5 → Recipe → Food DB → AI cache → USDA → (none → AI estimate)
      const results: Record<string, unknown>[] = [];
      const fatsecretAvailable = FatSecretImportService.isAvailable();

      for (const dish of identifiedDishes) {
        const q_vi = dish.name_vi.toLowerCase().trim();
        const q_en = dish.name_en.toLowerCase().trim();
        const patternVi = new RegExp(escapeRegex(q_vi), "i");
        const patternEn = new RegExp(escapeRegex(q_en), "i");
        const g = dish.weight_grams;
        const displayName = dish.name_vi || dish.name_en;

        // 2a. FatSecret v5 — English name, no region filtering on Premier Free plan
        if (fatsecretAvailable && q_en) {
          try {
            const fsItems = await getFatSecretService().searchFoodsV5(q_en, 5);
            let fsMatched = false;
            for (const fs of fsItems) {
              const per100g = getFatSecretService().extractPer100g(fs);
              if (!per100g) continue;
              results.push({
                dish_name: displayName,
                source: "fatsecret",
                matched_name: displayName,   // Vietnamese name from Gemini
                fs_food_id: fs.food_id ?? null,
                weight_grams: g,
                nutrition: {
                  calories: Math.round((per100g.energy_kcal * g) / 100),
                  protein: Math.round(((per100g.protein * g) / 100) * 10) / 10,
                  carbs:   Math.round(((per100g.glucid   * g) / 100) * 10) / 10,
                  fat:     Math.round(((per100g.lipid    * g) / 100) * 10) / 10,
                  fiber:   Math.round(((per100g.fiber    * g) / 100) * 10) / 10,
                },
              });
              // Background upsert using v5 data already in hand (no extra API call)
              getFatSecretImportService()
                .upsertFromV5Food(fs, displayName)
                .catch(() => {});
              fsMatched = true;
              break;
            }
            if (fsMatched) continue;
          } catch { /* fall through */ }
        }

        // 2b. Recipe match (both names)
        const recipeHits = await Recipe.find({
          is_approved: true,
          is_deleted: { $ne: true },
          $or: [
            { name_vi: { $regex: patternVi } },
            { name_en: { $regex: patternEn } },
            { tags: { $in: [q_vi] } },
          ],
        }).limit(5);

        if (recipeHits.length) {
          const scoreRecipe = (r: (typeof recipeHits)[0]) => {
            const vi = r.name_vi.toLowerCase();
            const en = (r.name_en || "").toLowerCase();
            if (vi === q_vi || en === q_en) return 3;
            if (vi.startsWith(q_vi) || en.startsWith(q_en)) return 2;
            return 1;
          };
          const best = recipeHits.sort((a, b) => scoreRecipe(b) - scoreRecipe(a))[0];
          results.push({
            dish_name: displayName,
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
          continue;
        }

        // 2c. Food DB (local, both names)
        const foodHit = await Food.findOne({
          is_deleted: { $ne: true },
          $or: [
            { name_vi: { $regex: patternVi } },
            { name_en: { $regex: patternEn } },
            { search_keywords: { $in: [q_vi, q_en] } },
          ],
        });

        if (foodHit) {
          results.push({
            dish_name: displayName,
            source: "food",
            matched_name: foodHit.name_vi,
            nutrition: {
              calories: Math.round(((foodHit.energy_kcal || 0) * g) / 100),
              protein: Math.round(((foodHit.protein || 0) * g) / 100),
              carbs:   Math.round(((foodHit.glucid   || 0) * g) / 100),
              fat:     Math.round(((foodHit.lipid    || 0) * g) / 100),
              fiber:   Math.round(((foodHit.fiber    || 0) * g) / 100),
            },
            weight_grams: g,
          });
          continue;
        }

        // 2d. AI Suggested Food cache (from prior Gemini estimates)
        const aiCacheHit = await AISuggestedFood.findOne({
          $or: [
            { name: { $regex: patternVi } },
            { name: { $regex: patternEn } },
          ],
        });

        if (aiCacheHit) {
          const refWeight = g > 0 ? g : aiCacheHit.reference_weight_grams;
          results.push({
            dish_name: displayName,
            source: "ai_estimate",
            matched_name: aiCacheHit.name,
            nutrition: {
              calories: Math.round((aiCacheHit.calories_per_100g * refWeight) / 100),
              protein: Math.round((aiCacheHit.protein_per_100g * refWeight) / 100),
              carbs:   Math.round((aiCacheHit.carbs_per_100g * refWeight) / 100),
              fat:     Math.round((aiCacheHit.fat_per_100g * refWeight) / 100),
              fiber:   Math.round((aiCacheHit.fiber_per_100g * refWeight) / 100),
            },
            weight_grams: refWeight,
          });
          AISuggestedFood.updateOne({ _id: aiCacheHit._id }, { $inc: { times_seen: 1 } }).exec();
          continue;
        }

        // 2e. USDA — use English name against description_en for accurate matching
        // USDA descriptions are long English strings ("Potatoes, boiled, cooked in skin...")
        // so we match with the English keyword from Gemini rather than the Vietnamese name.
        if (q_en) {
          const usdaQuery: object[] = [{ description_en: { $regex: patternEn } }];
          if (q_vi && q_vi !== q_en) {
            usdaQuery.push({ description_vi: { $regex: patternVi } });
          }
          const usdaHit = await UsdaFood.findOne({ $or: usdaQuery })
            .select("description_en description_vi energy_kcal protein lipid glucid fiber")
            .lean();

          if (usdaHit) {
            results.push({
              dish_name: displayName,
              source: "usda",
              matched_name: usdaHit.description_vi || usdaHit.description_en,
              nutrition: {
                calories: Math.round(((usdaHit.energy_kcal || 0) * g) / 100),
                protein: Math.round(((usdaHit.protein || 0) * g) / 100),
                carbs:   Math.round(((usdaHit.glucid   || 0) * g) / 100),
                fat:     Math.round(((usdaHit.lipid    || 0) * g) / 100),
                fiber:   Math.round(((usdaHit.fiber    || 0) * g) / 100),
              },
              weight_grams: g,
            });
            continue;
          }
        }

        // No source matched — Gemini AI estimate will fill in below
        results.push({
          dish_name: displayName,
          _name_en: dish.name_en,
          source: "none",
          matched_name: null,
          nutrition: null,
          weight_grams: g,
        });
      }

      // ── Steps 3 + 4: AI nutrition estimate + vitamin estimate (parallel) ───
      const unmatched = results.filter((r) => r.source === "none");
      const mealSummary = results
        .map((r) => `${r.matched_name || r.dish_name}(${(r.weight_grams as number) || 300}g)`)
        .join(", ");

      const vitaminList = language === "vi"
        ? "Vit A,C,D,E,B1,B2,B3,B12, Canxi, Sắt, Kali, Magie, Kẽm, Natri, Phốt pho"
        : "Vit A,C,D,E,B1,B2,B3,B12, Calcium, Iron, Potassium, Magnesium, Zinc, Sodium, Phosphorus";

      const vitaminPrompt = language === "vi"
        ? `Ước tính vitamin/khoáng chất cho bữa: ${mealSummary}\nJSON only:\n{"vitamins":[{"name":"Vitamin C","amount":15,"unit":"mg","percent_dv":17}]}\nCần: ${vitaminList}`
        : `Estimate vitamins/minerals for: ${mealSummary}\nJSON only:\n{"vitamins":[{"name":"Vitamin C","amount":15,"unit":"mg","percent_dv":17}]}\nEstimate: ${vitaminList}`;

      const unmatchedNames = unmatched
        .map((r) => {
          const nameEn = (r._name_en as string) || (r.dish_name as string);
          const nameVi = r.dish_name as string;
          const hint = r.weight_grams as number ?? 200;
          return `${nameVi}/${nameEn}(~${hint}g)`;
        })
        .join(", ");

      const nutritionPrompt = unmatched.length > 0
        ? `Estimate per-100g nutrition for: ${unmatchedNames}\nJSON only:\n{"items":[{"name":"dish","weight_grams":300,"calories_per_100g":150,"protein_per_100g":12,"carbs_per_100g":20,"fat_per_100g":5,"fiber_per_100g":2}]}`
        : null;

      const [nutritionText, vitaminText] = await Promise.all([
        nutritionPrompt
          ? callGemini(GEMINI_API_KEY, {
              contents: [{ role: "user", parts: [{ text: nutritionPrompt }] }],
              generationConfig: { temperature: 0.2 },
            }).catch(() => "")
          : Promise.resolve(""),
        callGemini(GEMINI_API_KEY, {
          contents: [{ role: "user", parts: [{ text: vitaminPrompt }] }],
          generationConfig: { temperature: 0.1 },
        }).catch(() => ""),
      ]);

      // Apply Gemini nutrition to unmatched dishes
      if (nutritionText && unmatched.length > 0) {
        try {
          const parsed = JSON.parse(cleanJson(nutritionText)) as {
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
                const cal100  = aiItem.calories_per_100g || 0;
                const pro100  = aiItem.protein_per_100g  || 0;
                const carb100 = aiItem.carbs_per_100g    || 0;
                const fat100  = aiItem.fat_per_100g      || 0;
                const fib100  = aiItem.fiber_per_100g    || 0;
                const weight  = aiItem.weight_grams || (target.weight_grams as number) || 300;
                target.source = "ai_estimate";
                target.matched_name = aiItem.name || target.dish_name;
                target.weight_grams = weight;
                target.nutrition = {
                  calories: Math.round((cal100  * weight) / 100),
                  protein:  Math.round((pro100  * weight) / 100),
                  carbs:    Math.round((carb100 * weight) / 100),
                  fat:      Math.round((fat100  * weight) / 100),
                  fiber:    Math.round((fib100  * weight) / 100),
                };
                AISuggestedFood.findOneAndUpdate(
                  { name: (aiItem.name || target.dish_name) as string },
                  {
                    $set: {
                      calories_per_100g: cal100,
                      protein_per_100g:  pro100,
                      carbs_per_100g:    carb100,
                      fat_per_100g:      fat100,
                      fiber_per_100g:    fib100,
                      reference_weight_grams: weight,
                    },
                    $inc: { times_seen: 1 },
                  },
                  { upsert: true, new: true },
                ).exec();
              }
            }
          }
        } catch { /* fallback below */ }
      }

      // Fallback for still-unmatched (Gemini returned nothing useful)
      for (const r of results) {
        if (r.source === "none") {
          r.source = "ai_estimate";
          r.matched_name = r.dish_name;
          r.weight_grams = (r.weight_grams as number) || 300;
          r.nutrition = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
        }
        delete r._name_en; // internal field, not sent to client
      }

      // Parse vitamins
      type VitaminEntry = { name: string; amount: number; unit: string; percent_dv: number };
      let vitamins: VitaminEntry[] = [];
      if (vitaminText) {
        try {
          const parsed = JSON.parse(cleanJson(vitaminText)) as {
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
        } catch { /* vitamins stay empty */ }
      }

      // ── Calculate totals ──────────────────────────────────────────────────
      type NutritionTotals = { calories: number; protein: number; carbs: number; fat: number; fiber: number };
      const totals = results.reduce<NutritionTotals>(
        (sum, r) => {
          const n = r.nutrition as Record<string, number> | null;
          return {
            calories: sum.calories + (n?.calories || 0),
            protein:  sum.protein  + (n?.protein  || 0),
            carbs:    sum.carbs    + (n?.carbs    || 0),
            fat:      sum.fat      + (n?.fat      || 0),
            fiber:    sum.fiber    + (n?.fiber    || 0),
          };
        },
        { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
      );

      console.log(
        `[analyzeFood] ${(user as any).email ?? user._id} →`,
        results
          .map((r) => `${r.dish_name}[${r.source}→${r.matched_name ?? "?"}|${r.weight_grams ?? "?"}g]`)
          .join("  "),
      );

      res.json({ dishes: results, totals, vitamins, meal_type: guessMealType() });
    } catch (error) {
      console.error("[analyzeFood] failed:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

export default router;
