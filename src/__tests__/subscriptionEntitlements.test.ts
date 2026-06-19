import {
    getEffectiveUserTier,
    isActivePaidUserSubscription,
    isSubscriptionExpired,
    normalizeUserTier,
} from "../utils/subscriptionEntitlements";

describe("subscription entitlements", () => {
    const now = new Date("2026-06-19T10:00:00.000Z");

    it("treats expired premium/family/pro users as free", () => {
        const expiredAt = new Date("2026-06-19T09:59:59.000Z");

        expect(getEffectiveUserTier("premium", expiredAt, now)).toBe("free");
        expect(getEffectiveUserTier("family", expiredAt, now)).toBe("free");
        expect(getEffectiveUserTier("pro", expiredAt, now)).toBe("free");
    });

    it("keeps paid tiers active before expiry", () => {
        const expiresAt = new Date("2026-06-20T10:00:00.000Z");

        expect(getEffectiveUserTier("premium", expiresAt, now)).toBe("premium");
        expect(getEffectiveUserTier("family", expiresAt, now)).toBe("family");
        expect(getEffectiveUserTier("pro", expiresAt, now)).toBe("family");
    });

    it("requires a valid expiry for paid tiers", () => {
        expect(isSubscriptionExpired(undefined, now)).toBe(true);
        expect(isSubscriptionExpired("not-a-date", now)).toBe(true);
        expect(getEffectiveUserTier("premium", undefined, now)).toBe("free");
    });

    it("normalizes legacy pro as family while active", () => {
        expect(normalizeUserTier("pro")).toBe("family");
        expect(isActivePaidUserSubscription({
            subscription_tier: "pro",
            subscription_expires_at: new Date("2026-06-20T10:00:00.000Z"),
        }, now)).toBe(true);
    });
});
