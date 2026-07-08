import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAdmin } from "../../middleware/roleCheck";
import ApiUsage from "../../models/ApiUsage";
import ChatSession from "../../models/ChatSession";
import MealPlan from "../../models/MealPlan";
import PaymentTransaction from "../../models/PaymentTransaction";
import { getPayOS, isPayOSConfigured } from "../../services/payosClient";

const router = Router();

const MAX_RANGE_DAYS = 370;
const DEFAULT_RANGE_DAYS = 30;
const VND_AMOUNT_EXPR = { $ifNull: ["$final_amount", "$amount"] };
const COST_PER_CHAT_MSG = 0.004;
const COST_PER_MEAL_PLAN_7D = 0.020;
const COST_PER_SCAN = 0.0002;
const COST_PER_EMBED = 0.000001;
const USD_TO_VND = Number(process.env.AI_COST_USD_TO_VND || 26000);
const TZ = "Asia/Ho_Chi_Minh";
// Scans are tracked per provider: Gemini primary + Groq Llama-4 vision fallback
const SCAN_SERVICES = ["gemini", "groq_vision"];

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

function formatHourKey(date: Date): string {
    return date.toISOString().slice(0, 13);
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

// Bucketed revenue rows (by day / ISO week / month) for the financial breakdown
function periodPipeline(rangeMatch: Record<string, unknown>, format: string) {
    return [
        { $match: rangeMatch },
        {
            $group: {
                _id: { $dateToString: { format, date: "$created_at", timezone: TZ } },
                revenue: {
                    $sum: { $cond: [{ $eq: ["$status", "completed"] }, VND_AMOUNT_EXPR, 0] },
                },
                completed_count: {
                    $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
                },
                pending_amount: {
                    $sum: { $cond: [{ $eq: ["$status", "pending"] }, VND_AMOUNT_EXPR, 0] },
                },
                pending_count: {
                    $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
                },
                refunded_amount: {
                    $sum: { $cond: [{ $eq: ["$status", "refunded"] }, VND_AMOUNT_EXPR, 0] },
                },
                failed_count: {
                    $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
            },
        },
        { $sort: { _id: 1 as const } },
    ];
}

function mapPeriodRows(rows: any[]) {
    return rows.map((row) => ({
        period: row._id as string,
        revenue: row.revenue || 0,
        completed_count: row.completed_count || 0,
        pending_amount: row.pending_amount || 0,
        pending_count: row.pending_count || 0,
        refunded_amount: row.refunded_amount || 0,
        failed_count: row.failed_count || 0,
    }));
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
            weeklyRows,
            monthlyRows,
            planRows,
            methodRows,
            targetRows,
            recentTransactions,
            todayRows,
            monthRows,
            previousRows,
            chatUsageRows,
            mealPlanUsageRows,
            apiUsageRows,
            chatTrackedRows,
            topCustomerRows,
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
                            $dateToString: { format: "%Y-%m-%d", date: "$created_at", timezone: TZ },
                        },
                        revenue: { $sum: VND_AMOUNT_EXPR },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            PaymentTransaction.aggregate(periodPipeline(rangeMatch, "%G-W%V")),
            PaymentTransaction.aggregate(periodPipeline(rangeMatch, "%Y-%m")),
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
            ChatSession.aggregate([
                { $unwind: "$messages" },
                {
                    $match: {
                        "messages.role": "user",
                        "messages.timestamp": { $gte: start, $lte: end },
                    },
                },
                { $group: { _id: null, count: { $sum: 1 } } },
            ]),
            MealPlan.aggregate([
                {
                    $match: {
                        created_at: { $gte: start, $lte: end },
                        creator_id: { $exists: true, $ne: null },
                    },
                },
                { $group: { _id: null, count: { $sum: 1 }, total_days: { $sum: "$total_days" } } },
            ]),
            ApiUsage.aggregate([
                {
                    $match: {
                        service: { $in: [...SCAN_SERVICES, "voyage", "meal_plan", "meal_plan_day"] },
                        hour: { $gte: formatHourKey(start), $lte: formatHourKey(end) },
                    },
                },
                { $group: { _id: "$service", count: { $sum: "$count" } } },
            ]),
            // Durable chat counter (session messages get trimmed by auto-summarize)
            ApiUsage.aggregate([
                {
                    $match: {
                        service: "chat_msg",
                        hour: { $gte: formatHourKey(start), $lte: formatHourKey(end) },
                    },
                },
                { $group: { _id: null, count: { $sum: "$count" } } },
            ]),
            // Lifetime top customers (completed only) — for customer care
            PaymentTransaction.aggregate([
                { $match: { status: "completed" } },
                {
                    $group: {
                        _id: "$user_id",
                        total_spent: { $sum: VND_AMOUNT_EXPR },
                        tx_count: { $sum: 1 },
                        first_payment_at: { $min: "$created_at" },
                        last_payment_at: { $max: "$created_at" },
                        plans: { $addToSet: "$plan_type" },
                        methods: { $addToSet: { $ifNull: ["$payment_method", "unknown"] } },
                    },
                },
                { $sort: { total_spent: -1 } },
                { $limit: 20 },
                {
                    $lookup: {
                        from: "users",
                        localField: "_id",
                        foreignField: "_id",
                        as: "user",
                        pipeline: [
                            { $project: { display_name: 1, email: 1, subscription_tier: 1, subscription_expires_at: 1 } },
                        ],
                    },
                },
                { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
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
        const apiUsageMap = new Map(apiUsageRows.map((row: any) => [row._id, row.count]));
        const chatMessages = Math.max(chatUsageRows[0]?.count || 0, chatTrackedRows[0]?.count || 0);
        const mealPlanCount = Math.max(mealPlanUsageRows[0]?.count || 0, apiUsageMap.get("meal_plan") || 0);
        const mealPlanTotalDays = Math.max(mealPlanUsageRows[0]?.total_days || 0, apiUsageMap.get("meal_plan_day") || 0);
        const scanCalls = SCAN_SERVICES.reduce((sum, service) => sum + (apiUsageMap.get(service) || 0), 0);
        const embedCalls = apiUsageMap.get("voyage") || 0;
        const costChatUsd = +(chatMessages * COST_PER_CHAT_MSG).toFixed(4);
        const costMealPlansUsd = +((mealPlanTotalDays / 7) * COST_PER_MEAL_PLAN_7D).toFixed(4);
        const costScansUsd = +(scanCalls * COST_PER_SCAN).toFixed(4);
        const costEmbedsUsd = +(embedCalls * COST_PER_EMBED).toFixed(4);
        const totalAiCostUsd = +(costChatUsd + costMealPlansUsd + costScansUsd + costEmbedsUsd).toFixed(4);
        const totalAiCostVnd = Math.round(totalAiCostUsd * USD_TO_VND);
        const netProfitEstimate = completedRevenue - totalAiCostVnd;
        const grossMarginPct = completedRevenue > 0
            ? Math.round((netProfitEstimate / completedRevenue) * 1000) / 10
            : null;

        res.json({
            range: {
                start_date: start.toISOString(),
                end_date: end.toISOString(),
                days,
            },
            generated_at: new Date().toISOString(),
            totals: {
                completed_revenue: completedRevenue,
                estimated_ai_cost_vnd: totalAiCostVnd,
                estimated_ai_cost_usd: totalAiCostUsd,
                estimated_net_profit_vnd: netProfitEstimate,
                gross_margin_pct: grossMarginPct,
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
                weekly_revenue: mapPeriodRows(weeklyRows),
                monthly_revenue: mapPeriodRows(monthlyRows),
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
                ai_cost_by_service: [
                    { service: "chat", label: "Chat AI", usage_count: chatMessages, cost_usd: costChatUsd, cost_vnd: Math.round(costChatUsd * USD_TO_VND) },
                    { service: "meal_plan", label: "Meal plan AI", usage_count: mealPlanCount, total_days: mealPlanTotalDays, cost_usd: costMealPlansUsd, cost_vnd: Math.round(costMealPlansUsd * USD_TO_VND) },
                    { service: "scan", label: "Scan AI", usage_count: scanCalls, cost_usd: costScansUsd, cost_vnd: Math.round(costScansUsd * USD_TO_VND) },
                    { service: "embed", label: "Embedding/search", usage_count: embedCalls, cost_usd: costEmbedsUsd, cost_vnd: Math.round(costEmbedsUsd * USD_TO_VND) },
                ],
            },
            accounting: {
                currency: "VND",
                usd_to_vnd: USD_TO_VND,
                revenue_vnd: completedRevenue,
                direct_ai_cost_vnd: totalAiCostVnd,
                estimated_net_profit_vnd: netProfitEstimate,
                gross_margin_pct: grossMarginPct,
                formulas: {
                    revenue: "Tổng final_amount/amount của giao dịch completed trong kỳ",
                    ai_cost: "Chat + Meal plan + Scan + Embedding, quy đổi theo AI_COST_USD_TO_VND",
                    net_profit: "Doanh thu completed - chi phí AI trực tiếp",
                },
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
            top_customers: topCustomerRows.map((row: any) => ({
                user_id: row._id,
                display_name: row.user?.display_name || "—",
                email: row.user?.email || "—",
                subscription_tier: row.user?.subscription_tier || "free",
                subscription_expires_at: row.user?.subscription_expires_at || null,
                total_spent: row.total_spent || 0,
                tx_count: row.tx_count || 0,
                first_payment_at: row.first_payment_at,
                last_payment_at: row.last_payment_at,
                plans: row.plans || [],
                methods: row.methods || [],
            })),
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
                notes: tx.notes,
                created_at: tx.created_at,
                updated_at: tx.updated_at,
            })),
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/admin/revenue/transactions — paginated transaction history with filters
// Query: page, limit, status, method, plan, search (name/email/payment_ref/discount code)
router.get("/transactions", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
        const method = typeof req.query.method === "string" ? req.query.method.trim() : "";
        const plan = typeof req.query.plan === "string" ? req.query.plan.trim() : "";
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

        const match: Record<string, unknown> = {};
        if (status && ["pending", "completed", "failed", "refunded"].includes(status)) match.status = status;
        if (method) match.payment_method = method === "unknown" ? { $in: [null, ""] } : method;
        if (plan) match.plan_type = plan;

        const pipeline: any[] = [
            { $match: match },
            { $sort: { created_at: -1 } },
            {
                $lookup: {
                    from: "users",
                    localField: "user_id",
                    foreignField: "_id",
                    as: "user",
                    pipeline: [{ $project: { display_name: 1, email: 1, subscription_tier: 1 } }],
                },
            },
            { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: "stores",
                    localField: "store_id",
                    foreignField: "_id",
                    as: "store",
                    pipeline: [{ $project: { name: 1 } }],
                },
            },
            { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },
        ];

        if (search) {
            const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            pipeline.push({
                $match: {
                    $or: [
                        { "user.display_name": regex },
                        { "user.email": regex },
                        { "store.name": regex },
                        { payment_ref: regex },
                        { discount_code: regex },
                    ],
                },
            });
        }

        pipeline.push({
            $facet: {
                rows: [
                    { $skip: (page - 1) * limit },
                    { $limit: limit },
                    {
                        $project: {
                            plan_type: 1,
                            target_type: 1,
                            status: 1,
                            amount: 1,
                            final_amount: 1,
                            discount_code: 1,
                            payment_method: 1,
                            payment_ref: 1,
                            duration_months: 1,
                            notes: 1,
                            created_at: 1,
                            updated_at: 1,
                            user: 1,
                            store: 1,
                        },
                    },
                ],
                total: [{ $count: "count" }],
            },
        });

        const [result] = await PaymentTransaction.aggregate(pipeline);
        const total = result?.total?.[0]?.count || 0;

        res.json({
            page,
            limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / limit)),
            transactions: (result?.rows || []).map((tx: any) => ({
                _id: tx._id,
                user: tx.user ? {
                    display_name: tx.user.display_name,
                    email: tx.user.email,
                    subscription_tier: tx.user.subscription_tier,
                } : null,
                store: tx.store ? { name: tx.store.name } : null,
                plan_type: tx.plan_type,
                target_type: tx.target_type,
                status: tx.status,
                amount: tx.amount,
                final_amount: tx.final_amount,
                discount_code: tx.discount_code,
                payment_method: tx.payment_method,
                payment_ref: tx.payment_ref,
                duration_months: tx.duration_months,
                notes: tx.notes,
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
