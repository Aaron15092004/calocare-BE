import { Router, Request, Response } from "express";
import multer from "multer";
import { authenticate } from "../../middleware/auth";
import { ragRateLimit } from "../../middleware/ragRateLimit";
import { getScannerService, ScanMatch } from "../../services/rag/ScannerService";
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
        const result = await service.scan({
            imageBase64,
            mimeType,
            userId: user?._id?.toString(),
        });
        if (clientAborted || res.headersSent) return;

        if (result.vision.not_food) {
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
            fallback_reason: result.fallback_reason,
            timings_ms: result.timings_ms,
            image_bytes: imageBytes,
            mime_type: mimeType,
            status: "ok",
        });

        res.json({
            matched,
            match,
            description: result.vision.main_dish_vi || result.vision.main_dish_en,
            ai_estimate,
            confidence: result.primary_match?.confidence ?? result.vision.confidence,
            alternatives: result.alternatives.map(toClientMatch),
            fallback_reason: result.fallback_reason,
            serving_grams:
                clampServingGrams(result.primary_match?.estimated_portion_grams) ??
                clampServingGrams(result.vision.estimated_portion_grams),
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
