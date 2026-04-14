import cron from "node-cron";
import User from "../models/User";
import Store from "../models/Store";
import {
    sendRenewalReminder,
    sendRenewalReminderUrgent,
    sendSubscriptionExpired,
} from "./emailService";

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
    const v = new Date(d);
    v.setHours(0, 0, 0, 0);
    return v;
}

function daysFromNow(n: number): Date {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return startOfDay(d);
}

// ── Job 1: Expire overdue user subscriptions (daily 00:05 VN = 17:05 UTC) ─────

async function expireUserSubscriptions(): Promise<void> {
    const now = new Date();

    const expired = await User.find({
        subscription_tier: { $ne: "free" },
        subscription_expires_at: { $lt: now },
    }).select("email display_name subscription_tier");

    if (expired.length === 0) return;

    console.log(`[cron] Expiring ${expired.length} user subscription(s)…`);

    for (const user of expired) {
        const oldTier = user.subscription_tier;
        user.subscription_tier = "free";
        user.subscription_expires_at = undefined;
        await user.save();

        // Send expired notification (fire-and-forget, don't block the loop)
        sendSubscriptionExpired({
            to: user.email,
            name: user.display_name,
            tier: oldTier,
        }).catch((err) =>
            console.error(`[cron] Failed to send expiry email to ${user.email}:`, err),
        );
    }

    console.log(`[cron] Expired ${expired.length} user subscription(s).`);
}

// ── Job 2: Expire overdue store subscriptions ──────────────────────────────────

async function expireStoreSubscriptions(): Promise<void> {
    const now = new Date();

    const expired = await Store.find({
        subscription_tier: { $ne: "basic" },
        subscription_expires_at: { $lt: now },
    }).select("name subscription_tier");

    if (expired.length === 0) return;

    console.log(`[cron] Expiring ${expired.length} store subscription(s)…`);

    for (const store of expired) {
        store.subscription_tier = "basic";
        store.subscription_expires_at = undefined;
        await store.save();
    }

    console.log(`[cron] Expired ${expired.length} store subscription(s).`);
}

// ── Job 3: Send renewal reminder emails (daily 09:00 VN = 02:00 UTC) ──────────

async function sendRenewalReminders(): Promise<void> {
    const day7start = daysFromNow(7);
    const day7end   = new Date(day7start.getTime() + 24 * 60 * 60 * 1000 - 1);
    const day3start = daysFromNow(3);
    const day3end   = new Date(day3start.getTime() + 24 * 60 * 60 * 1000 - 1);

    // 7-day reminders
    const users7 = await User.find({
        subscription_tier: { $ne: "free" },
        subscription_expires_at: { $gte: day7start, $lte: day7end },
    }).select("email display_name subscription_tier subscription_expires_at");

    for (const user of users7) {
        sendRenewalReminder({
            to: user.email,
            name: user.display_name,
            tier: user.subscription_tier,
            expiresAt: user.subscription_expires_at!,
        }).catch((err) =>
            console.error(`[cron] 7-day reminder failed for ${user.email}:`, err),
        );
    }

    if (users7.length > 0)
        console.log(`[cron] Sent 7-day renewal reminders to ${users7.length} user(s).`);

    // 3-day reminders
    const users3 = await User.find({
        subscription_tier: { $ne: "free" },
        subscription_expires_at: { $gte: day3start, $lte: day3end },
    }).select("email display_name subscription_tier subscription_expires_at");

    for (const user of users3) {
        sendRenewalReminderUrgent({
            to: user.email,
            name: user.display_name,
            tier: user.subscription_tier,
            expiresAt: user.subscription_expires_at!,
        }).catch((err) =>
            console.error(`[cron] 3-day reminder failed for ${user.email}:`, err),
        );
    }

    if (users3.length > 0)
        console.log(`[cron] Sent 3-day urgent reminders to ${users3.length} user(s).`);
}

// ── Register all cron jobs ─────────────────────────────────────────────────────

export function startCronJobs(): void {
    // Expire subscriptions: 00:05 Vietnam time (UTC+7 = 17:05 UTC previous day)
    // Cron expression in server local time — uses UTC if TZ not set
    // Schedule as 17:05 UTC = 00:05 ICT
    cron.schedule("5 17 * * *", async () => {
        console.log("[cron] Running subscription expiry check…");
        await expireUserSubscriptions().catch((err) =>
            console.error("[cron] expireUserSubscriptions error:", err),
        );
        await expireStoreSubscriptions().catch((err) =>
            console.error("[cron] expireStoreSubscriptions error:", err),
        );
    }, { timezone: "Asia/Ho_Chi_Minh" });

    // Renewal reminders: 09:00 Vietnam time
    cron.schedule("0 9 * * *", async () => {
        console.log("[cron] Running renewal reminder emails…");
        await sendRenewalReminders().catch((err) =>
            console.error("[cron] sendRenewalReminders error:", err),
        );
    }, { timezone: "Asia/Ho_Chi_Minh" });

    console.log("✅ Subscription cron jobs registered (expiry: 00:05 ICT | reminders: 09:00 ICT)");
}
