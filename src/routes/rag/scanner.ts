import { Router, Request, Response } from "express";
import multer from "multer";
import { authenticate } from "../../middleware/auth";
import { ragRateLimit } from "../../middleware/ragRateLimit";
import { getScannerService, ScanMealDish } from "../../services/rag/ScannerService";
import { IUser } from "../../models/User";
import { logRag } from "../../utils/logger";
import { isOperationTimeoutError } from "../../utils/asyncTimeout";

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

function dishToClientMatch(dish: ScanMealDish) {
    const grams = Math.max(1, dish.weight_grams || 100);
    const factor = 100 / grams;
    return {
        source_id: dish.source_id ?? dish.fs_food_id ?? "",
        source_type: dish.source,
        name: dish.matched_name || dish.dish_name,
        name_vi: dish.matched_name || dish.dish_name,
        score: dish.confidence,
        energy_kcal: Math.round(dish.nutrition.calories * factor),
        protein_g: Math.round(dish.nutrition.protein * factor * 10) / 10,
        carbs_g: Math.round(dish.nutrition.carbs * factor * 10) / 10,
        fat_g: Math.round(dish.nutrition.fat * factor * 10) / 10,
        fiber_g: Math.round(dish.nutrition.fiber * factor * 10) / 10,
        diet_tags: [] as string[],
    };
}

function looksLikeSupportedImage(buffer: Buffer, mimeType: string): boolean {
    const isJpeg = buffer.length > 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff;
    const isPng = buffer.length > 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47;
    const isGif = buffer.length > 6 &&
        buffer.subarray(0, 3).toString("ascii") === "GIF";
    const isWebp = buffer.length > 12 &&
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP";
    const isHeifFamily = buffer.length > 12 &&
        buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
        ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].includes(mimeType);

    return isJpeg || isPng || isGif || isWebp || isHeifFamily;
}

function clampServingGrams(value?: number): number | undefined {
    if (!Number.isFinite(value)) return undefined;
    return Math.round(Math.max(20, Math.min(1500, value as number)));
}

function classifyScanError(err: unknown): { status: number; error: string; message: string; retryable: boolean; stage?: string } {
    const msg = err instanceof Error ? err.message : "Scan failed";

    if (isOperationTimeoutError(err)) {
        return {
            status: 504,
            error: "scan_timeout",
            message: "Scan đang mất nhiều thời gian hơn bình thường. Bạn thử ảnh nhẹ hơn hoặc thử lại sau vài giây nhé.",
            retryable: true,
            stage: err.stage,
        };
    }

    if (/invalid JSON|returned invalid JSON/i.test(msg)) {
        return {
            status: 502,
            error: "scan_provider_bad_response",
            message: "AI trả về dữ liệu chưa đúng định dạng. Bạn thử scan lại ảnh này nhé.",
            retryable: true,
        };
    }

    if (/429|rate limit|temporarily unavailable|deadline|ECONNABORTED|ETIMEDOUT|timeout|ENOTFOUND|ECONNRESET|service unavailable/i.test(msg)) {
        return {
            status: 503,
            error: "scan_provider_unavailable",
            message: "Dịch vụ AI đang bận hoặc phản hồi chậm. Bạn thử lại sau ít giây nhé.",
            retryable: true,
        };
    }

    return {
        status: 500,
        error: "scan_failed",
        message: "Scan chưa hoàn tất. Bạn thử lại với ảnh rõ hơn nhé.",
        retryable: true,
    };
}

router.post("/", authenticate, ragRateLimit("scan"), upload.single("image"), async (req: Request, res: Response) => {
    if (!req.file) {
        res.status(400).json({ error: "No image file provided" });
        return;
    }

    if (!looksLikeSupportedImage(req.file.buffer, req.file.mimetype)) {
        res.status(400).json({ error: "File ảnh không hợp lệ. Vui lòng chọn ảnh JPG, PNG, WEBP hoặc HEIC." });
        return;
    }

    const user = req.user as IUser;
    const imageBase64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;
    const t0 = Date.now();
    const imageBytes = req.file.size;
    let clientAborted = false;

    req.on("aborted", () => {
        clientAborted = true;
        logRag({
            endpoint: "scan",
            userId: user?._id?.toString(),
            latency_ms: Date.now() - t0,
            status: "error",
            error: "client_aborted",
            error_code: "client_aborted",
            image_bytes: imageBytes,
            mime_type: mimeType,
        });
    });

    try {
        const service = getScannerService();
        const result = await service.scanMeal({
            imageBase64,
            mimeType,
            userId: user?._id?.toString(),
        });
        if (clientAborted || res.headersSent) return;

        if (result.not_food) {
            logRag({
                endpoint: "scan",
                userId: user?._id?.toString(),
                latency_ms: Date.now() - t0,
                matched: false,
                fallback_used: false,
                status: "not_food",
                timings_ms: result.timings_ms,
                image_bytes: imageBytes,
                mime_type: mimeType,
            });
            res.status(422).json({ error: "Ảnh này có vẻ không phải món ăn. Bạn thử chụp rõ phần đồ ăn hơn nhé." });
            return;
        }

        if (result.dishes.length === 0) {
            res.status(422).json({ error: "Chưa nhận diện được món ăn đủ rõ. Bạn thử ảnh sáng và gần món hơn nhé." });
            return;
        }

        const primary = result.dishes[0];
        const matched = result.dishes.some((dish) => dish.source !== "ai_estimate");
        const match = primary.source !== "ai_estimate" ? dishToClientMatch(primary) : undefined;
        const ai_estimate =
            primary.source === "ai_estimate"
                ? {
                      calories_per_100g: dishToClientMatch(primary).energy_kcal,
                      protein_per_100g: dishToClientMatch(primary).protein_g,
                      fat_per_100g: dishToClientMatch(primary).fat_g,
                      carbs_per_100g: dishToClientMatch(primary).carbs_g,
                  }
                : undefined;

        logRag({
            endpoint: "scan",
            userId: user?._id?.toString(),
            latency_ms: Date.now() - t0,
            matched,
            fallback_used: result.fallback_used,
            fallback_reason: result.fallback_reason,
            timings_ms: result.timings_ms,
            image_bytes: imageBytes,
            mime_type: mimeType,
            status: "ok",
        });

        res.json({
            matched,
            match,
            description: primary.dish_name,
            ai_estimate,
            confidence: primary.confidence,
            alternatives: result.dishes.slice(1).map(dishToClientMatch),
            fallback_reason: result.fallback_reason,
            serving_grams: clampServingGrams(primary.weight_grams),
            dishes: result.dishes,
            totals: result.totals,
            vitamins: result.vitamins,
            meal_type: result.meal_type,
        });
    } catch (err) {
        if (clientAborted || res.headersSent) return;
        const msg = err instanceof Error ? err.message : "Scan failed";
        const classified = classifyScanError(err);
        logRag({
            endpoint: "scan",
            userId: user?._id?.toString(),
            latency_ms: Date.now() - t0,
            status: "error",
            error: msg,
            error_code: classified.error,
            stage: classified.stage,
            image_bytes: imageBytes,
            mime_type: mimeType,
        });
        res.status(classified.status).json({
            error: classified.error,
            message: classified.message,
            retryable: classified.retryable,
            stage: classified.stage,
            detail: process.env.NODE_ENV === "production" ? undefined : msg,
        });
    }
});

export default router;
