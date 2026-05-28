import { Router, Request, Response } from "express";
import crypto from "crypto";
import { authenticate } from "../middleware/auth";
import User, { IUser } from "../models/User";
import Referral from "../models/Referral";

const router = Router();
router.use(authenticate);

const REFERRER_BONUS_DAYS = 30;
const REFEREE_BONUS_DAYS = 7;

function generateCode(): string {
    return crypto.randomBytes(4).toString("hex").toUpperCase(); // 8-char hex e.g. "A3F2B8C1"
}

async function getOrCreateReferralCode(userId: string): Promise<string> {
    const user = await User.findById(userId).select("referral_code").lean();
    if (user?.referral_code) return user.referral_code;

    let code: string;
    let attempts = 0;
    do {
        code = generateCode();
        attempts++;
        if (attempts > 10) throw new Error("Could not generate unique referral code");
    } while (await User.exists({ referral_code: code }));

    await User.findByIdAndUpdate(userId, { referral_code: code });
    return code;
}

function addDays(date: Date | undefined, days: number): Date {
    const base = date && date > new Date() ? date : new Date();
    return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

// GET /api/referrals/my-code — get (or generate) caller's referral code + stats
router.get("/my-code", async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();

    const code = await getOrCreateReferralCode(userId);

    const [totalReferrals, recentReferrals] = await Promise.all([
        Referral.countDocuments({ referrer_id: userId }),
        Referral.find({ referrer_id: userId })
            .sort({ used_at: -1 })
            .limit(10)
            .populate("referee_id", "display_name created_at")
            .lean(),
    ]);

    const bonusDaysEarned = totalReferrals * REFERRER_BONUS_DAYS;

    res.json({
        code,
        referral_url: `https://calocare.app/join?ref=${code}`,
        total_referrals: totalReferrals,
        bonus_days_earned: bonusDaysEarned,
        recent_referrals: recentReferrals.map((r) => ({
            display_name: (r.referee_id as any)?.display_name ?? "Người dùng",
            used_at: r.used_at,
            bonus_days: r.referrer_bonus_days,
        })),
        referrer_bonus_days: REFERRER_BONUS_DAYS,
        referee_bonus_days: REFEREE_BONUS_DAYS,
    });
});

// POST /api/referrals/apply — apply a referral code; only once per user
router.post("/apply", async (req: Request, res: Response) => {
    const caller = req.user as IUser;
    const callerId = caller._id.toString();
    const { code } = req.body as { code?: string };

    if (!code || typeof code !== "string") {
        res.status(400).json({ error: "Mã giới thiệu không hợp lệ" });
        return;
    }

    const upperCode = code.trim().toUpperCase();

    // Can't apply own code
    if (caller.referral_code === upperCode) {
        res.status(400).json({ error: "Không thể dùng mã giới thiệu của chính mình" });
        return;
    }

    // Already applied a code
    const alreadyUsed = await Referral.exists({ referee_id: callerId });
    if (alreadyUsed) {
        res.status(400).json({ error: "Bạn đã sử dụng mã giới thiệu rồi" });
        return;
    }

    // Find referrer
    const referrer = await User.findOne({ referral_code: upperCode })
        .select("_id subscription_tier subscription_expires_at")
        .lean();
    if (!referrer) {
        res.status(404).json({ error: "Mã giới thiệu không tồn tại" });
        return;
    }

    // Referrer must have or have had premium (keeps incentive meaningful)
    if (referrer.subscription_tier === "free" && !referrer.subscription_expires_at) {
        res.status(400).json({ error: "Người giới thiệu chưa từng dùng gói Premium" });
        return;
    }

    // Apply: extend referrer's subscription by REFERRER_BONUS_DAYS
    const referrerNewExpiry = addDays(referrer.subscription_expires_at, REFERRER_BONUS_DAYS);
    await User.findByIdAndUpdate(referrer._id, {
        subscription_expires_at: referrerNewExpiry,
        ...(referrer.subscription_tier === "free" ? { subscription_tier: "premium" } : {}),
    });

    // Apply: extend caller's subscription by REFEREE_BONUS_DAYS (or start trial)
    const callerUser = await User.findById(callerId).select("subscription_tier subscription_expires_at").lean();
    const callerNewExpiry = addDays(callerUser?.subscription_expires_at, REFEREE_BONUS_DAYS);
    await User.findByIdAndUpdate(callerId, {
        subscription_expires_at: callerNewExpiry,
        ...(callerUser?.subscription_tier === "free" ? { subscription_tier: "premium" } : {}),
    });

    // Record the referral
    await Referral.create({
        referrer_id: referrer._id,
        referee_id: callerId,
        code: upperCode,
        referrer_bonus_days: REFERRER_BONUS_DAYS,
        referee_bonus_days: REFEREE_BONUS_DAYS,
    });

    res.json({
        ok: true,
        referee_bonus_days: REFEREE_BONUS_DAYS,
        referrer_bonus_days: REFERRER_BONUS_DAYS,
        message: `Bạn nhận được ${REFEREE_BONUS_DAYS} ngày Premium. Người giới thiệu được gia hạn thêm ${REFERRER_BONUS_DAYS} ngày!`,
    });
});

export default router;
