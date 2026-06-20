import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import { IUser } from "../models/User";
import User from "../models/User";
import Store from "../models/Store";
import PaymentTransaction, { IPaymentTransaction, PlanType } from "../models/PaymentTransaction";
import DiscountCode from "../models/DiscountCode";
import SystemSettings from "../models/SystemSettings";
import { sendPaymentConfirmed } from "../services/emailService";
import { getEffectiveUserTier } from "../utils/subscriptionEntitlements";
import { getClientUrl, getPayOS } from "../services/payosClient";
import {
    applyRevenueCatEvent,
    RevenueCatConfigurationError,
    RevenueCatEvent,
    syncRevenueCatSubscriber,
    verifyRevenueCatAuthorization,
} from "../services/revenueCatService";

// Returns the active global discount percentage (0 if none, expired, or plan not in applicable_plans)
async function getGlobalDiscountPct(planType?: string): Promise<number> {
    try {
        const doc = await SystemSettings.findOne({ key: "global" });
        if (!doc || doc.global_discount_pct <= 0) return 0;
        if (doc.global_discount_expires && doc.global_discount_expires < new Date()) return 0;
        if (planType && doc.applicable_plans?.length > 0 && !doc.applicable_plans.includes(planType)) return 0;
        return doc.global_discount_pct;
    } catch {
        return 0;
    }
}

const router = Router();

// ── Plan config ────────────────────────────────────────────────────────────────

const PLANS: Record<PlanType, { name: string; price_monthly: number; tier: string }> = {
    premium: { name: "Premium", price_monthly: 59000, tier: "premium" },
    family:  { name: "Family",  price_monthly: 199000, tier: "family" },
    pro:     { name: "Family",  price_monthly: 199000, tier: "family" },
    store_pro: { name: "Store Pro", price_monthly: 49000, tier: "pro" },
};

type UserPlanType = "premium" | "family";

const USER_PLAN_ALIASES: Record<string, UserPlanType> = {
    premium: "premium",
    family: "family",
    pro: "family",
};

const ALLOWED_DURATIONS = [1, 3, 6, 12] as const;
const DURATION_DISCOUNT_PCT: Record<number, number> = {
    1: 0,
    3: 5,
    6: 10,
    12: 15,
};

class PaymentValidationError extends Error {
    status: number;
    code: string;

