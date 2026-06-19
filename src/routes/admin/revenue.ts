import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAdmin } from "../../middleware/roleCheck";
import PaymentTransaction from "../../models/PaymentTransaction";
import { getPayOS, isPayOSConfigured } from "../../services/payosClient";

const router = Router();

const MAX_RANGE_DAYS = 370;
const DEFAULT_RANGE_DAYS = 30;
const VND_AMOUNT_EXPR = { $ifNull: ["$final_amount", "$amount"] };

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function parseDateParam(value: unknown, end = false): Date | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return end ? endOfDay(parsed) : startOfDay(parsed);
}

function resolveRange(req: Request): { start: Date; end: Date; days: number } {
    const now = new Date();
    const end = parseDateParam(req.query.end_date, true) || endOfDay(now);
    const explicitStart = parseDateParam(req.query.start_date);

    const rawDays = Number(req.query.days ?? DEFAULT_RANGE_DAYS);
    const days = Math.min(
        Math.max(Number.isFinite(rawDays) && rawDays > 0 ? Math.round(rawDays) : DEFAULT_RANGE_DAYS, 1),
        MAX_RANGE_DAYS,
    );

    if (explicitStart) {
        const cappedStart = new Date(end);
        cappedStart.setDate(cappedStart.getDate() - (MAX_RANGE_DAYS - 1));
        return {
            start: explicitStart < cappedStart ? cappedStart : explicitStart,
            end,
            days: Math.max(1, Math.ceil((end.getTime() - explicitStart.getTime()) / 86_400_000) + 1),
        };
    }

    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    return { start: startOfDay(start), end, days };
}

function formatDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function buildDailySeries(start: Date, end: Date, rows: Array<{ _id: string; revenue: number; count: number }>) {
    const map = new Map(rows.map((row) => [row._id, row]));
    const result: Array<{ date: string; revenue: number; count: number }> = [];
    const cursor = startOfDay(start);
    while (cursor <= end) {
        const key = formatDateKey(cursor);
        const row = map.get(key);
        result.push({
            date: key,
            revenue: row?.revenue || 0,
            count: row?.count || 0,
        });
        cursor.setDate(cursor.getDate() + 1);
    }
    return result;
}

function getWebhookBaseUrl(): string | null {
    return process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || null;
}

