import { Router, Request, Response } from "express";
import multer from "multer";
import axios from "axios";
import { optionalAuthenticate } from "../middleware/auth";
import { ragRateLimit } from "../middleware/ragRateLimit";
import { getScannerService } from "../services/rag/ScannerService";
import { getFatSecretService } from "../services/rag/FatSecretService";
import { IUser } from "../models/User";
import { logRag } from "../utils/logger";
import { toUserError } from "../utils/userFacingError";
import Food from "../models/Food";

const router = Router();

function round1(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 10) / 10;
}

function parseServingSize(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
    if (typeof value !== "string") return 100;
    const match = value.replace(",", ".").match(/([\d.]+)\s*(g|gr|gram|ml|mL)?/i);
    const parsed = match ? Number(match[1]) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 100;
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed"));
        }
    },
});

/**
 * POST /api/ai/scan
 * Mobile-facing food scan endpoint — delegates to RAG ScannerService.
 * Returns per-serving nutrition AND per-100g values for weight editing.
 * Set DISABLE_AI_FALLBACK=true in .env to block AI estimate in development.
 */
router.post(
    "/scan",
    optionalAuthenticate,
    ragRateLimit("scan"),
    upload.single("image"),
    async (req: Request, res: Response) => {
        if (!req.file) {
            res.status(400).json({ error: "No image provided" });
            return;
        }

        const user = req.user as IUser | undefined;
        const t0 = Date.now();
        const isMulti = req.query.multi === "true";

        try {
            const service = getScannerService();
            const imageBase64 = req.file.buffer.toString("base64");
            const mimeType = req.file.mimetype;
            const userId = user?._id?.toString();

            // SF-05: Multi-item scan
            if (isMulti) {
                const items = await service.scanMulti({ imageBase64, mimeType, userId });
                logRag({ endpoint: "scan", userId, latency_ms: Date.now() - t0, matched: items.length > 0, status: "ok" });

                const mapped = items.map((item) => {
                    const match = item.primary_match;
                    if (!match) return null;
                    const servingGrams = match.estimated_portion_grams ?? item.vision.estimated_portion_grams ?? 150;
                    const f = servingGrams / 100;
                    const per100g = { calories: match.energy_kcal ?? 0, protein: match.protein ?? 0, carbs: match.glucid ?? 0, fat: match.lipid ?? 0 };
                    return {
                        name: match.name || item.vision.main_dish_vi || item.vision.main_dish_en,
                        calories: Math.round(per100g.calories * f),
                        protein: Math.round(per100g.protein * f * 10) / 10,
                        carbs: Math.round(per100g.carbs * f * 10) / 10,
                        fat: Math.round(per100g.fat * f * 10) / 10,
                        serving_size: servingGrams,
                        serving_unit: "g",
                        confidence: match.confidence,
                        per_100g: per100g,
                        source_type: match.source_type,
                        source_id: match.source_id,
                    };
                }).filter(Boolean);

                res.json({ multi: true, items: mapped });
                return;
            }

            const result = await service.scan({ imageBase64, mimeType, userId });

            const match = result.primary_match;

            if (!match && process.env.DISABLE_AI_FALLBACK === "true") {
                logRag({
                    endpoint: "scan",
                    userId: user?._id?.toString(),
                    latency_ms: Date.now() - t0,
                    matched: false,
                    fallback_used: false,
                    status: "ok",
                });
                res.json({
                    not_found: true,
                    description:
                        result.vision.main_dish_vi ||
                        result.vision.main_dish_en ||
                        null,
                });
                return;
            }

            const servingGrams =
                match?.estimated_portion_grams ??
                result.vision.estimated_portion_grams ??
                150;

            // Nutrient values stored in DB are per 100g
            const per100g = {
                calories: match?.energy_kcal ?? 0,
                protein: match?.protein ?? 0,
                carbs: match?.glucid ?? 0,
                fat: match?.lipid ?? 0,
            };

            const f = servingGrams / 100;

            logRag({
                endpoint: "scan",
                userId: user?._id?.toString(),
                latency_ms: Date.now() - t0,
                matched: !!match && match.source_type !== "ai_estimate",
                fallback_used: result.fallback_used,
                status: "ok",
            });

            // When the primary match is only a low-confidence AI estimate,
            // expose hydrated mid-score candidates so the user can pick the
            // right dish instead of accepting the estimate blindly.
            const alternatives = result.fallback_used
                ? result.alternatives
                    .filter((alt) => alt.energy_kcal !== undefined)
                    .slice(0, 3)
                    .map((alt) => {
                        const altGrams = alt.estimated_portion_grams ?? servingGrams;
                        const altF = altGrams / 100;
                        const altPer100g = {
                            calories: alt.energy_kcal ?? 0,
                            protein: alt.protein ?? 0,
                            carbs: alt.glucid ?? 0,
                            fat: alt.lipid ?? 0,
                        };
                        return {
                            name: alt.name,
                            calories: Math.round(altPer100g.calories * altF),
                            protein: Math.round(altPer100g.protein * altF * 10) / 10,
                            carbs: Math.round(altPer100g.carbs * altF * 10) / 10,
                            fat: Math.round(altPer100g.fat * altF * 10) / 10,
                            serving_size: altGrams,
                            serving_unit: "g",
                            confidence: alt.confidence,
                            per_100g: altPer100g,
                            source_type: alt.source_type,
                            source_id: alt.source_id ?? null,
                        };
                    })
                : [];

            res.json({
                name:
                    match?.name ||
                    result.vision.main_dish_vi ||
                    result.vision.main_dish_en ||
                    "Không xác định",
                calories: Math.round(per100g.calories * f),
                protein: Math.round(per100g.protein * f * 10) / 10,
                carbs: Math.round(per100g.carbs * f * 10) / 10,
                fat: Math.round(per100g.fat * f * 10) / 10,
                serving_size: servingGrams,
                serving_unit: "g",
                confidence: match?.confidence,
                description:
                    result.vision.main_dish_vi || result.vision.main_dish_en || null,
                per_100g: per100g,
                source_type: match?.source_type ?? null,
                source_id: match?.source_id ?? null,
                ...(alternatives.length > 0 ? { alternatives } : {}),
            });
        } catch (err) {
            const raw = err instanceof Error ? err.message : "Scan failed";
            logRag({
                endpoint: "scan",
                userId: user?._id?.toString(),
                latency_ms: Date.now() - t0,
                status: "error",
                error: raw,
            });
            const friendly = toUserError(err);
            res.status(friendly.status).json({ error: friendly.message, code: friendly.code });
        }
    },
);

