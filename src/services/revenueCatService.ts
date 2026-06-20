import axios from "axios";
import crypto from "crypto";
import mongoose from "mongoose";
import PaymentTransaction, { PlanType } from "../models/PaymentTransaction";
import User from "../models/User";
import { getEffectiveUserTier } from "../utils/subscriptionEntitlements";

type RevenueCatTier = "premium" | "family";

export interface RevenueCatEvent {
    id?: string;
    type?: string;
    app_user_id?: string;
    original_app_user_id?: string;
    product_id?: string;
    transaction_id?: string;
    original_transaction_id?: string;
    expiration_at_ms?: number | string | null;
    purchased_at_ms?: number | string | null;
    price?: number | string | null;
    price_in_purchased_currency?: number | string | null;
    currency?: string | null;
    entitlement_ids?: string[];
}

interface RevenueCatSubscriberEntitlement {
    expires_date?: string | null;
    product_identifier?: string | null;
}

interface RevenueCatSubscriberResponse {
    subscriber?: {
        entitlements?: Record<string, RevenueCatSubscriberEntitlement>;
    };
}

export class RevenueCatConfigurationError extends Error {}

function configuredValues(key: string, defaults: string[]): string[] {
    const fromEnv = (process.env[key] || "").split(",").map((item) => item.trim()).filter(Boolean);
    return fromEnv.length ? fromEnv : defaults;
}

function planForProduct(productId?: string | null, entitlementIds: string[] = []): RevenueCatTier | null {
    const normalizedProduct = (productId || "").toLowerCase();
    const normalizedEntitlements = entitlementIds.map((id) => id.toLowerCase());
    const familyProducts = configuredValues("REVENUECAT_FAMILY_PRODUCT_IDS", ["calovie_family_monthly"]);
    const premiumProducts = configuredValues("REVENUECAT_PREMIUM_PRODUCT_IDS", ["calovie_premium_monthly"]);
    const familyEntitlements = configuredValues("REVENUECAT_FAMILY_ENTITLEMENTS", ["family"]);
    const premiumEntitlements = configuredValues("REVENUECAT_PREMIUM_ENTITLEMENTS", ["premium"]);

    if (familyProducts.some((id) => id.toLowerCase() === normalizedProduct)
        || familyEntitlements.some((id) => normalizedEntitlements.includes(id.toLowerCase()))) return "family";
    if (premiumProducts.some((id) => id.toLowerCase() === normalizedProduct)
        || premiumEntitlements.some((id) => normalizedEntitlements.includes(id.toLowerCase()))) return "premium";
    return null;
}

function dateFromMillis(value?: number | string | null): Date | undefined {
    if (value === null || value === undefined || value === "") return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    const date = new Date(numeric);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function priceFromEvent(event: RevenueCatEvent): number {
    const price = Number(event.price_in_purchased_currency ?? event.price ?? 0);
    return Number.isFinite(price) && price >= 0 ? price : 0;
}

function transactionRef(event: RevenueCatEvent): string | undefined {
    return event.transaction_id || event.original_transaction_id || event.id;
}

async function writeTransaction(userId: string, tier: RevenueCatTier, event: RevenueCatEvent, status: "completed" | "refunded") {
    const paymentRef = transactionRef(event);
    if (!paymentRef) return;

    const price = priceFromEvent(event);
    await PaymentTransaction.findOneAndUpdate(
        { user_id: userId, target_type: "user", payment_ref: paymentRef },
        {
            $set: {
                plan_type: tier as PlanType,
                target_type: "user",
                duration_months: 1,
                amount: price,
                final_amount: price,
                currency: event.currency || "VND",
                payment_method: "revenuecat",
                payment_ref: paymentRef,
                status,
                notes: `RevenueCat ${event.type || "sync"}`,
            },
            $setOnInsert: { user_id: userId },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

async function applyEntitlement(input: {
    userId: string;
    tier: RevenueCatTier | null;
    expiresAt?: Date;
    event?: RevenueCatEvent;
    revoke?: boolean;
}) {
    if (!mongoose.isValidObjectId(input.userId)) return null;
    const user = await User.findById(input.userId);
    if (!user) return null;

    const isActive = !!input.tier && !!input.expiresAt && input.expiresAt > new Date() && !input.revoke;
    if (isActive) {
        user.subscription_tier = input.tier!;
        user.subscription_expires_at = input.expiresAt;
        await user.save();
        if (input.event) await writeTransaction(input.userId, input.tier!, input.event, "completed");
    } else if (input.tier && getEffectiveUserTier(user.subscription_tier, user.subscription_expires_at) !== "free") {
        user.subscription_tier = "free";
        user.subscription_expires_at = undefined;
        user.family_group_id = undefined;
        user.family_role = undefined;
        user.family_access_source = undefined;
        await user.save();
        if (input.event) await writeTransaction(input.userId, input.tier, input.event, "refunded");
    }

    return user;
}

export function verifyRevenueCatAuthorization(headerValue?: string): boolean {
    const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
    if (!expected || !headerValue) return false;
    const received = headerValue.replace(/^Bearer\s+/i, "");
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function applyRevenueCatEvent(event: RevenueCatEvent) {
    const userId = event.app_user_id || event.original_app_user_id;
    const tier = planForProduct(event.product_id, event.entitlement_ids || []);
    const expiration = dateFromMillis(event.expiration_at_ms);
    const type = (event.type || "").toUpperCase();
    const revoke = ["EXPIRATION", "REFUND"].includes(type);
    if (!userId || !tier) return null;
    return applyEntitlement({ userId, tier, expiresAt: expiration, event, revoke });
}

export async function syncRevenueCatSubscriber(userId: string) {
    const apiKey = process.env.REVENUECAT_SECRET_API_KEY;
    if (!apiKey) throw new RevenueCatConfigurationError("RevenueCat server API key is not configured.");

    const response = await axios.get<RevenueCatSubscriberResponse>(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8000 },
    );
    const entitlements = response.data.subscriber?.entitlements || {};
    const candidates = Object.entries(entitlements)
        .map(([id, entitlement]) => ({
            tier: planForProduct(entitlement.product_identifier, [id]),
            expiresAt: entitlement.expires_date ? new Date(entitlement.expires_date) : undefined,
            productId: entitlement.product_identifier || undefined,
        }))
        .filter((entry): entry is { tier: RevenueCatTier; expiresAt: Date | undefined; productId: string | undefined } => !!entry.tier)
        .sort((left, right) => (right.expiresAt?.getTime() || 0) - (left.expiresAt?.getTime() || 0));
    const active = candidates.find((entry) => entry.expiresAt && entry.expiresAt > new Date());

    return applyEntitlement({
        userId,
        tier: active?.tier || candidates[0]?.tier || null,
        expiresAt: active?.expiresAt,
        event: active ? { type: "SYNC", product_id: active.productId } : undefined,
        revoke: !active,
    });
}
