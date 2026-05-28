import { Router, Request, Response } from "express";
import multer from "multer";
import axios from "axios";
import { optionalAuthenticate } from "../middleware/auth";
import { ragRateLimit } from "../middleware/ragRateLimit";
import { getScannerService } from "../services/rag/ScannerService";
import { getFatSecretService } from "../services/rag/FatSecretService";
import { IUser } from "../models/User";
import { logRag } from "../utils/logger";
import Food from "../models/Food";

const router = Router();

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
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Scan failed";
            logRag({
                endpoint: "scan",
                userId: user?._id?.toString(),
                latency_ms: Date.now() - t0,
                status: "error",
                error: msg,
            });
            res.status(500).json({ error: msg });
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
            .select("name_vi name_en energy_kcal protein lipid glucid fiber")
            .lean();
        if (localFood) {
            res.json({
                source: "local",
                name: localFood.name_vi,
                name_en: localFood.name_en,
                per_100g: {
                    calories: localFood.energy_kcal,
                    protein: localFood.protein,
                    carbs: localFood.glucid,
                    fat: localFood.lipid,
                },
                serving_size: 100,
                serving_unit: "g",
            });
            return;
        }

        // 2. Open Food Facts (free, no API key)
        try {
            const offRes = await axios.get<any>(
                `https://world.openfoodfacts.org/api/v2/product/${barcode}?fields=product_name,product_name_vi,nutriments,serving_size`,
                { timeout: 8000 },
            );
            const p = offRes.data?.product;
            if (p && p.nutriments) {
                const n = p.nutriments;
                res.json({
                    source: "open_food_facts",
                    name: p.product_name_vi || p.product_name || "Sản phẩm đóng gói",
                    per_100g: {
                        calories: Math.round(n["energy-kcal_100g"] ?? (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : 0)),
                        protein: n.proteins_100g ?? 0,
                        carbs: n.carbohydrates_100g ?? 0,
                        fat: n.fat_100g ?? 0,
                    },
                    serving_size: parseFloat(p.serving_size) || 100,
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
                            name: fsFood.food_name,
                            per_100g: {
                                calories: nutrition.energy_kcal,
                                protein: nutrition.protein,
                                carbs: nutrition.glucid,
                                fat: nutrition.lipid,
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
