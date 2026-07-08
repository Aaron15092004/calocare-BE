import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth";
import { ragRateLimit } from "../../middleware/ragRateLimit";
import { getChatbotService } from "../../services/rag/ChatbotService";
import { IUser } from "../../models/User";
import { logRag } from "../../utils/logger";
import { toUserError } from "../../utils/userFacingError";

const router = Router();

const ChatRequestSchema = z.object({
    message: z.string().min(1).max(2000),
    location: z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
    }).optional(),
});

// POST /api/rag/chat u2014 SSE streaming response
router.post("/", authenticate, ragRateLimit("chat"), async (req: Request, res: Response) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
    }

    const user = req.user as IUser;
    const userId = (user._id as { toString(): string }).toString();
    const t0 = Date.now();

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (type: string, data: unknown) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        await getChatbotService().chat(
            userId,
            parsed.data.message,
            (chunk) => sendEvent("chunk", { text: chunk }),
            (type, data) => sendEvent(type, data),
            parsed.data.location,
        );
        logRag({ endpoint: "chat", userId, query: parsed.data.message.slice(0, 100), latency_ms: Date.now() - t0, status: "ok" });
        sendEvent("done", { ok: true });
    } catch (err) {
        const raw = err instanceof Error ? err.message : "Chat error";
        logRag({ endpoint: "chat", userId, query: parsed.data.message.slice(0, 100), latency_ms: Date.now() - t0, status: "error", error: raw });
        const friendly = toUserError(err);
        sendEvent("error", { message: friendly.message, code: friendly.code });
    } finally {
        res.end();
    }
});

// GET /api/rag/chat/history — return last N messages of the active session
router.get("/history", authenticate, async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const userId = (user._id as { toString(): string }).toString();
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    try {
        const history = await getChatbotService().getHistory(userId, limit);
        res.json({ messages: history });
    } catch (err) {
        console.error("[chat] history error:", err instanceof Error ? err.message : err);
        const friendly = toUserError(err);
        res.status(friendly.status).json({ error: friendly.message, code: friendly.code });
    }
});

// DELETE /api/rag/chat — close active session (called on logout)
router.delete("/", authenticate, async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const userId = (user._id as { toString(): string }).toString();
    try {
        await getChatbotService().closeSession(userId);
        res.json({ ok: true });
    } catch (err) {
        console.error("[chat] close session error:", err instanceof Error ? err.message : err);
        const friendly = toUserError(err);
        res.status(friendly.status).json({ error: friendly.message, code: friendly.code });
    }
});

export default router;