// GET /api/admin/revenue
router.get("/", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const { start, end, days } = resolveRange(req);
        const rangeMatch = { created_at: { $gte: start, $lte: end } };
        const previousEnd = new Date(start.getTime() - 1);
        const previousStart = new Date(start);
        previousStart.setDate(previousStart.getDate() - days);

        const [
            statusRows,
            dailyRows,
            planRows,
            methodRows,
            targetRows,
            recentTransactions,
            todayRows,
            monthRows,
            previousRows,
        ] = await Promise.all([
            PaymentTransaction.aggregate([
                { $match: rangeMatch },
                {
                    $group: {
                        _id: "$status",
                        count: { $sum: 1 },
                        amount: { $sum: VND_AMOUNT_EXPR },
                    },
                },
            ]),
            PaymentTransaction.aggregate([
                { $match: { ...rangeMatch, status: "completed" } },
                {
                    $group: {
                        _id: {
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$created_at",
                                timezone: "Asia/Ho_Chi_Minh",
                            },
                        },
                        revenue: { $sum: VND_AMOUNT_EXPR },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            PaymentTransaction.aggregate([
                { $match: { ...rangeMatch, status: "completed" } },
                {
                    $group: {
                        _id: "$plan_type",
                        revenue: { $sum: VND_AMOUNT_EXPR },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { revenue: -1 } },
            ]),
            PaymentTransaction.aggregate([
                { $match: rangeMatch },
                {
                    $group: {
                        _id: { $ifNull: ["$payment_method", "unknown"] },
                        revenue: {
                            $sum: {
                                $cond: [{ $eq: ["$status", "completed"] }, VND_AMOUNT_EXPR, 0],
                            },
                        },
                        pending_amount: {
                            $sum: {
                                $cond: [{ $eq: ["$status", "pending"] }, VND_AMOUNT_EXPR, 0],
                            },
                        },
                        count: { $sum: 1 },
                        completed_count: {
                            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
                        },
                    },
                },
                { $sort: { revenue: -1 } },
            ]),
            PaymentTransaction.aggregate([
                { $match: { ...rangeMatch, status: "completed" } },
                {
                    $group: {
                        _id: "$target_type",
                        revenue: { $sum: VND_AMOUNT_EXPR },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { revenue: -1 } },
            ]),
            PaymentTransaction.find(rangeMatch)
                .sort({ created_at: -1 })
                .limit(30)
                .populate("user_id", "display_name email")
                .populate("store_id", "name")
                .lean(),
            PaymentTransaction.aggregate([
                { $match: { status: "completed", created_at: { $gte: startOfDay(new Date()), $lte: endOfDay(new Date()) } } },
                { $group: { _id: null, revenue: { $sum: VND_AMOUNT_EXPR }, count: { $sum: 1 } } },
            ]),
            PaymentTransaction.aggregate([
                {
                    $match: {
                        status: "completed",
                        created_at: {
                            $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
                            $lte: endOfDay(new Date()),
                        },
                    },
                },
                { $group: { _id: null, revenue: { $sum: VND_AMOUNT_EXPR }, count: { $sum: 1 } } },
            ]),
            PaymentTransaction.aggregate([
                { $match: { status: "completed", created_at: { $gte: previousStart, $lte: previousEnd } } },
                { $group: { _id: null, revenue: { $sum: VND_AMOUNT_EXPR }, count: { $sum: 1 } } },
            ]),
        ]);

        const statusMap = new Map(statusRows.map((row) => [row._id || "unknown", row]));
        const completed = statusMap.get("completed");
        const pending = statusMap.get("pending");
        const failed = statusMap.get("failed");
        const refunded = statusMap.get("refunded");
        const completedRevenue = completed?.amount || 0;
        const previousRevenue = previousRows[0]?.revenue || 0;
        const growthPct = previousRevenue > 0
            ? Math.round(((completedRevenue - previousRevenue) / previousRevenue) * 1000) / 10
            : null;

        const webhookBaseUrl = getWebhookBaseUrl();

        res.json({
            range: {
                start_date: start.toISOString(),
                end_date: end.toISOString(),
                days,
            },
            totals: {
                completed_revenue: completedRevenue,
                completed_count: completed?.count || 0,
                pending_amount: pending?.amount || 0,
                pending_count: pending?.count || 0,
                failed_count: failed?.count || 0,
                refunded_amount: refunded?.amount || 0,
                refunded_count: refunded?.count || 0,
                today_revenue: todayRows[0]?.revenue || 0,
                today_count: todayRows[0]?.count || 0,
                month_to_date_revenue: monthRows[0]?.revenue || 0,
                month_to_date_count: monthRows[0]?.count || 0,
                previous_revenue: previousRevenue,
                revenue_growth_pct: growthPct,
            },
            charts: {
                daily_revenue: buildDailySeries(start, end, dailyRows),
                by_plan: planRows.map((row) => ({
                    plan_type: row._id || "unknown",
                    revenue: row.revenue || 0,
                    count: row.count || 0,
                })),
                by_method: methodRows.map((row) => ({
                    payment_method: row._id || "unknown",
                    revenue: row.revenue || 0,
                    pending_amount: row.pending_amount || 0,
                    count: row.count || 0,
                    completed_count: row.completed_count || 0,
                })),
                by_target: targetRows.map((row) => ({
                    target_type: row._id || "unknown",
                    revenue: row.revenue || 0,
                    count: row.count || 0,
                })),
            },
            automation: {
                payos_configured: isPayOSConfigured(),
                payos_user_auto_activation: true,
                payos_store_auto_activation: true,
                bank_webhook_configured: Boolean(process.env.WEBHOOK_SECRET),
                bank_or_momo_auto_requires_provider_webhook: true,
                payos_webhook_path: "/api/subscription/webhook/payos",
                payos_webhook_url: webhookBaseUrl ? `${webhookBaseUrl}/api/subscription/webhook/payos` : null,
            },
            recent_transactions: recentTransactions.map((tx: any) => ({
                _id: tx._id,
                user: tx.user_id ? {
                    display_name: tx.user_id.display_name,
                    email: tx.user_id.email,
                } : null,
                store: tx.store_id ? {
                    name: tx.store_id.name,
                } : null,
                plan_type: tx.plan_type,
                target_type: tx.target_type,
                status: tx.status,
                amount: tx.amount,
                final_amount: tx.final_amount,
                discount_code: tx.discount_code,
                payment_method: tx.payment_method,
                payment_ref: tx.payment_ref,
                duration_months: tx.duration_months,
                created_at: tx.created_at,
                updated_at: tx.updated_at,
            })),
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/admin/revenue/payos/confirm-webhook
router.post("/payos/confirm-webhook", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        if (!isPayOSConfigured()) {
            res.status(503).json({
                error: "payos_not_configured",
                message: "PAYOS_CLIENT_ID, PAYOS_API_KEY hoặc PAYOS_CHECKSUM_KEY chưa được cấu hình.",
            });
            return;
        }

        const webhookBaseUrl = getWebhookBaseUrl();
        const webhookUrl = typeof req.body?.webhook_url === "string" && req.body.webhook_url.trim()
            ? req.body.webhook_url.trim()
            : webhookBaseUrl
                ? `${webhookBaseUrl}/api/subscription/webhook/payos`
                : "";

        if (!webhookUrl) {
            res.status(400).json({
                error: "missing_webhook_url",
                message: "Cần PUBLIC_API_URL/API_PUBLIC_URL hoặc truyền webhook_url.",
            });
            return;
        }

        const result = await getPayOS().webhooks.confirm(webhookUrl);
        res.json({
            message: "PayOS webhook confirmed",
            webhook_url: webhookUrl,
            data: result,
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
