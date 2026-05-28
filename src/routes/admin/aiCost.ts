import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAdminOrModerator } from "../../middleware/roleCheck";
import User from "../../models/User";
import ChatSession from "../../models/ChatSession";
import MealPlan from "../../models/MealPlan";
import ApiUsage from "../../models/ApiUsage";

const router = Router();

// Pay-as-you-go pricing (USD) — update if provider changes pricing
const COST_PER_CHAT_MSG = 0.004;       // Groq llama-3.3-70b: ~5K tokens/call avg (system prompt + history + tools)
const COST_PER_MEAL_PLAN_7D = 0.020;   // Groq: ~10 LLM calls per 7-day plan with retries
const COST_PER_SCAN = 0.0002;          // Gemini 2.0 Flash vision: ~1.1K tokens/call
const COST_PER_EMBED = 0.000001;       // Voyage voyage-4-lite: per text embedded

// Chat monthly soft limits per tier (-1 = unlimited, used for usage % display in FE)
const CHAT_LIMIT = { free: 150, premium: 100, pro: -1 };

// GET /api/admin/ai-cost
router.get("/", authenticate, requireAdminOrModerator, async (_req: Request, res: Response) => {
    try {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
        // Hour-bucket prefix for the current month, e.g. "2026-05"
        const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

        const [userTierAgg, chatByUserAgg, mealPlanAgg, chatTrendAgg, geminiAgg, voyageAgg] = await Promise.all([
            // User counts by subscription tier
            User.aggregate([
                { $group: { _id: { $ifNull: ["$subscription_tier", "free"] }, count: { $sum: 1 } } },
            ]),

            // Chat messages sent this month, grouped by user (unwinding messages array)
            // Note: auto-summarize (at 20 msgs) trims old messages, so current-month data is reliable
            ChatSession.aggregate([
                { $unwind: "$messages" },
                {
                    $match: {
                        "messages.role": "user",
                        "messages.timestamp": { $gte: startOfMonth, $lte: now },
                    },
                },
                { $group: { _id: "$user_id", msg_count: { $sum: 1 } } },
                {
                    $lookup: {
                        from: "users",
                        localField: "_id",
                        foreignField: "_id",
                        as: "user",
                        pipeline: [{ $project: { display_name: 1, email: 1, subscription_tier: 1 } }],
                    },
                },
                { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
                { $sort: { msg_count: -1 } },
            ]),

            // User-generated meal plans created this month
            MealPlan.aggregate([
                {
                    $match: {
                        created_at: { $gte: startOfMonth },
                        creator_id: { $exists: true, $ne: null },
                    },
                },
                { $group: { _id: null, count: { $sum: 1 }, total_days: { $sum: "$total_days" } } },
            ]),

            // Chat message counts per month for trend chart (last 6 months)
            ChatSession.aggregate([
                { $unwind: "$messages" },
                {
                    $match: {
                        "messages.role": "user",
                        "messages.timestamp": { $gte: sixMonthsAgo },
                    },
                },
                {
                    $group: {
                        _id: {
                            year: { $year: "$messages.timestamp" },
                            month: { $month: "$messages.timestamp" },
                        },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } },
            ]),

            // Actual Gemini scan calls this month from ApiUsage hourly buckets
            ApiUsage.aggregate([
                { $match: { service: "gemini", hour: { $regex: `^${monthPrefix}` } } },
                { $group: { _id: null, total: { $sum: "$count" } } },
            ]),

            // Actual VoyageAI embedding calls this month
            ApiUsage.aggregate([
                { $match: { service: "voyage", hour: { $regex: `^${monthPrefix}` } } },
                { $group: { _id: null, total: { $sum: "$count" } } },
            ]),
        ]);

        // --- User tier counts ---
        const tierMap = new Map(userTierAgg.map((r: any) => [r._id, r.count]));
        const freeCount = tierMap.get("free") || 0;
        const premiumCount = tierMap.get("premium") || 0;
        const proCount = tierMap.get("pro") || 0;

        // --- Chat stats ---
        const chatByTier = { free: 0, premium: 0, pro: 0 };
        chatByUserAgg.forEach((r: any) => {
            const tier = (r.user?.subscription_tier as keyof typeof chatByTier) || "free";
            if (tier in chatByTier) chatByTier[tier] += r.msg_count;
        });
        const totalChatMessages = chatByTier.free + chatByTier.premium + chatByTier.pro;
        const avgMsgsPremium = premiumCount > 0 ? Math.round(chatByTier.premium / premiumCount) : 0;
        // Users at risk: premium users who have used ≥ 80% of their 100-message limit this month
        const premiumAtRisk = chatByUserAgg.filter(
            (r: any) => r.user?.subscription_tier === "premium" && r.msg_count >= 80
        ).length;

        // --- Meal plan stats ---
        const mealPlanCount: number = mealPlanAgg[0]?.count ?? 0;
        const mealPlanTotalDays: number = mealPlanAgg[0]?.total_days ?? 0;

        // --- Actual API usage from DB ---
        const totalScans: number = geminiAgg[0]?.total ?? 0;
        const totalEmbeds: number = voyageAgg[0]?.total ?? 0;

        // --- Cost calculations (USD) ---
        const costChat = +(totalChatMessages * COST_PER_CHAT_MSG).toFixed(4);
        const costMealPlans = +((mealPlanTotalDays / 7) * COST_PER_MEAL_PLAN_7D).toFixed(4);
        const costScans = +(totalScans * COST_PER_SCAN).toFixed(4);
        const costVoyage = +(totalEmbeds * COST_PER_EMBED).toFixed(4);
        const totalCostUsd = +(costChat + costMealPlans + costScans + costVoyage).toFixed(4);

        const riskLevel: "low" | "medium" | "high" =
            avgMsgsPremium >= 80 ? "high" : avgMsgsPremium >= 50 ? "medium" : "low";

        // --- 6-month trend chart ---
        const months: { label: string; year: number; month: number }[] = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({
                label: d.toLocaleString("vi-VN", { month: "short", year: "2-digit" }),
                year: d.getFullYear(),
                month: d.getMonth() + 1,
            });
        }
        const trendMap = new Map(
            chatTrendAgg.map((r: any) => [`${r._id.year}-${r._id.month}`, r.count])
        );
        const chatTrend6m = months.map((m) => {
            const msgs = trendMap.get(`${m.year}-${m.month}`) || 0;
            return {
                name: m.label,
                messages: msgs,
                cost_usd: +(msgs * COST_PER_CHAT_MSG).toFixed(4),
            };
        });

        res.json({
            period: { start: startOfMonth, end: now },
            stats: {
                total_chat_messages: totalChatMessages,
                chat_messages_by_tier: chatByTier,
                avg_messages_per_premium_user: avgMsgsPremium,
                premium_users_count: premiumCount,
                total_meal_plans: mealPlanCount,
                total_scans: totalScans,
                total_embeds: totalEmbeds,
                cost_chat_usd: costChat,
                cost_meal_plans_usd: costMealPlans,
                cost_scans_usd: costScans,
                cost_voyage_usd: costVoyage,
                total_cost_usd: totalCostUsd,
                risk_level: riskLevel,
                premium_at_risk: premiumAtRisk,
            },
            charts: {
                cost_by_service: [
                    { name: "Chat (Groq)", cost_usd: costChat },
                    { name: "Meal Plan (Groq)", cost_usd: costMealPlans },
                    { name: "Scan (Gemini)", cost_usd: costScans },
                    { name: "Embed (Voyage)", cost_usd: costVoyage },
                ],
                chat_trend_6m: chatTrend6m,
            },
            top_users: chatByUserAgg.slice(0, 15).map((r: any) => ({
                user_id: r._id,
                display_name: r.user?.display_name || "—",
                email: r.user?.email || "—",
                tier: r.user?.subscription_tier || "free",
                message_count: r.msg_count,
                chat_limit: CHAT_LIMIT[r.user?.subscription_tier as keyof typeof CHAT_LIMIT] ?? CHAT_LIMIT.free,
                estimated_cost_usd: +(r.msg_count * COST_PER_CHAT_MSG).toFixed(4),
            })),
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
