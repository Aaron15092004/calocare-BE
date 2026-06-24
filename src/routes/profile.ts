import { Router, Request, Response } from "express";
import { z } from "zod";
import multer from "multer";
import { authenticate } from "../middleware/auth";
import User, { IUser } from "../models/User";
import { uploadBuffer } from "../services/CloudinaryService";

const router = Router();
const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("image/")),
});

function isSafePreferenceKey(key: string): boolean {
    return Boolean(key) &&
        !key.includes(".") &&
        !key.startsWith("$") &&
        !["__proto__", "constructor", "prototype"].includes(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onboardingCompleted(user: Pick<IUser, "preferences" | "daily_nutrition_goals">): boolean {
    const preferences = (user.preferences ?? {}) as Record<string, unknown>;
    if (Boolean(preferences.onboarding_completed)) return true;

    const hasLegacyProfile = [
        preferences.age,
        preferences.gender,
        preferences.height_cm,
        preferences.weight_kg,
        preferences.activity_level,
        preferences.goal,
        user.daily_nutrition_goals?.calories,
    ].every((value) => value !== undefined && value !== null && value !== "");

    return hasLegacyProfile;
}

function legacyProfileFields(user: Pick<IUser, "preferences" | "daily_nutrition_goals">) {
    const preferences = user.preferences as Record<string, unknown>;
    return {
        age: preferences?.age,
        gender: preferences?.gender,
        height_cm: preferences?.height_cm,
        weight_kg: preferences?.weight_kg,
        activity_level: preferences?.activity_level,
        goal: preferences?.goal,
        daily_calorie_goal: user.daily_nutrition_goals?.calories,
    };
}

function calculateDailyGoals(input: {
    age: number;
    gender: "male" | "female" | "other";
    height_cm: number;
    weight_kg: number;
    activity_level: "sedentary" | "light" | "moderate" | "active" | "very_active";
    goal: "lose_weight" | "maintain" | "gain_weight";
}) {
    const bmr = input.gender === "male"
        ? 10 * input.weight_kg + 6.25 * input.height_cm - 5 * input.age + 5
        : 10 * input.weight_kg + 6.25 * input.height_cm - 5 * input.age - 161;
    const activity: Record<typeof input.activity_level, number> = {
        sedentary: 1.2,
        light: 1.375,
        moderate: 1.55,
        active: 1.725,
        very_active: 1.9,
    };
    const adjustment = input.goal === "lose_weight" ? -350 : input.goal === "gain_weight" ? 300 : 0;
    const calories = Math.max(1200, Math.round(bmr * activity[input.activity_level] + adjustment));
    return {
        calories,
        protein: Math.round(input.weight_kg * 1.6),
        carbs: Math.round((calories * 0.45) / 4),
        fat: Math.round((calories * 0.3) / 9),
        fiber: 25,
    };
}

const OnboardingSchema = z.object({
    display_name: z.string().trim().min(2).max(80).optional(),
    age: z.number().int().min(18).max(120),
    gender: z.enum(["male", "female", "other"]),
    height_cm: z.number().min(100).max(250),
    weight_kg: z.number().min(30).max(300),
    activity_level: z.enum(["sedentary", "light", "moderate", "active", "very_active"]),
    goal: z.enum(["lose_weight", "maintain", "gain_weight"]),
});

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
        onboarding_completed: onboardingCompleted(user),
        ...legacyProfileFields(user),
        created_at: user.created_at,
    });
});