/**
 * GET /api/ai/barcode/:barcode
 * SF-06: Look up packaged food by barcode (EAN-13/UPC-A).
 * Priority: local Food DB → Open Food Facts (free) → FatSecret (if configured).
 */
router.get(
    "/barcode/:barcode",
    optionalAuthenticate,
    ragRateLimit("scan"),
    async (req: Request, res: Response) => {
        const { barcode } = req.params;
        if (!/^\d{8,14}$/.test(barcode)) {
            res.status(400).json({ error: "Invalid barcode format" });
            return;
        }

        // 1. Check local Food DB
        const localFood = await Food.findOne({ code: barcode, is_approved: true })
            .select("name_vi name_en energy_kcal protein lipid glucid fiber image_url source_reference")
            .lean();
        if (localFood) {
            res.json({
                source: "local",
                barcode,
                name: localFood.name_vi,
                name_en: localFood.name_en,
                image_url: localFood.image_url,
                db_food_id: localFood._id,
                per_100g: {
                    calories: round1(localFood.energy_kcal),
                    protein: round1(localFood.protein),
                    carbs: round1(localFood.glucid),
                    fat: round1(localFood.lipid),
                    fiber: round1(localFood.fiber),
                },
                serving_size: 100,
                serving_unit: "g",
            });
            return;
        }

        // 2. Open Food Facts (free, no API key)
        try {
            const offRes = await axios.get<any>(
                `https://world.openfoodfacts.org/api/v2/product/${barcode}?fields=product_name,product_name_vi,product_name_en,generic_name_vi,generic_name,brands,nutriments,serving_size,image_front_url,image_url,categories_tags,nova_group,nutriscore_grade`,
                { timeout: 8000 },
            );
            const p = offRes.data?.product;
            if (p && p.nutriments) {
                const n = p.nutriments;
                res.json({
                    source: "open_food_facts",
                    barcode,
                    name: p.product_name_vi || p.product_name_en || p.product_name || p.generic_name_vi || p.generic_name || "Sản phẩm đóng gói",
                    brand: p.brands,
                    image_url: p.image_front_url || p.image_url,
                    nutriscore_grade: p.nutriscore_grade,
                    nova_group: p.nova_group,
                    per_100g: {
                        calories: round1(n["energy-kcal_100g"] ?? (n["energy_100g"] != null ? Number(n["energy_100g"]) / 4.184 : 0)),
                        protein: round1(n.proteins_100g),
                        carbs: round1(n.carbohydrates_100g),
                        fat: round1(n.fat_100g),
                        fiber: round1(n.fiber_100g),
                    },
                    serving_size: parseServingSize(p.serving_size),
                    serving_unit: "g",
                });
                return;
            }
        } catch {
            // fall through to FatSecret
        }

        // 3. FatSecret barcode (Premium feature — may return null on free tier)
        if (process.env.FATSECRET_KEY) {
            try {
                const fsFood = await getFatSecretService().findByBarcode(barcode);
                if (fsFood) {
                    const nutrition = getFatSecretService().extractPer100g(fsFood);
                    if (nutrition) {
                        res.json({
                            source: "fatsecret",
                            barcode,
                            name: fsFood.food_name,
                            image_url: getFatSecretService().extractImage(fsFood) ?? undefined,
                            per_100g: {
                                calories: round1(nutrition.energy_kcal),
                                protein: round1(nutrition.protein),
                                carbs: round1(nutrition.glucid),
                                fat: round1(nutrition.lipid),
                                fiber: round1(nutrition.fiber),
                            },
                            serving_size: 100,
                            serving_unit: "g",
                        });
                        return;
                    }
                }
            } catch {
                // not found
            }
        }

        res.status(404).json({ not_found: true, barcode });
    },
);

export default router;
