import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import User, { IUser } from "../models/User";

const router = Router();

// GET /api/profile
router.get("/", authenticate, (req: Request, res: Response) => {
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

// PUT /api/profile
router.put("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { display_name, avatar_url, language, daily_nutrition_goals, preferences } = req.body;

        const updated = await User.findByIdAndUpdate(
            user._id,
            {
                ...(display_name !== undefined && { display_name }),
                ...(avatar_url !== undefined && { avatar_url }),
                ...(language !== undefined && { language }),
                ...(daily_nutrition_goals !== undefined && { daily_nutrition_goals }),
                ...(preferences !== undefined && { preferences }),
            },
            { new: true, runValidators: true },
        );

        if (!updated) {
            res.status(404).json({ error: "User not found" });
            return;
        }

        res.json({
            id: updated._id,
            email: updated.email,
            display_name: updated.display_name,
            avatar_url: updated.avatar_url,
            role: updated.role,
            subscription_tier: updated.subscription_tier,
            language: updated.language,
            daily_nutrition_goals: updated.daily_nutrition_goals,
            preferences: updated.preferences,
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;