// PUT /api/profile
router.put("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { display_name, avatar_url, language, daily_nutrition_goals, preferences, age, gender, height_cm, weight_kg, activity_level, goal, daily_calorie_goal } = req.body;
        const setOps: Record<string, unknown> = {
            ...(display_name !== undefined && { display_name }),
            ...(avatar_url !== undefined && { avatar_url }),
            ...(language !== undefined && { language }),
            ...(daily_nutrition_goals !== undefined && { daily_nutrition_goals }),
        };

        if (daily_calorie_goal !== undefined && Number.isFinite(Number(daily_calorie_goal))) {
            setOps.daily_nutrition_goals = {
                ...user.daily_nutrition_goals,
                calories: Number(daily_calorie_goal),
            };
        }

        for (const [key, value] of Object.entries({ age, gender, height_cm, weight_kg, activity_level, goal })) {
            if (value !== undefined) setOps[`preferences.${key}`] = value;
        }

        if (preferences !== undefined) {
            if (!isPlainObject(preferences)) {
                res.status(400).json({ error: "preferences must be an object" });
                return;
            }

            for (const [key, value] of Object.entries(preferences)) {
                if (value === undefined) continue;
                if (!isSafePreferenceKey(key)) {
                    res.status(400).json({ error: `Invalid preference key: ${key}` });
                    return;
                }
                setOps[`preferences.${key}`] = value;
            }
        }

        const updated = await User.findByIdAndUpdate(
            user._id,
            { $set: setOps },
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
            subscription_expires_at: updated.subscription_expires_at ?? null,
            language: updated.language,
            daily_nutrition_goals: updated.daily_nutrition_goals,
            preferences: updated.preferences,
            onboarding_completed: onboardingCompleted(updated),
            ...legacyProfileFields(updated),
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/avatar", authenticate, avatarUpload.single("avatar"), async (req: Request, res: Response) => {
    if (!req.file) { res.status(400).json({ error: "image_required" }); return; }
    const user = req.user as IUser;
    const url = await uploadBuffer(req.file.buffer, `user-${user._id}`);
    if (!url) { res.status(502).json({ error: "avatar_upload_failed" }); return; }
    await User.findByIdAndUpdate(user._id, { $set: { avatar_url: url } });
    res.json({ avatar_url: url });
});

// PUT /api/profile/onboarding - persist the existing onboarding answers and
// derive a reusable nutrition baseline without collecting extra data.
router.put("/onboarding", authenticate, async (req: Request, res: Response) => {
    const parsed = OnboardingSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid onboarding data", details: parsed.error.flatten() });
        return;
    }

    try {
        const currentUser = req.user as IUser;
        const goals = calculateDailyGoals(parsed.data);
        const resolvedDisplayName =
            parsed.data.display_name?.trim() ||
            currentUser.display_name?.trim() ||
            currentUser.email?.split("@")[0] ||
            "CaloVie User";
        const updated = await User.findByIdAndUpdate(
            currentUser._id,
            {
                $set: {
                    display_name: resolvedDisplayName,
                    daily_nutrition_goals: goals,
                    "preferences.age": parsed.data.age,
                    "preferences.gender": parsed.data.gender,
                    "preferences.height_cm": parsed.data.height_cm,
                    "preferences.weight_kg": parsed.data.weight_kg,
                    "preferences.activity_level": parsed.data.activity_level,
                    "preferences.goal": parsed.data.goal,
                    "preferences.onboarding_completed": true,
                },
            },
            { new: true, runValidators: true },
        );
        if (!updated) { res.status(404).json({ error: "User not found" }); return; }
        res.json({
            ok: true,
            daily_nutrition_goals: updated.daily_nutrition_goals,
            preferences: updated.preferences,
            onboarding_completed: true,
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// PATCH /api/profile/preferences — merge dietary/RAG preferences
const PreferencesSchema = z.object({
    dietary_preference: z.enum(["omnivore", "vegetarian", "vegan"]).optional(),
    allergies: z.array(z.string().max(50)).max(20).optional(),
    disliked_foods: z.array(z.string().max(50)).max(20).optional(),
    cuisine_preferences: z.array(z.string().max(50)).max(10).optional(),
    health_conditions: z.array(z.string().max(100)).max(10).optional(),
});

router.patch("/preferences", authenticate, async (req: Request, res: Response) => {
    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid preferences", details: parsed.error.flatten() });
        return;
    }

    const user = req.user as IUser;

    // Merge into existing preferences (keep other keys intact)
    const updated = await User.findByIdAndUpdate(
        user._id,
        { $set: Object.fromEntries(
            Object.entries(parsed.data)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [`preferences.${k}`, v]),
        ) },
        { new: true },
    ).lean();

    if (!updated) {
        res.status(404).json({ error: "User not found" });
        return;
    }

    res.json({ ok: true, preferences: updated.preferences });
});

export default router;
