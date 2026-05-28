import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { IUser } from "../models/User";
import FoodDiary from "../models/FoodDiary";
import ReportDigest, { IReportDigestContent } from "../models/ReportDigest";
import { computeInsights } from "../services/ReportInsightService";
import { getLLMService } from "../services/rag/LLMService";
import { Types } from "mongoose";

const router = Router();

// GET /api/reports/premium
router.get("/premium", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const userId = user._id as Types.ObjectId;

        const days = parseInt(req.query.days as string) || 30;
        const since = new Date();
        since.setDate(since.getDate() - days + 1);
        since.setHours(0, 0, 0, 0);

        const entries = await FoodDiary.find({
            user_id: userId,
            created_at: { $gte: since },
        })
            .select("meal_type totals created_at")
            .lean();

        const dailyMap: Record<string, { calories: number; protein: number; carbs: number; fat: number; logged: boolean }> = {};

        for (let i = 0; i < days; i++) {
            const d = new Date(since);
            d.setDate(since.getDate() + i);
            const key = d.toISOString().slice(0, 10);
            dailyMap[key] = { calories: 0, protein: 0, carbs: 0, fat: 0, logged: false };
        }

        for (const e of entries) {
            const key = new Date(e.created_at).toISOString().slice(0, 10);
            if (!dailyMap[key]) continue;
            dailyMap[key].calories += e.totals?.calories ?? 0;
            dailyMap[key].protein  += e.totals?.protein  ?? 0;
            dailyMap[key].carbs    += e.totals?.carbs    ?? 0;
            dailyMap[key].fat      += e.totals?.fat      ?? 0;
            dailyMap[key].logged    = true;
        }

        const dailyTrend = Object.entries(dailyMap)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, v]) => ({
                date,
                calories: Math.round(v.calories),
                protein: Math.round(v.protein * 10) / 10,
                carbs:   Math.round(v.carbs   * 10) / 10,
                fat:     Math.round(v.fat     * 10) / 10,
                logged:  v.logged,
            }));

        const loggedDays = dailyTrend.filter((d) => d.logged);
        const avgMacros = loggedDays.length
            ? {
                protein: Math.round((loggedDays.reduce((s, d) => s + d.protein, 0) / loggedDays.length) * 10) / 10,
                carbs:   Math.round((loggedDays.reduce((s, d) => s + d.carbs,   0) / loggedDays.length) * 10) / 10,
                fat:     Math.round((loggedDays.reduce((s, d) => s + d.fat,     0) / loggedDays.length) * 10) / 10,
            }
            : { protein: 0, carbs: 0, fat: 0 };

        const avgCalories = loggedDays.length
            ? Math.round(loggedDays.reduce((s, d) => s + d.calories, 0) / loggedDays.length)
            : 0;

        const adherencePct = days > 0 ? Math.round((loggedDays.length / days) * 100) : 0;

        const sortedKeys = Object.keys(dailyMap).sort().reverse();
        let streak = 0;
        for (const key of sortedKeys) {
            if (dailyMap[key].logged) {
                streak++;
            } else {
                const isToday = key === new Date().toISOString().slice(0, 10);
                if (isToday && streak === 0) continue;
                break;
            }
        }

        const mealTypeCounts: Record<string, number> = {};
        for (const e of entries) {
            mealTypeCounts[e.meal_type] = (mealTypeCounts[e.meal_type] ?? 0) + 1;
        }

        res.json({
            period_days: days,
            daily_trend: dailyTrend,
            avg_calories: avgCalories,
            avg_macros: avgMacros,
            adherence_pct: adherencePct,
            logged_days: loggedDays.length,
            streak_days: streak,
            meal_type_counts: mealTypeCounts,
        });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// GET /api/reports/insights?days=30
