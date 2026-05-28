import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth";
import { ragRateLimit } from "../../middleware/ragRateLimit";
import { getMealPlanGeneratorService, GoalType } from "../../services/rag/MealPlanGeneratorService";
import { IUser } from "../../models/User";
import { logRag } from "../../utils/logger";

const router = Router();

const GenerateSchema = z.object({
    duration_days: z.union([z.literal(7), z.literal(21)]),
    goal: z.enum(["weight_loss", "muscle_gain", "maintenance"]),
    meals_per_day: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
    cooking_style: z.enum(["fresh", "batch"]).optional(),
    preferences: z.object({
        dietary_preference: z.string().optional(),
        allergies: z.array(z.string()).optional(),
        cuisine_preferences: z.array(z.string()).optional(),
        notes: z.string().max(500).optional(),
    }).optional(),
});

// POST /api/rag/generate-meal-plan u2014 SSE streaming
router.post("/", authenticate, ragRateLimit("meal-plan"), async (req: Request, res: Response) => {
    const parsed = GenerateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
    }

    const user = req.user as IUser;
    const userId = (user._id as { toString(): string }).toString();
    const t0 = Date.now();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (type: string, data: unknown) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        // Sanitize notes: strip control characters that could corrupt the LLM prompt
        const rawNotes = parsed.data.preferences?.notes;
        const sanitizedNotes = rawNotes?.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") || undefined;

        const { source_breakdown } = await getMealPlanGeneratorService().generate(
            {
                userId,
                duration_days: parsed.data.duration_days,
                goal: parsed.data.goal as GoalType,
                meals_per_day: parsed.data.meals_per_day,
                cooking_style: parsed.data.cooking_style,
                preferences: parsed.data.preferences
                    ? { ...parsed.data.preferences, notes: sanitizedNotes }
                    : undefined,
            },
            (event, data) => sendEvent(event, data),
        );
        logRag({
            endpoint: "meal-plan",
            userId,
            query: `${parsed.data.goal}:${parsed.data.duration_days}d`,
            latency_ms: Date.now() - t0,
            source_breakdown,
            status: "ok",
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Generation failed";
        logRag({ endpoint: "meal-plan", userId, latency_ms: Date.now() - t0, status: "error", error: msg });
        sendEvent("error", { message: msg });
    } finally {
        res.end();
    }
});

export default router;
