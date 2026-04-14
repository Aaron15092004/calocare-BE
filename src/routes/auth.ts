import { Router, Request, Response } from "express";
import passport from "passport";
import rateLimit from "express-rate-limit";
import User, { IUser } from "../models/User";
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { authenticate } from "../middleware/auth";

const router = Router();

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: "Too many requests, please try again later" },
});

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