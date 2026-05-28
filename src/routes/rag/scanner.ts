import { Router, Request, Response } from "express";
import multer from "multer";
import { optionalAuthenticate } from "../../middleware/auth";
import { ragRateLimit } from "../../middleware/ragRateLimit";
import { getScannerService, ScanMatch } from "../../services/rag/ScannerService";
import { IUser } from "../../models/User";
import { logRag } from "../../utils/logger";

const router = Router();

// Store in memory — max 5MB
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

// Map internal ScanMatch → client field names expected by RagScannerModal
function toClientMatch(m: ScanMatch) {
    return {
        source_id: m.source_id ?? "",
        source_type: m.source_type as "food" | "recipe" | "usda",
        name: m.name,
        name_vi: m.name,
        score: m.confidence,
        energy_kcal: m.energy_kcal,
        protein_g: m.protein,
        carbs_g: m.glucid,
        fat_g: m.lipid,
        diet_tags: [] as string[],
    };
}

router.post("/", optionalAuthenticate, ragRateLimit("scan"), upload.single("image"), async (req: Request, res: Response) => {
    if (!req.file) {
        res.status(400).json({ error: "No image file provided" });
        return;
    }

    const user = req.user as IUser | undefined;
    const imageBase64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;
    const t0 = Date.now();

    try {
        const service = getScannerService();
        const result = await service.scan({
            imageBase64,
            mimeType,
            userId: user?._id?.toString(),
        });

        // Primary match exists and is a real DB record (not AI estimate)
        const matched = !!result.primary_match &&
            result.primary_match.source_type !== "ai_estimate";

        const match = matched && result.primary_match
            ? toClientMatch(result.primary_match)
            : undefined;

        // AI estimate only when fallback actually ran and returned data
        const ai_estimate =
            !matched &&
            result.primary_match?.source_type === "ai_estimate"
                ? {
                      calories_per_100g: result.primary_match.energy_kcal ?? 0,
                      protein_per_100g: result.primary_match.protein ?? 0,
                      fat_per_100g: result.primary_match.lipid ?? 0,
                      carbs_per_100g: result.primary_match.glucid ?? 0,
                  }
                : undefined;

        logRag({
            endpoint: "scan",
            userId: user?._id?.toString(),
            latency_ms: Date.now() - t0,
            matched,
            fallback_used: result.fallback_used,
            status: "ok",
        });

        res.json({
            matched,
            match,
            description: result.vision.main_dish_vi || result.vision.main_dish_en,
            ai_estimate,
            serving_grams:
                result.primary_match?.estimated_portion_grams ??
                result.vision.estimated_portion_grams,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Scan failed";
        logRag({ endpoint: "scan", userId: user?._id?.toString(), latency_ms: Date.now() - t0, status: "error", error: msg });
        res.status(500).json({ error: msg });
    }
});

export default router;
