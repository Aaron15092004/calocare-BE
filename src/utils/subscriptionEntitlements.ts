import type { IUser } from "../models/User";

export type UserSubscriptionTier = "free" | "premium" | "family" | "pro";
export type EffectiveUserSubscriptionTier = "free" | "premium" | "family";

export function normalizeUserTier(tier?: string | null): EffectiveUserSubscriptionTier {
    if (tier === "pro" || tier === "family") return "family";
    if (tier === "premium") return "premium";
    return "free";
}

export function isSubscriptionExpired(expiresAt?: Date | string | null, now = new Date()): boolean {
    if (!expiresAt) return true;
    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    return Number.isNaN(expiry.getTime()) || expiry <= now;
}

export function getEffectiveUserTier(
    tier?: string | null,
    expiresAt?: Date | string | null,
    now = new Date(),
): EffectiveUserSubscriptionTier {
    const normalized = normalizeUserTier(tier);
    if (normalized === "free") return "free";
    return isSubscriptionExpired(expiresAt, now) ? "free" : normalized;
}

export function isActivePaidUserSubscription(
    user?: Pick<IUser, "subscription_tier" | "subscription_expires_at"> | null,
    now = new Date(),
): boolean {
    return getEffectiveUserTier(user?.subscription_tier, user?.subscription_expires_at, now) !== "free";
}

export async function downgradeExpiredUserSubscription<T extends IUser>(user: T, now = new Date()): Promise<T> {
    const effectiveTier = getEffectiveUserTier(user.subscription_tier, user.subscription_expires_at, now);
    if (effectiveTier !== "free" || user.subscription_tier === "free") return user;

    user.subscription_tier = "free";
    user.subscription_expires_at = undefined;
    user.family_group_id = undefined;
    user.family_role = undefined;
    user.family_access_source = undefined;
    await user.save();
    return user;
}
