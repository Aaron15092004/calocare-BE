import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { IUser } from "../models/User";

type Tier = "free" | "premium" | "family" | "pro";
type Endpoint = "search" | "chat" | "scan" | "meal-plan";

function normalizeTier(tier?: string | null): Tier {
    if (tier === "pro") return "family";
    return (tier as Tier) || "free";
}

const LIMITS: Record<Endpoint, Record<Tier, number>> = {
    search:      { free: 20,  premium: 200, family: -1, pro: -1 },
    chat:        { free: 5,   premium: 100, family: -1, pro: -1 },
    scan:        { free: 2,   premium: 5,   family: -1, pro: -1 },
    "meal-plan": { free: 0,   premium: 1,   family: 5,  pro: 5 },
};

// Free tier base scan limit; rewarded ads can add up to this many bonus credits
export const SCAN_REWARD_MAX = 3;
// Videos required to unlock 1 free meal plan generation per month
export const MEAL_PLAN_VIDEOS_REQUIRED = 5;

const COL = "rate_limit_counters";
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

let _indexReady = false;
async function ensureIndexes(): Promise<void> {
    if (_indexReady) return;
    const db = mongoose.connection.db;
    if (!db) return;
    try {
        const col = db.collection(COL);
        await col.createIndex({ key: 1 }, { unique: true, background: true });
        await col.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, background: true });
        _indexReady = true;
    } catch {
        _indexReady = true;
    }
}

export function todayKey(): string {
    return new Date(Date.now() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

export function monthKey(): string {
    return new Date(Date.now() + VN_OFFSET_MS).toISOString().slice(0, 7);
}

function secondsUntilMidnightUTC(): number {
    const shiftedNow = new Date(Date.now() + VN_OFFSET_MS);
    const nextMidnightInShiftedUtc = Date.UTC(
        shiftedNow.getUTCFullYear(),
        shiftedNow.getUTCMonth(),
        shiftedNow.getUTCDate() + 1,
    );
    const nextMidnightVietnam = nextMidnightInShiftedUtc - VN_OFFSET_MS;
    return Math.ceil((nextMidnightVietnam - Date.now()) / 1000);
}

export function secondsUntilEndOfMonthUTC(): number {
    const shiftedNow = new Date(Date.now() + VN_OFFSET_MS);
    const nextMonthInShiftedUtc = Date.UTC(
        shiftedNow.getUTCFullYear(),
        shiftedNow.getUTCMonth() + 1,
        1,
    );
    const nextMonthVietnam = nextMonthInShiftedUtc - VN_OFFSET_MS;
    return Math.ceil((nextMonthVietnam - Date.now()) / 1000);
}

async function atomicIncrement(key: string, ttlSeconds?: number): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 1;

    await ensureIndexes();

    const secs = ttlSeconds ?? secondsUntilMidnightUTC();
    const expiresAt = new Date(Date.now() + secs * 1000);
    try {
        const result = await db.collection(COL).findOneAndUpdate(
            { key },
            {
                $inc: { count: 1 },
                $setOnInsert: { key, expires_at: expiresAt },
            },
            { upsert: true, returnDocument: "after" },
        );
        return (result?.count as number | undefined) ?? 1;
    } catch {
        try {
            const doc = await db.collection(COL).findOne({ key });
            return (doc?.count as number | undefined) ?? 1;
        } catch {
            return 1;
        }
    }
}

async function atomicDecrement(key: string): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) return;
    await ensureIndexes();
    await db.collection(COL).updateOne(
        { key, count: { $gt: 0 } },
        { $inc: { count: -1 } },
    );
}

// Read a counter without modifying it
async function getCount(key: string): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;
    await ensureIndexes();
    const doc = await db.collection(COL).findOne({ key });
    return (doc?.count as number | undefined) ?? 0;
}

// Atomically consume the meal plan reward unlock (set count 1→0).
// Returns true if the unlock existed and was successfully consumed.
async function consumeMealPlanUnlock(unlockKey: string): Promise<boolean> {
    const db = mongoose.connection.db;
    if (!db) return false;
    await ensureIndexes();
    const result = await db.collection(COL).findOneAndUpdate(
        { key: unlockKey, count: { $gt: 0 } },
        { $set: { count: 0 } },
    );
    return result !== null;
}

// Exported helpers used by rewards route
export { atomicIncrement, getCount, secondsUntilMidnightUTC };

export function ragRateLimit(endpoint: Endpoint) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const user = req.user as IUser | undefined;
        if (!user) { next(); return; }

        const tier = normalizeTier(user.subscription_tier);
        const limit = LIMITS[endpoint][tier] ?? 0;

        if (limit === -1) { next(); return; }

        const userId = (user._id as { toString(): string }).toString();

        // Free meal-plan: blocked by default unless user has a reward unlock
        if (limit === 0 && endpoint === "meal-plan") {
            const unlockKey = `${userId}:meal_plan_unlock:${monthKey()}`;
            const consumed = await consumeMealPlanUnlock(unlockKey);
            if (!consumed) {
                res.status(403).json({
                    error: "feature_locked",
                    message: "Tính năng này yêu cầu gói Premium hoặc xem đủ 5 video thưởng.",
                    required_tier: "premium",
                });
                return;
            }
            // Unlock consumed — allow this one generation
            next();
            return;
        }

        if (limit === 0) {
            res.status(403).json({
                error: "feature_locked",
                message: "Tính năng này yêu cầu gói Premium trở lên.",
                required_tier: "premium",
            });
            return;
        }

        const key = `${userId}:${endpoint}:${todayKey()}`;

        // Scan endpoint: effective limit = base + reward credits earned today
        let effectiveLimit = limit;
        if (endpoint === "scan" && tier === "free") {
            const bonusCredits = await getCount(`${userId}:scan_reward_credit:${todayKey()}`);
            effectiveLimit = limit + Math.min(bonusCredits, SCAN_REWARD_MAX);
        }

        const current = await atomicIncrement(key);

        if (current > effectiveLimit) {
            await atomicDecrement(key);
            const isScan = endpoint === "scan" && tier === "free";
            res.status(429).json({
                error: "rate_limit_exceeded",
                message: isScan
                    ? `Bạn đã dùng hết ${effectiveLimit} lượt scan hôm nay. Xem video thưởng để được thêm lượt.`
                    : `Bạn đã dùng hết ${limit} lượt ${endpoint} hôm nay.`,
                used: effectiveLimit,
                limit: effectiveLimit,
                resets_at: todayKey() + "T23:59:59+07:00",
                can_watch_ad: isScan && effectiveLimit < (limit + SCAN_REWARD_MAX),
            });
            return;
        }

        res.setHeader("X-RateLimit-Limit", effectiveLimit);
        res.setHeader("X-RateLimit-Remaining", effectiveLimit - current);
        res.on("finish", () => {
            if (res.statusCode >= 400) {
                atomicDecrement(key).catch(() => {});
            }
        });
        next();
    };
}
