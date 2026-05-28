import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { requireAdminOrModerator } from "../../middleware/roleCheck";
import User from "../../models/User";
import Recipe from "../../models/Recipe";
import Food from "../../models/Food";
import MealPlan from "../../models/MealPlan";
import PaymentTransaction from "../../models/PaymentTransaction";
import FoodDiary from "../../models/FoodDiary";
import FoodGroup from "../../models/FoodGroup";
import Store from "../../models/Store";

const router = Router();

// GET /api/admin/dashboard
router.get("/", authenticate, requireAdminOrModerator, async (_req: Request, res: Response) => {
    try {
        const now = new Date();
        const startOf12MonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
        const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [
            totalUsers,
            totalRecipes,
            totalFoods,
            totalMealPlans,
            recentTransactions,
            totalRevenueAgg,
            newUsersThisMonth,
            recentDiaryEntries,
            usersByMonth,
            revenueByMonth,
            diaryLast7Days,
            foodsByGroup,
            pendingRecipes,
            subscriptionTierAgg,
            totalStores,
            pendingStores,
            storeStatusAgg,
        ] = await Promise.all([
            User.countDocuments(),
            Recipe.countDocuments({ is_deleted: { $ne: true } }),
            Food.countDocuments({ is_deleted: { $ne: true } }),
            MealPlan.countDocuments(),
            PaymentTransaction.find({ status: "completed" })
                .sort({ created_at: -1 })
                .limit(10)
                .populate("user_id", "display_name email"),
            PaymentTransaction.aggregate([
                { $match: { status: "completed" } },
                { $group: { _id: null, total: { $sum: "$final_amount" } } },
            ]),
            User.countDocuments({ created_at: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) } }),
            FoodDiary.countDocuments({ created_at: { $gte: last7Days } }),

            // Users registered per month (last 12 months)
            User.aggregate([
                { $match: { created_at: { $gte: startOf12MonthsAgo } } },
                {
                    $group: {
                        _id: { year: { $year: "$created_at" }, month: { $month: "$created_at" } },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } },
            ]),

            // Revenue per month (last 12 months)
            PaymentTransaction.aggregate([
                { $match: { status: "completed", created_at: { $gte: startOf12MonthsAgo } } },
                {
                    $group: {
                        _id: { year: { $year: "$created_at" }, month: { $month: "$created_at" } },
                        revenue: { $sum: "$final_amount" },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } },
            ]),

            // Diary entries per day (last 7 days)
            FoodDiary.aggregate([
                { $match: { created_at: { $gte: last7Days } } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ]),

            // Foods count per group
            Food.aggregate([
                { $match: { is_deleted: { $ne: true }, food_group_id: { $exists: true, $ne: null } } },
                { $group: { _id: "$food_group_id", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 8 },
                {
                    $lookup: {
                        from: "foodgroups",
                        localField: "_id",
                        foreignField: "_id",
                        as: "group",
                    },
                },
                { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
            ]),

            // Pending recipes
            Recipe.countDocuments({ is_public: true, is_approved: false, is_deleted: { $ne: true } }),

            // User subscription tier breakdown
            User.aggregate([
                { $group: { _id: "$subscription_tier", count: { $sum: 1 } } },
            ]),

            // Total stores
            Store.countDocuments(),

            // Pending (not yet approved) stores
            Store.countDocuments({ is_active: false }),

            // Store status breakdown: active vs pending
            Store.aggregate([
                {
                    $group: {
                        _id: "$is_active",
                        count: { $sum: 1 },
                    },
                },
            ]),
        ]);

        // Build a complete 12-month series with zeros for missing months
        const months: { label: string; year: number; month: number }[] = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({
                label: d.toLocaleString("vi-VN", { month: "short", year: "2-digit" }),
                year: d.getFullYear(),
                month: d.getMonth() + 1,
            });
        }

        const usersByMonthMap = new Map(
            usersByMonth.map((r: any) => [`${r._id.year}-${r._id.month}`, r.count])
        );
        const revenueByMonthMap = new Map(
            revenueByMonth.map((r: any) => [`${r._id.year}-${r._id.month}`, { revenue: r.revenue, count: r.count }])
        );

        const userGrowthChart = months.map((m) => ({
            name: m.label,
            users: usersByMonthMap.get(`${m.year}-${m.month}`) || 0,
        }));

        const revenueChart = months.map((m) => {
            const entry = revenueByMonthMap.get(`${m.year}-${m.month}`) as any;
            return {
                name: m.label,
                revenue: entry?.revenue || 0,
                transactions: entry?.count || 0,
            };
        });

        // Diary last 7 days
        const diaryMap = new Map(diaryLast7Days.map((r: any) => [r._id, r.count]));
        const diaryChart = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(Date.now() - (6 - i) * 86400000);
            const key = d.toISOString().slice(0, 10);
            return {
                name: d.toLocaleDateString("vi-VN", { weekday: "short" }),
                entries: diaryMap.get(key) || 0,
            };
        });

        // Food group distribution
        const foodGroupChart = foodsByGroup.map((r: any) => ({
            name: r.group?.name_vi || "Unknown",
            value: r.count,
        }));

        // Subscription tier distribution
        const tierOrder = ["free", "premium", "pro"];
        const tierMap = new Map(subscriptionTierAgg.map((r: any) => [r._id || "free", r.count]));
        const subscriptionTierChart = tierOrder.map((tier) => ({
            name: tier.charAt(0).toUpperCase() + tier.slice(1),
            value: tierMap.get(tier) || 0,
        }));

        // Store status breakdown
        const storeStatusMap = new Map(storeStatusAgg.map((r: any) => [r._id, r.count]));
        const storeStatusChart = [
            { name: "Active", value: storeStatusMap.get(true) || 0 },
            { name: "Pending", value: storeStatusMap.get(false) || 0 },
        ];

        res.json({
            stats: {
                total_users: totalUsers,
                total_recipes: totalRecipes,
                total_foods: totalFoods,
                total_meal_plans: totalMealPlans,
                total_revenue: totalRevenueAgg[0]?.total || 0,
                new_users_this_month: newUsersThisMonth,
                diary_entries_last_7days: recentDiaryEntries,
                pending_recipes: pendingRecipes,
                total_stores: totalStores,
                pending_stores: pendingStores,
            },
            charts: {
                user_growth: userGrowthChart,
                revenue: revenueChart,
                diary_activity: diaryChart,
                food_group_distribution: foodGroupChart,
                subscription_tier_distribution: subscriptionTierChart,
                store_status: storeStatusChart,
            },
            recent_transactions: recentTransactions,
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