    constructor(message: string, code = "payment_validation_error", status = 400) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function respondWithError(res: Response, error: unknown): void {
    if (error instanceof PaymentValidationError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
    }
    res.status(500).json({ error: (error as Error).message });
}

function normalizeUserPlan(planType: unknown): UserPlanType {
    const key = String(planType || "").toLowerCase();
    const normalized = USER_PLAN_ALIASES[key];
    if (!normalized) {
        throw new PaymentValidationError("Gói thanh toán không hợp lệ.", "invalid_plan_type");
    }
    return normalized;
}

function normalizeDuration(value: unknown): number {
    const months = Number(value ?? 1);
    if (!Number.isInteger(months) || !ALLOWED_DURATIONS.includes(months as typeof ALLOWED_DURATIONS[number])) {
        throw new PaymentValidationError("Thời hạn gói chỉ hỗ trợ 1, 3, 6 hoặc 12 tháng.", "invalid_duration");
    }
    return months;
}

function normalizePaymentMethod(value: unknown): string {
    const method = String(value || "payos");
    if (method !== "payos") {
        throw new PaymentValidationError("CaloVie hiện chỉ hỗ trợ thanh toán tự động.", "invalid_payment_method");
    }
    return method;
}

function applyPct(amount: number, pct: number): { amount: number; discount: number } {
    if (pct <= 0) return { amount, discount: 0 };
    const next = Math.max(0, Math.round(amount * (1 - pct / 100)));
    return { amount: next, discount: amount - next };
}

async function buildUserQuote(input: {
    plan_type: unknown;
    duration_months?: unknown;
    discount_code?: unknown;
}) {
    const planType = normalizeUserPlan(input.plan_type);
    const durationMonths = normalizeDuration(input.duration_months);
    const plan = PLANS[planType];
    const baseAmount = plan.price_monthly * durationMonths;

    const durationPct = DURATION_DISCOUNT_PCT[durationMonths] ?? 0;
    const durationApplied = applyPct(baseAmount, durationPct);

    const globalPct = await getGlobalDiscountPct(planType);
    const globalApplied = applyPct(durationApplied.amount, globalPct);

    let finalAmount = globalApplied.amount;
    let discountCode: string | undefined;
    let discountCodeAmount = 0;
    let discountCodeMeta: { type: "percentage" | "fixed"; value: number } | null = null;

    const rawCode = typeof input.discount_code === "string" ? input.discount_code.trim().toUpperCase() : "";
    if (rawCode) {
        const now = new Date();
        const code = await DiscountCode.findOne({ code: rawCode, is_active: true });
        if (!code) {
            throw new PaymentValidationError("Mã giảm giá không hợp lệ hoặc đã bị tắt.", "invalid_discount_code");
        }
        if (code.starts_at && code.starts_at > now) {
            throw new PaymentValidationError("Mã giảm giá chưa đến thời gian sử dụng.", "discount_not_started");
        }
        if (code.expires_at && code.expires_at < now) {
            throw new PaymentValidationError("Mã giảm giá đã hết hạn.", "discount_expired");
        }
        if (code.max_uses && code.used_count >= code.max_uses) {
            throw new PaymentValidationError("Mã giảm giá đã hết lượt sử dụng.", "discount_usage_limit_reached");
        }
        if (code.min_purchase && finalAmount < code.min_purchase) {
            throw new PaymentValidationError(
                `Đơn hàng cần tối thiểu ${code.min_purchase.toLocaleString("vi-VN")}₫ để dùng mã này.`,
                "discount_min_purchase_not_met",
            );
        }
        if (!Number.isFinite(code.discount_value) || code.discount_value <= 0) {
            throw new PaymentValidationError("Mã giảm giá chưa được cấu hình đúng.", "invalid_discount_value");
        }
        if (code.discount_type === "percentage" && code.discount_value > 100) {
            throw new PaymentValidationError("Mã giảm giá phần trăm không được vượt quá 100%.", "invalid_discount_value");
        }

        discountCode = rawCode;
        discountCodeMeta = { type: code.discount_type, value: code.discount_value };
        if (code.discount_type === "percentage") {
            const applied = applyPct(finalAmount, code.discount_value);
            finalAmount = applied.amount;
            discountCodeAmount = applied.discount;
        } else {
            discountCodeAmount = Math.min(finalAmount, code.discount_value);
            finalAmount = Math.max(0, finalAmount - code.discount_value);
        }
    }

    return {
        plan_type: planType,
        plan_name: plan.name,
        tier: plan.tier,
        duration_months: durationMonths,
        price_monthly: plan.price_monthly,
        amount: baseAmount,
        final_amount: finalAmount,
        currency: "VND",
        duration_discount_pct: durationPct,
        duration_discount_amount: durationApplied.discount,
        global_discount_pct: globalPct,
        global_discount_amount: globalApplied.discount,
        discount_code: discountCode,
        discount_code_amount: discountCodeAmount,
        discount_code_meta: discountCodeMeta,
    };
}

// ── Shared activation helper (idempotent) ─────────────────────────���───────────

async function activateSubscription(
    tx: IPaymentTransaction,
    paymentRef?: string,
): Promise<void> {
    // Guard — idempotent: do nothing if already completed
    if (tx.status === "completed") return;
    if (tx.status !== "pending") {
        throw new PaymentValidationError("Giao dịch không còn ở trạng thái chờ thanh toán.", "transaction_not_pending");
    }

    tx.status = "completed";
    if (paymentRef) tx.payment_ref = paymentRef;
    await tx.save();

    const plan = PLANS[tx.plan_type];
    if (!plan) return;
    if (tx.target_type !== "user" || !["premium", "family"].includes(plan.tier)) return;

    const now = new Date();
    const user = await User.findById(tx.user_id);
    if (user) {
        const base = user.subscription_expires_at && user.subscription_expires_at > now
            ? user.subscription_expires_at
            : now;
        const newExpiry = new Date(base);
        newExpiry.setMonth(newExpiry.getMonth() + tx.duration_months);
        user.subscription_tier = plan.tier as "premium" | "family";
        user.subscription_expires_at = newExpiry;
        await user.save();

        // Send payment confirmation email (fire-and-forget)
        sendPaymentConfirmed({
            to: user.email,
            name: user.display_name,
            tier: plan.tier,
            durationMonths: tx.duration_months,
            amount: tx.final_amount ?? tx.amount,
            expiresAt: newExpiry,
        }).catch((err) =>
            console.error("[subscription] Failed to send payment confirmed email:", err),
        );
    }

    if (tx.discount_code) {
        const result = await DiscountCode.updateOne(
            {
                code: tx.discount_code.toUpperCase(),
                $or: [
                    { max_uses: { $exists: false } },
                    { max_uses: null },
                    { $expr: { $lt: ["$used_count", "$max_uses"] } },
                ],
            },
            { $inc: { used_count: 1 } },
        );
        if (result.modifiedCount === 0) {
            console.warn(`[subscription] Discount code ${tx.discount_code} was paid but no usage slot was available.`);
        }
    }
}

async function activateStoreSubscription(
    tx: IPaymentTransaction,
    paymentRef?: string,
): Promise<void> {
    if (tx.status === "completed") return;
    if (tx.status !== "pending") {
        throw new PaymentValidationError("Giao dịch không còn ở trạng thái chờ thanh toán.", "transaction_not_pending");
    }
    if (tx.plan_type !== "store_pro" || tx.target_type !== "store") {
        throw new PaymentValidationError("Giao dịch Store Pro không hợp lệ.", "invalid_store_transaction");
    }

    tx.status = "completed";
    if (paymentRef) tx.payment_ref = paymentRef;
    await tx.save();

    const store = await Store.findById(tx.store_id);
    if (!store) return;

    const now = new Date();
    const base = store.subscription_expires_at && store.subscription_expires_at > now
        ? store.subscription_expires_at
        : now;
    const newExpiry = new Date(base);
    newExpiry.setMonth(newExpiry.getMonth() + tx.duration_months);
    store.subscription_tier = "pro";
    store.subscription_expires_at = newExpiry;
    await store.save();
}

async function syncPayOSPaymentStatus(tx: IPaymentTransaction): Promise<void> {
    if (tx.status !== "pending" || tx.payment_method !== "payos" || !tx.payment_ref) return;

    const orderCode = Number(tx.payment_ref);
    if (!Number.isFinite(orderCode)) return;

    try {
        const paymentLink = await getPayOS().paymentRequests.get(orderCode);
        if (paymentLink.status !== "PAID") return;
        if (Number(paymentLink.amountPaid || 0) < tx.final_amount) {
            console.warn(`[subscription] PayOS order ${orderCode} is PAID but amount is insufficient.`);
            return;
        }

        const paymentReference = paymentLink.transactions?.[0]?.reference || tx.payment_ref;
        if (tx.target_type === "store") {
            await activateStoreSubscription(tx, paymentReference);
        } else {
            await activateSubscription(tx, paymentReference);
        }
    } catch (error) {
        console.warn("[subscription] PayOS status sync failed:", error instanceof Error ? error.message : String(error));
    }
}

// ── Helpers ──────────────────��─────────────────────────────────���──────────────

function buildRef(txId: string): string {
    return `CALO${txId.slice(-8).toUpperCase()}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/subscription/plans
router.get("/plans", async (_req, res) => {
    const globalPct = await getGlobalDiscountPct();
    res.json({
        global_discount_pct: globalPct,
        user_plans: [
            {
                id: "free",
                name: "Free",
                price_monthly: 0,
                features: {
                    scan_limit: 2,
                    scan_cooldown_min: null,
                    manual_log_limit: 5,
                    scan_history_days: 7,
                    ads: true,
                },
            },
            {
                id: "premium",
                name: "Premium",
                price_monthly: 59000,
                features: {
                    scan_limit: 5,
                    scan_cooldown_min: null,
                    meal_plan_ai_daily: 1,
                    chat_limit: 100,
                    manual_log_limit: null,
                    scan_history_days: 30,
                    ads: false,
                    barcode_scanner: true,
                    meal_plan_ai: true,
                    exercise_tracker: true,
                    grocery_list: true,
                    export_csv: true,
                    weekly_report: true,
                    push_notifications: true,
                    progress_charts_months: 3,
                },
            },
            {
                id: "family",
                name: "Family",
                price_monthly: 199000,
                features: {
                    scan_limit: -1,
                    scan_cooldown_min: null,
                    meal_plan_ai_daily: 5,
                    chat_limit: -1,
                    manual_log_limit: null,
                    scan_history_days: 180,
                    ads: false,
                    barcode_scanner: true,
                    meal_plan_ai: true,
                    exercise_tracker: true,
                    grocery_list: true,
                    export_csv: true,
                    weekly_report: true,
                    family_members: 5,
                    separate_health_reports: true,
                    push_notifications: true,
                    progress_charts_months: null,
                    batch_scan: 3,
                    ai_nutritionist: true,
                    health_metrics: true,
                    api_access: true,
                    priority_support: "chat_2h",
                },
            },
        ],
        store_plans: [
            {
                id: "store_basic",
                name: "Store Basic",
                price_monthly: 0,
                features: {
                    menu_limit: 20,
                    analytics_basic: true,
                    map_listing: true,
                    receive_reviews: true,
                },
            },
            {
                id: "store_pro",
                name: "Store Pro",
                price_monthly: 49000,
                features: {
                    menu_limit: null,
                    analytics_basic: true,
                    analytics_detail: true,
                    map_listing: true,
                    promoted_listing: true,
                    receive_reviews: true,
                    reply_reviews: true,
                    qr_menu: true,
                    bulk_upload: true,
                    ai_nutrition_estimate: true,
                    verified_badge: true,
                    export_analytics: true,
                },
            },
        ],
        duration_options: ALLOWED_DURATIONS.map((months) => ({
            months,
            discount_pct: DURATION_DISCOUNT_PCT[months],
        })),
    });
});

// GET /api/subscription/status
router.get("/status", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const fullUser = await User.findById(user._id).select(
            "subscription_tier subscription_expires_at",
        );
        if (!fullUser) { res.status(404).json({ error: "User not found" }); return; }

        const effectiveTier = getEffectiveUserTier(fullUser.subscription_tier, fullUser.subscription_expires_at);

        const recent = await PaymentTransaction.findOne({ user_id: user._id })
            .sort({ created_at: -1 })
            .select("plan_type status amount final_amount payment_method payment_ref created_at");

        res.json({
            tier: effectiveTier,
            expires_at: fullUser.subscription_expires_at,
            is_active: effectiveTier !== "free",
            latest_transaction: recent || null,
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/subscription/quote — authoritative pricing preview for checkout
router.post("/quote", authenticate, async (req: Request, res: Response) => {
    try {
        const quote = await buildUserQuote({
            plan_type: req.body.plan_type,
            duration_months: req.body.duration_months,
            discount_code: req.body.discount_code,
        });
        res.json(quote);
    } catch (error) {
        respondWithError(res, error);
    }
});

// GET /api/subscription/transactions/:txId — poll one transaction for realtime UX
router.get("/transactions/:txId", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const tx = await PaymentTransaction.findOne({
            _id: req.params.txId,
            user_id: user._id,
            target_type: "user",
        }).select("plan_type status amount final_amount payment_method payment_ref duration_months discount_code created_at updated_at");

        if (!tx) {
            res.status(404).json({ error: "Transaction not found" });
            return;
        }

        await syncPayOSPaymentStatus(tx);

        const fullUser = await User.findById(user._id).select("subscription_tier subscription_expires_at");
        const effectiveTier = fullUser
            ? getEffectiveUserTier(fullUser.subscription_tier, fullUser.subscription_expires_at)
            : "free";

        res.json({
            transaction: tx,
            subscription: fullUser ? {
                tier: effectiveTier,
                expires_at: fullUser.subscription_expires_at,
                is_active: effectiveTier !== "free",
            } : null,
        });
    } catch (error) {
        respondWithError(res, error);
    }
});

// POST /api/subscription/upgrade — create pending payment order
router.post("/upgrade", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const paymentMethod = normalizePaymentMethod(req.body.payment_method);
        const quote = await buildUserQuote({
            plan_type: req.body.plan_type,
            duration_months: req.body.duration_months,
            discount_code: req.body.discount_code,
        });

        // PayOS-only guard: reuse the latest pending automatic checkout and sync
        // it with PayOS before asking the user/admin to do anything manually.
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const existingPending = await PaymentTransaction.findOne({
            user_id: user._id,
            plan_type: quote.plan_type,
            target_type: "user",
            duration_months: quote.duration_months,
            status: "pending",
            payment_method: "payos",
            created_at: { $gte: twoHoursAgo },
        }).sort({ created_at: -1 });

        if (existingPending) {
            await syncPayOSPaymentStatus(existingPending);
            if (existingPending.status === "completed") {
                res.status(200).json({
                    transaction_id: existingPending._id,
                    tx_id: existingPending._id,
                    plan_type: existingPending.plan_type,
                    status: existingPending.status,
                    amount: existingPending.amount,
                    final_amount: existingPending.final_amount,
                    payment_method: "payos",
                    created_at: existingPending.created_at,
                });
                return;
            }

            const ref = buildRef(String(existingPending._id));
            res.status(409).json({
                error: "pending_transaction_exists",
                message: "Bạn đã có giao dịch thanh toán tự động đang chờ. Nếu đã thanh toán, trang trạng thái sẽ tự cập nhật trong vài giây.",
                transaction_id: existingPending._id,
                tx_id: existingPending._id,
                plan_type: existingPending.plan_type,
                status: existingPending.status,
                payment_ref: buildRef(String(existingPending._id)),
                payment_ref_code: ref,
                amount: existingPending.amount,
                final_amount: existingPending.final_amount,
                payment_method: existingPending.payment_method,
                created_at: existingPending.created_at,
            });
            return;
        }

        const tx = await PaymentTransaction.create({
            user_id: user._id,
            plan_type: quote.plan_type,
            target_type: "user",
            duration_months: quote.duration_months,
            amount: quote.amount,
            final_amount: quote.final_amount,
            discount_code: quote.discount_code || undefined,
            status: "pending",
            payment_method: paymentMethod,
        });

        const txId = String(tx._id);
        const ref  = buildRef(txId);

        // ── PayOS checkout link ──────────────────────────────────────────────
        if (paymentMethod === "payos") {
            const payos      = getPayOS();
            const clientUrl  = getClientUrl();
            // orderCode: 32-bit unsigned int derived from last 8 hex chars of txId
            const orderCode  = parseInt(txId.slice(-8), 16);
            // description max 25 chars — ref is "CALOXXXXXXXX" (12 chars)
            const description = ref.slice(0, 25);

            const link = await payos.paymentRequests.create({
                orderCode,
                amount: quote.final_amount,
                description,
                returnUrl: `${clientUrl}/subscription/status?txId=${txId}`,
                cancelUrl:  `${clientUrl}/subscription/status?txId=${txId}`,
                items: [{
                    name:     `${quote.plan_name} ${quote.duration_months}th`,
                    quantity: 1,
                    price:    quote.final_amount,
                }],
            });

            // Store orderCode string so the webhook can look it up
            tx.payment_ref = String(orderCode);
            await tx.save();

            return res.status(201).json({
                transaction_id: tx._id,
                plan_type: quote.plan_type,
                amount:       quote.amount,
                final_amount: quote.final_amount,
                status:       "pending",
                payment_method: "payos",
                checkout_url:  link.checkoutUrl,
                qr_code:       link.qrCode,
                payment_ref:   tx.payment_ref,
                quote,
            });
        }

        throw new PaymentValidationError("CaloVie hiện chỉ hỗ trợ thanh toán tự động.", "invalid_payment_method");
    } catch (error) {
        respondWithError(res, error);
    }
});

// POST /api/subscription/webhook/bank — bank/MoMo webhook
// Called by payment gateway or cron job with bank statement data.
// Body: { ref: "CALOXXXXXXXX", amount: number, payment_ref: string, secret?: string }
router.post("/webhook/bank", async (req: Request, res: Response) => {
    try {
        const { ref, amount, payment_ref, secret } = req.body;

        // Validate webhook secret
        const expectedSecret = process.env.WEBHOOK_SECRET;
        if (!expectedSecret) {
            res.status(503).json({ error: "Payment webhook secret is not configured" });
            return;
        }
        if (secret !== expectedSecret) {
            res.status(401).json({ error: "Invalid webhook secret" });
            return;
        }

        if (!ref) {
            res.status(400).json({ error: "ref is required" });
            return;
        }
        const paidAmount = Number(amount);
        if (!Number.isFinite(paidAmount)) {
            res.status(400).json({ error: "amount is required" });
            return;
        }

        // Find pending transaction by CALO ref
        // ref = "CALO" + txId.slice(-8)  →  we need to match the end of _id
        const refSuffix = String(ref).toUpperCase().replace(/^CALO/, "");
        const txs = await PaymentTransaction.find({ status: "pending", target_type: "user" })
            .sort({ created_at: -1 })
            .limit(200);

        const tx = txs.find((t) => String(t._id).slice(-8).toUpperCase() === refSuffix);

        if (!tx) {
            res.status(404).json({ error: "No pending transaction found for ref" });
            return;
        }

        if (paidAmount < tx.final_amount) {
            res.status(400).json({ error: "Payment amount insufficient" });
            return;
        }

        await activateSubscription(tx, payment_ref || ref);

        res.json({ message: "Subscription activated", transaction_id: tx._id });
    } catch (error) {
        respondWithError(res, error);
    }
});

// POST /api/subscription/webhook/payos — PayOS payment webhook
// PayOS sends this after each payment event; no auth header, verified by signature.
router.post("/webhook/payos", async (req: Request, res: Response) => {
    try {
        // Throws PayOS.InvalidSignatureError when signature is wrong
        let webhookData: { code?: string; orderCode?: string | number; reference?: string; amount?: number };
        try {
            webhookData = await getPayOS().webhooks.verify(req.body) as typeof webhookData;
        } catch {
            res.status(400).json({ error: "Invalid webhook signature" });
            return;
        }

        // code !== "00" means the event is not a successful payment — acknowledge silently
        if (webhookData.code !== "00") {
            res.json({ message: "ignored" });
            return;
        }

        const tx = await PaymentTransaction.findOne({
            payment_ref: String(webhookData.orderCode),
            status: "pending",
        });

        if (!tx) {
            // Unknown or already processed — return 200 to stop PayOS retrying
            res.json({ message: "not found" });
            return;
        }

        const paidAmount = Number(webhookData.amount);
        if (Number.isFinite(paidAmount) && paidAmount < tx.final_amount) {
            res.status(400).json({ error: "Payment amount insufficient" });
            return;
        }

        if (tx.target_type === "store") {
            await activateStoreSubscription(tx, webhookData.reference);
        } else {
            await activateSubscription(tx, webhookData.reference);
        }

        res.json({ message: "activated", transaction_id: tx._id });
    } catch (error) {
        respondWithError(res, error);
    }
});

// GET /api/subscription/return/payos — redirect after PayOS checkout page
// PayOS appends ?code=00&... on success, other codes on cancel/failure.
// Activation is handled by the webhook above — this only redirects the browser.
router.get("/return/payos", (req: Request, res: Response) => {
    const clientUrl = getClientUrl();
    res.redirect(`${clientUrl}/subscription/status?txId=${req.query.txId ?? ""}`);
});

// POST /api/subscription/verify/:ref — admin or cron verifies a transaction by CALO ref
// Body: { payment_ref?: string }
router.post("/verify/:ref", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const refSuffix = req.params.ref.toUpperCase().replace(/^CALO/, "");

        const txs = await PaymentTransaction.find({ status: "pending", target_type: "user" })
            .sort({ created_at: -1 })
            .limit(200);

        const tx = txs.find((t) => String(t._id).slice(-8).toUpperCase() === refSuffix);

        if (!tx) {
            res.status(404).json({ error: "No pending transaction found for ref" });
            return;
        }

        if (tx.status !== "pending") {
            res.status(400).json({ error: "Transaction is not pending" });
            return;
        }

        await activateSubscription(tx, req.body.payment_ref || undefined);

        res.json({ message: "Subscription activated", transaction_id: tx._id });
    } catch (error) {
        respondWithError(res, error);
    }
});

// POST /api/subscription/confirm/:txId — admin fallback: confirm by transaction ID
router.post("/confirm/:txId", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const tx = await PaymentTransaction.findById(req.params.txId);
        if (!tx || tx.target_type !== "user") {
            res.status(404).json({ error: "Transaction not found" });
            return;
        }
        if (tx.status !== "pending") {
            res.status(400).json({ error: "Transaction is not pending" });
            return;
        }

        await activateSubscription(tx, req.body.payment_ref || undefined);

        res.json({ message: "Payment confirmed, subscription activated", transaction_id: tx._id });
    } catch (error) {
        respondWithError(res, error);
    }
});

// GET /api/subscription/transactions — user's own history
router.get("/transactions", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const txs = await PaymentTransaction.find({ user_id: user._id })
            .sort({ created_at: -1 })
            .limit(20);
        res.json({ data: txs });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/subscription/admin/pending — admin: list all pending transactions
router.get("/admin/pending", authenticate, requireAdmin, async (_req, res: Response) => {
    try {
        const txs = await PaymentTransaction.find({ status: "pending" })
            .populate("user_id", "display_name email")
            .sort({ created_at: -1 });
        res.json({ data: txs });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// RevenueCat is the source of truth for native subscriptions. Configure the same
// authorization value in the RevenueCat webhook dashboard and server env.
router.post("/webhook/revenuecat", async (req: Request, res: Response) => {
    if (!process.env.REVENUECAT_WEBHOOK_AUTH) {
        res.status(503).json({ error: "revenuecat_webhook_not_configured" });
        return;
    }
    if (!verifyRevenueCatAuthorization(req.get("authorization") || req.get("x-revenuecat-webhook-token") || undefined)) {
        res.status(401).json({ error: "invalid_revenuecat_webhook" });
        return;
    }

    try {
        const event = (req.body?.event || req.body) as RevenueCatEvent;
        const user = await applyRevenueCatEvent(event);
        res.json({ received: true, user_id: user?._id || null });
    } catch (error) {
        console.error("[subscription] RevenueCat webhook failed:", error);
        res.status(500).json({ error: "revenuecat_webhook_failed" });
    }
});

// The app can request an immediate server-side entitlement refresh after a
// completed store purchase. This endpoint never accepts an entitlement from the client.
router.post("/mobile/sync", authenticate, async (req: Request, res: Response) => {
    try {
        const user = await User.findById((req.user as IUser)._id).select(
            "subscription_tier subscription_expires_at family_role family_access_source",
        );
        if (!user) { res.status(404).json({ error: "User not found" }); return; }

        // Family members inherit access from the owner and must not be downgraded
        // because they do not have a personal store subscription.
        if (!(user.family_role === "member" && user.family_access_source)) {
            await syncRevenueCatSubscriber(user._id.toString());
        }

        const refreshed = await User.findById(user._id).select("subscription_tier subscription_expires_at");
        const tier = getEffectiveUserTier(refreshed?.subscription_tier, refreshed?.subscription_expires_at);
        res.json({
            tier,
            expires_at: refreshed?.subscription_expires_at ?? null,
            is_active: tier !== "free",
        });
    } catch (error) {
        if (error instanceof RevenueCatConfigurationError) {
            res.status(503).json({ error: "revenuecat_not_configured", message: error.message });
            return;
        }
        res.status(502).json({ error: "revenuecat_sync_failed" });
    }
});

// Kept as an explicit rejection so older app versions cannot self-upgrade by
// posting a tier. They should upgrade to a version using /mobile/sync.
router.post("/iap-webhook", authenticate, async (_req: Request, res: Response) => {
    res.status(410).json({
        error: "iap_client_sync_disabled",
        message: "IAP entitlement changes must be verified by RevenueCat server sync.",
    });
});

export default router;