// Rule-based nutritional insight cards — no AI cost, returns instantly.
router.get("/insights", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const days = parseInt(req.query.days as string) || 30;
        const since = new Date();
        since.setDate(since.getDate() - days);
        since.setHours(0, 0, 0, 0);

        const entries = await FoodDiary.find({
            user_id: user._id,
            scanned_at: { $gte: since },
        })
            .select("meal_type totals scanned_at")
            .lean();

        const goals = {
            calories: user.daily_nutrition_goals?.calories,
            protein: user.daily_nutrition_goals?.protein,
        };

        const insights = computeInsights(entries as any, goals, days);
        res.json({ insights });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// POST /api/reports/ai-digest?days=30
// AI-generated weekly nutritional digest. Cached for 7 days per user.
// Requires premium or pro subscription.
router.post("/ai-digest", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;

        if (user.subscription_tier === "free") {
            res.status(403).json({ error: "Tính năng này yêu cầu gói Premium." });
            return;
        }

        const days = parseInt(req.query.days as string) || 30;
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Serve cached digest if still fresh
        const cached = await ReportDigest.findOne({
            user_id: user._id,
            period_days: days,
            generated_at: { $gte: sevenDaysAgo },
        }).lean();

        if (cached) {
            res.json({ content: cached.content, generated_at: cached.generated_at, cached: true });
            return;
        }

        // Fetch diary data for the period
        const since = new Date();
        since.setDate(since.getDate() - days);
        since.setHours(0, 0, 0, 0);

        const entries = await FoodDiary.find({
            user_id: user._id,
            scanned_at: { $gte: since },
        })
            .select("meal_type totals scanned_at")
            .lean();

        if (entries.length < 3) {
            res.status(400).json({ error: "Cần ít nhất 3 ngày nhật ký để tạo phân tích AI." });
            return;
        }

        // Aggregate daily totals
        const dailyMap: Record<string, { cal: number; prot: number; carbs: number; fat: number; fiber: number }> = {};
        for (const e of entries) {
            const key = new Date((e as any).scanned_at).toISOString().slice(0, 10);
            if (!dailyMap[key]) dailyMap[key] = { cal: 0, prot: 0, carbs: 0, fat: 0, fiber: 0 };
            dailyMap[key].cal   += e.totals.calories ?? 0;
            dailyMap[key].prot  += e.totals.protein  ?? 0;
            dailyMap[key].carbs += e.totals.carbs    ?? 0;
            dailyMap[key].fat   += e.totals.fat      ?? 0;
            dailyMap[key].fiber += e.totals.fiber    ?? 0;
        }

        const dayData = Object.values(dailyMap);
        const n = dayData.length;
        const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / Math.max(arr.length, 1);

        const avgCal   = Math.round(mean(dayData.map((d) => d.cal)));
        const avgProt  = Math.round(mean(dayData.map((d) => d.prot)));
        const avgCarbs = Math.round(mean(dayData.map((d) => d.carbs)));
        const avgFat   = Math.round(mean(dayData.map((d) => d.fat)));
        const avgFiber = mean(dayData.map((d) => d.fiber)).toFixed(1);

        const goals = user.daily_nutrition_goals ?? {};

        const userPrompt = `Dữ liệu nhật ký ăn uống: ${n} ngày có ghi (trong ${days} ngày qua)
- Calo trung bình: ${avgCal} kcal/ngày | Mục tiêu: ${goals.calories ?? "chưa đặt"} kcal
- Protein trung bình: ${avgProt}g/ngày | Mục tiêu: ${goals.protein ?? "chưa đặt"}g
- Carbs trung bình: ${avgCarbs}g/ngày | Mục tiêu: ${goals.carbs ?? "chưa đặt"}g
- Chất béo trung bình: ${avgFat}g/ngày | Mục tiêu: ${goals.fat ?? "chưa đặt"}g
- Chất xơ trung bình: ${avgFiber}g/ngày (WHO khuyến nghị ≥25g)

Trả về JSON thuần túy (không markdown, không giải thích thêm):
{
  "nhan_xet_tong_quan": "2-3 câu nhận xét tổng quan",
  "diem_manh": ["điểm mạnh 1", "điểm mạnh 2"],
  "can_cai_thien": ["điều cần cải thiện 1", "điều cần cải thiện 2", "điều cần cải thiện 3"],
  "thuc_pham_nen_them": ["thực phẩm cụ thể 1", "thực phẩm cụ thể 2", "thực phẩm cụ thể 3"],
  "thuc_pham_nen_giam": ["nhóm thực phẩm 1", "nhóm thực phẩm 2"],
  "ke_hoach_tuan_toi": "Gợi ý kế hoạch ăn uống tuần tới 2-3 câu cụ thể"
}`;

        const llm = getLLMService();
        const response = await llm.generate([
            {
                role: "system",
                content: "Bạn là chuyên gia dinh dưỡng người Việt Nam. Phân tích dữ liệu nhật ký ăn uống và đưa ra lời khuyên khoa học, thực tế, phù hợp văn hóa ẩm thực Việt. Luôn trả lời bằng JSON thuần túy, không có markdown hay text thêm.",
            },
            { role: "user", content: userPrompt },
        ]);

        let content: IReportDigestContent;
        try {
            content = JSON.parse(response.content.trim());
        } catch {
            const match = response.content.match(/\{[\s\S]*\}/);
            if (!match) {
                res.status(500).json({ error: "AI trả về định dạng không hợp lệ. Thử lại sau." });
                return;
            }
            content = JSON.parse(match[0]);
        }

        // Delete stale digests and save fresh one
        await ReportDigest.deleteMany({ user_id: user._id });
        const digest = await ReportDigest.create({
            user_id: user._id,
            period_days: days,
            content,
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        res.json({ content, generated_at: digest.generated_at, cached: false });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

export default router;
