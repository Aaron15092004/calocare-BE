import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { authenticate } from "../middleware/auth";
import {
    atomicIncrement,
    getCount,
    todayKey,
    monthKey,
    secondsUntilMidnightUTC,
    secondsUntilEndOfMonthUTC,
    SCAN_REWARD_MAX,
    MEAL_PLAN_VIDEOS_REQUIRED,
} from "../middleware/ragRateLimit";
import { IUser } from "../models/User";

const router = Router();
const COL = "rate_limit_counters";

async function setUnlockFlag(unlockKey: string): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) return;
    const expiresAt = new Date(Date.now() + secondsUntilEndOfMonthUTC() * 1000);
    await db.collection(COL).updateOne(
        { key: unlockKey },
        {
            $set: { count: 1 },
            $setOnInsert: { key: unlockKey, expires_at: expiresAt },
        },
        { upsert: true },
    );
}

/**
 * GET /api/rewards/status
 * Returns current reward counters for the authenticated user.
 */
router.get("/status", authenticate, async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const userId = (user._id as { toString(): string }).toString();
    const tier = (user.subscription_tier ?? "free") as string;

    const today = todayKey();
    const month = monthKey();

    const [scanUsed, scanBonus, mealPlanVideos, mealPlanUnlock, chatUsed, mealPlanUsed] = await Promise.all([
        getCount(`${userId}:scan:${today}`),
        getCount(`${userId}:scan_reward_credit:${today}`),
        getCount(`${userId}:meal_plan_videos:${month}`),
        getCount(`${userId}:meal_plan_unlock:${month}`),
        getCount(`${userId}:chat:${today}`),
        getCount(`${userId}:meal-plan:${today}`),
    ]);

    const baseScanLimit = tier === "free" ? 2 : tier === "premium" ? 5 : -1;
    const effectiveScanLimit = baseScanLimit === -1
        ? -1
        : baseScanLimit + Math.min(scanBonus, SCAN_REWARD_MAX);

    const chatLimit   = tier === "free" ? 5  : tier === "premium" ? 100 : -1;
    const mealPlanLimit = tier === "free" ? 0 : tier === "premium" ? 1   : 5;

    res.json({
        scan: {
            used: scanUsed,
            base_limit: baseScanLimit,
            bonus_credits: Math.min(scanBonus, SCAN_REWARD_MAX),
            effective_limit: effectiveScanLimit,
            can_earn_more: tier === "free" && scanBonus < SCAN_REWARD_MAX,
            resets_at: today + "T23:59:59+07:00",
        },
        chat: {
            used: chatUsed,
            limit: chatLimit,
            resets_at: today + "T23:59:59+07:00",
        },
        meal_plan_generate: {
            used: mealPlanUsed,
            limit: mealPlanLimit,
            resets_at: today + "T23:59:59+07:00",
        },
        meal_plan: {
            videos_watched: Math.min(mealPlanVideos, MEAL_PLAN_VIDEOS_REQUIRED),
            videos_required: MEAL_PLAN_VIDEOS_REQUIRED,
            is_unlocked: mealPlanUnlock > 0,
            resets_at: month,
        },
    });
});

/**
 * POST /api/rewards/claim-scan-credit
 * Call this after the user successfully completes a rewarded video ad.
 * Grants +1 scan credit for today (max SCAN_REWARD_MAX credits per day, free tier only).
 */
router.post("/claim-scan-credit", authenticate, async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const tier = (user.subscription_tier ?? "free") as string;

    if (tier !== "free") {
        res.status(400).json({ error: "Rewarded ads are only for free tier users." });
        return;
    }

    const userId = (user._id as { toString(): string }).toString();
    const creditKey = `${userId}:scan_reward_credit:${todayKey()}`;

    const current = await getCount(creditKey);
    if (current >= SCAN_REWARD_MAX) {
        res.status(429).json({
            error: "reward_limit_reached",
            message: `Bạn đã đạt giới hạn ${SCAN_REWARD_MAX} lượt thưởng scan hôm nay.`,
            credits: current,
            max_credits: SCAN_REWARD_MAX,
        });
        return;
    }

    const newCount = await atomicIncrement(creditKey, secondsUntilMidnightUTC());

    res.json({
        success: true,
        credits: Math.min(newCount, SCAN_REWARD_MAX),
        max_credits: SCAN_REWARD_MAX,
        message: `+1 lượt scan! Bạn còn ${SCAN_REWARD_MAX - Math.min(newCount, SCAN_REWARD_MAX)} lượt thưởng hôm nay.`,
    });
});

/**
 * POST /api/rewards/claim-meal-plan-video
 * Call this after the user completes a rewarded video toward unlocking a free meal plan generation.
 * After MEAL_PLAN_VIDEOS_REQUIRED watches, sets the unlock flag for this month.
 */
router.post("/claim-meal-plan-video", authenticate, async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const tier = (user.subscription_tier ?? "free") as string;

    if (tier !== "free") {
        res.status(400).json({ error: "Rewarded ads are only for free tier users." });
        return;
    }

    const userId = (user._id as { toString(): string }).toString();
    const month = monthKey();
    const videosKey = `${userId}:meal_plan_videos:${month}`;
    const unlockKey = `${userId}:meal_plan_unlock:${month}`;

    // Check if already unlocked (prevents watching more after unlock while it's unused)
    const alreadyUnlocked = await getCount(unlockKey);
    if (alreadyUnlocked > 0) {
        res.json({
            success: true,
            already_unlocked: true,
            videos_watched: MEAL_PLAN_VIDEOS_REQUIRED,
            videos_required: MEAL_PLAN_VIDEOS_REQUIRED,
            is_unlocked: true,
            message: "Bạn đã mở khóa 1 lượt tạo thực đơn tháng này!",
        });
        return;
    }

    const currentVideos = await getCount(videosKey);
    if (currentVideos >= MEAL_PLAN_VIDEOS_REQUIRED) {
        // Edge case: videos recorded but unlock flag missing — set it now
        await setUnlockFlag(unlockKey);
        res.json({
            success: true,
            videos_watched: MEAL_PLAN_VIDEOS_REQUIRED,
            videos_required: MEAL_PLAN_VIDEOS_REQUIRED,
            is_unlocked: true,
            message: "Bạn đã mở khóa 1 lượt tạo thực đơn tháng này!",
        });
        return;
    }

    const newCount = await atomicIncrement(videosKey, secondsUntilEndOfMonthUTC());
    const capped = Math.min(newCount, MEAL_PLAN_VIDEOS_REQUIRED);
    const unlocked = capped >= MEAL_PLAN_VIDEOS_REQUIRED;

    if (unlocked) {
        await setUnlockFlag(unlockKey);
    }

    res.json({
        success: true,
        videos_watched: capped,
        videos_required: MEAL_PLAN_VIDEOS_REQUIRED,
        is_unlocked: unlocked,
        message: unlocked
            ? "Chúc mừng! Bạn đã mở khóa 1 lượt tạo thực đơn miễn phí tháng này!"
            : `Đã xem ${capped}/${MEAL_PLAN_VIDEOS_REQUIRED} video. Còn ${MEAL_PLAN_VIDEOS_REQUIRED - capped} video nữa!`,
    });
});

export default router;
