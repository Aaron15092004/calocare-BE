import { Router, Request, Response } from "express";
import passport from "passport";
import rateLimit from "express-rate-limit";
import User, { IUser } from "../models/User";
import ChatSession from "../models/ChatSession";
import FoodDiary from "../models/FoodDiary";
import MealProgress from "../models/MealProgress";
import PaymentTransaction from "../models/PaymentTransaction";
import ReportDigest from "../models/ReportDigest";
import Review from "../models/Review";
import Referral from "../models/Referral";
import UserFavorite from "../models/UserFavorite";
import UserMealPlan from "../models/UserMealPlan";
import UserMealPlanItem from "../models/UserMealPlanItem";
import MealPlan from "../models/MealPlan";
import MealPlanItem from "../models/MealPlanItem";
import Store from "../models/Store";
import Recipe from "../models/Recipe";
import Food from "../models/Food";
import EnrichmentQueue from "../models/EnrichmentQueue";
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { authenticate } from "../middleware/auth";

const router = Router();

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: "Too many requests, please try again later" },
});

async function recalcRatingsForTargets(
    targets: Array<{ target_type: "recipe" | "store"; target_id: string }>,
) {
    const uniqueTargets = new Map<string, { target_type: "recipe" | "store"; target_id: string }>();
    for (const target of targets) {
        uniqueTargets.set(`${target.target_type}:${target.target_id}`, target);
    }

    await Promise.all(
        Array.from(uniqueTargets.values()).map(async ({ target_type, target_id }) => {
            const agg = await Review.aggregate([
                {
                    $match: {
                        target_type,
                        target_id: userObjectId(target_id),
                        is_deleted: false,
                    },
                },
                { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
            ]);

            const average = Math.round((agg[0]?.avg ?? 0) * 10) / 10;
            const count = agg[0]?.count ?? 0;

            if (target_type === "recipe") {
                await Recipe.findByIdAndUpdate(target_id, { average_rating: average, rating_count: count });
            } else {
                await Store.findByIdAndUpdate(target_id, { average_rating: average, rating_count: count });
            }
        }),
    );
}

function userObjectId(id: string) {
    return User.db.base.Types.ObjectId.createFromHexString(id);
}

// POST /api/auth/register
router.post("/register", authLimiter, async (req: Request, res: Response) => {
    try {
        const { email, password, display_name } = req.body;
        if (!email || !password || !display_name) {
            res.status(400).json({ error: "email, password, and display_name are required" });
            return;
        }
        const existing = await User.findOne({ email });
        if (existing) {
            res.status(409).json({ error: "Email already registered" });
            return;
        }
        const user = await User.create({ email, password, display_name });
        const accessToken = generateAccessToken(user._id.toString());
        const refreshToken = generateRefreshToken(user._id.toString());
        await User.findByIdAndUpdate(user._id, { $push: { refresh_tokens: refreshToken } });

        res.status(201).json({
            access_token: accessToken,
            refresh_token: refreshToken,
            user: {
                id: user._id,
                email: user.email,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
                role: user.role,
                subscription_tier: user.subscription_tier,
                language: user.language,
                daily_nutrition_goals: user.daily_nutrition_goals,
                preferences: user.preferences,
            },
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/auth/login
router.post("/login", authLimiter, async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            res.status(400).json({ error: "email and password are required" });
            return;
        }
        const user = await User.findOne({ email }).select("+password");
        if (!user || !(await user.comparePassword(password))) {
            res.status(401).json({ error: "Invalid email or password" });
            return;
        }
        if (user.is_banned) {
            res.status(403).json({ error: "Account is banned" });
            return;
        }

        const accessToken = generateAccessToken(user._id.toString());
        const refreshToken = generateRefreshToken(user._id.toString());
        await User.findByIdAndUpdate(user._id, { $push: { refresh_tokens: refreshToken } });

        res.json({
            access_token: accessToken,
            refresh_token: refreshToken,
            user: {
                id: user._id,
                email: user.email,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
                role: user.role,
                subscription_tier: user.subscription_tier,
                language: user.language,
                daily_nutrition_goals: user.daily_nutrition_goals,
                preferences: user.preferences,
            },
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/auth/refresh
router.post("/refresh", async (req: Request, res: Response) => {
    try {
        const { refresh_token } = req.body;
        if (!refresh_token) {
            res.status(400).json({ error: "refresh_token is required" });
            return;
        }
        const payload = verifyRefreshToken(refresh_token);
        const user = await User.findById(payload.id).select("+refresh_tokens");
        if (!user || !user.refresh_tokens.includes(refresh_token)) {
            res.status(401).json({ error: "Invalid refresh token" });
            return;
        }

        const accessToken = generateAccessToken(user._id.toString());
        const newRefreshToken = generateRefreshToken(user._id.toString());

        // Rotate refresh token
        await User.findByIdAndUpdate(user._id, {
            $pull: { refresh_tokens: refresh_token },
            $push: { refresh_tokens: newRefreshToken },
        });

        res.json({ access_token: accessToken, refresh_token: newRefreshToken });
    } catch {
        res.status(401).json({ error: "Invalid or expired refresh token" });
    }
});

// POST /api/auth/logout
router.post("/logout", authenticate, async (req: Request, res: Response) => {
    try {
        const { refresh_token } = req.body;
        const user = req.user as IUser;
        if (refresh_token) {
            await User.findByIdAndUpdate(user._id, { $pull: { refresh_tokens: refresh_token } });
        }
        res.json({ message: "Logged out successfully" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// DELETE /api/auth/account
router.delete("/account", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation.trim() : "";

        if (confirmation !== "DELETE") {
            res.status(400).json({ error: "confirmation must be DELETE" });
            return;
        }

        const userId = user._id.toString();
        const userObjectIdValue = userObjectId(userId);

        const [ownedStores, ownedMealPlans, ownReviews, userMealPlans] = await Promise.all([
            Store.find({ owner_id: userObjectIdValue }).select("_id").lean(),
            MealPlan.find({ creator_id: userObjectIdValue }).select("_id").lean(),
            Review.find({ user_id: userObjectIdValue, is_deleted: false }).select("target_type target_id").lean(),
            UserMealPlan.find({ user_id: userObjectIdValue }).select("_id").lean(),
        ]);

        const ownedStoreIds = ownedStores.map((store) => store._id);
        const ownedMealPlanIds = ownedMealPlans.map((plan) => plan._id);
        const userMealPlanIds = userMealPlans.map((plan) => plan._id);

        await Promise.all([
            ChatSession.deleteMany({ user_id: userObjectIdValue }),
            FoodDiary.deleteMany({ user_id: userObjectIdValue }),
            MealProgress.deleteMany({ user_id: userObjectIdValue }),
            PaymentTransaction.deleteMany({ user_id: userObjectIdValue }),
            ReportDigest.deleteMany({ user_id: userObjectIdValue }),
            UserFavorite.deleteMany({ user_id: userObjectIdValue }),
            Referral.deleteMany({ $or: [{ referrer_id: userObjectIdValue }, { referee_id: userObjectIdValue }] }),
            EnrichmentQueue.deleteMany({ user_id: userObjectIdValue }),
            Review.deleteMany({ user_id: userObjectIdValue }),
            Review.updateMany({ helpful_votes: userObjectIdValue }, { $pull: { helpful_votes: userObjectIdValue } }),
            UserMealPlanItem.deleteMany({ user_meal_plan_id: { $in: userMealPlanIds } }),
            UserMealPlan.deleteMany({ user_id: userObjectIdValue }),
            MealPlanItem.deleteMany({ meal_plan_id: { $in: ownedMealPlanIds } }),
            MealPlan.deleteMany({ creator_id: userObjectIdValue }),
            Review.deleteMany({ target_type: "store", target_id: { $in: ownedStoreIds } }),
            Store.deleteMany({ owner_id: userObjectIdValue }),
            Recipe.updateMany({ creator_id: userObjectIdValue }, { $unset: { creator_id: 1 } }),
            Food.updateMany({ creator_id: userObjectIdValue }, { $unset: { creator_id: 1 } }),
            User.findByIdAndDelete(userObjectIdValue),
        ]);

        await recalcRatingsForTargets(
            ownReviews.map((review) => ({
                target_type: review.target_type,
                target_id: review.target_id.toString(),
            })),
        );

        res.json({ success: true, message: "Account deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/auth/google
router.get(
    "/google",
    passport.authenticate("google", { scope: ["profile", "email"], session: false }),
);

// GET /api/auth/google/callback
router.get(
    "/google/callback",
    passport.authenticate("google", { session: false, failureRedirect: `${process.env.FRONTEND_URL}/auth?error=oauth_failed` }),
    async (req: Request, res: Response) => {
        try {
            const user = req.user as IUser;
            const accessToken = generateAccessToken(user._id.toString());
            const refreshToken = generateRefreshToken(user._id.toString());
            await User.findByIdAndUpdate(user._id, { $push: { refresh_tokens: refreshToken } });

            const frontendUrl = process.env.FRONTEND_URL || "http://localhost:2004";
            res.redirect(
                `${frontendUrl}/auth/callback?access_token=${accessToken}&refresh_token=${refreshToken}`,
            );
        } catch (error) {
            res.redirect(`${process.env.FRONTEND_URL}/auth?error=oauth_failed`);
        }
    },
);

// GET /api/auth/me
router.get("/me", authenticate, (req: Request, res: Response) => {
    const user = req.user as IUser;
    res.json({
        id: user._id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        role: user.role,
        subscription_tier: user.subscription_tier,
        subscription_expires_at: user.subscription_expires_at,
        is_banned: user.is_banned,
        language: user.language,
        daily_nutrition_goals: user.daily_nutrition_goals,
        preferences: user.preferences,
        created_at: user.created_at,
    });
});

export default router;
