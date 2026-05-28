import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import { IUser } from "../models/User";
import User from "../models/User";
import PaymentTransaction, { IPaymentTransaction, PlanType } from "../models/PaymentTransaction";
import DiscountCode from "../models/DiscountCode";
import SystemSettings from "../models/SystemSettings";
import { PayOS } from "@payos/node";
import { sendPaymentConfirmed } from "../services/emailService";

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

// ── PayOS singleton (lazy — only initialised when env vars are present) ───────

let _payos: PayOS | null = null;

function getPayOS(): PayOS {
    if (!_payos) {
        const clientId    = process.env.PAYOS_CLIENT_ID;
        const apiKey      = process.env.PAYOS_API_KEY;
        const checksumKey = process.env.PAYOS_CHECKSUM_KEY;
        if (!clientId || !apiKey || !checksumKey) {
            throw new Error("PayOS env vars not configured (PAYOS_CLIENT_ID / PAYOS_API_KEY / PAYOS_CHECKSUM_KEY)");
        }
        _payos = new PayOS({ clientId, apiKey, checksumKey });
    }
    return _payos;
}

// ── Plan config ────────────────────────────────────────────────────────────────

const PLANS: Record<PlanType, { name: string; price_monthly: number; tier: string }> = {
    premium: { name: "Premium", price_monthly: 59000, tier: "premium" },
    pro:     { name: "Pro",     price_monthly: 119000, tier: "pro" },
    store_pro: { name: "Store Pro", price_monthly: 49000, tier: "pro" },
};

// ── Shared activation helper (idempotent) ─────────────────────────���───────────

async function activateSubscription(
    tx: IPaymentTransaction,
    paymentRef?: string,
): Promise<void> {
    // Guard — idempotent: do nothing if already completed
    if (tx.status === "completed") return;

    tx.status = "completed";
    if (paymentRef) tx.payment_ref = paymentRef;
    await tx.save();

    const plan = PLANS[tx.plan_type];
    if (!plan) return;

    const now = new Date();
    const user = await User.findById(tx.user_id);
    if (user) {
        const base = user.subscription_expires_at && user.subscription_expires_at > now
            ? user.subscription_expires_at
            : now;
        const newExpiry = new Date(base);
        newExpiry.setMonth(newExpiry.getMonth() + tx.duration_months);
        user.subscription_tier = plan.tier as "premium" | "pro";
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
}

// ── Helpers ──────────────────��─────────────────────────────────���──────────────

function buildRef(txId: string): string {
    return `CALO${txId.slice(-8).toUpperCase()}`;
}

function getPaymentInstructions(method: string, amount: number, ref: string) {
    const formatted = amount.toLocaleString("vi-VN");
    if (method === "momo") {
        return {
            method: "MoMo",
            phone: process.env.PAYMENT_MOMO_PHONE || "0912345678",
            amount: formatted,
            note: ref,
            message: `Chuyển ${formatted}₫ qua MoMo đến ${process.env.PAYMENT_MOMO_PHONE || "0912345678"} nội dung: ${ref}`,
        };
    }
    return {
        method: "Chuyển khoản ngân hàng",
        bank: process.env.PAYMENT_BANK_NAME || "Vietcombank",
        account: process.env.PAYMENT_BANK_ACCOUNT || "1234567890",
        owner: process.env.PAYMENT_BANK_OWNER || "CALOCARE",
        amount: formatted,
        note: ref,
        message: `Chuyển ${formatted}₫ tới TK ${process.env.PAYMENT_BANK_ACCOUNT || "1234567890"} (${process.env.PAYMENT_BANK_NAME || "Vietcombank"}) nội dung: ${ref}`,
    };
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
                id: "pro",
                name: "Pro",
                price_monthly: 119000,
                features: {
                    scan_limit: -1,
                    scan_cooldown_min: null,
                    meal_plan_ai_daily: 5,
                    chat_limit: -1,
                    manual_log_limit: null,
                    scan_history_days: 90,
                    ads: false,
                    barcode_scanner: true,
                    meal_plan_ai: true,
                    exercise_tracker: true,
                    grocery_list: true,
                    export_csv: true,
                    weekly_report: true,
                    push_notifications: true,
                    progress_charts_months: null,
                    batch_scan: 3,
                    ai_nutritionist: true,
                    dietitian_booking: true,
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

        const isActive =
            fullUser.subscription_tier === "free" ||
            (fullUser.subscription_expires_at != null &&
                fullUser.subscription_expires_at > new Date());

        const recent = await PaymentTransaction.findOne({ user_id: user._id })
            .sort({ created_at: -1 })
            .select("plan_type status amount final_amount payment_method payment_ref created_at");

        res.json({
            tier: fullUser.subscription_tier,
            expires_at: fullUser.subscription_expires_at,
            is_active: isActive,
            latest_transaction: recent || null,
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/subscription/upgrade — create pending payment order
router.post("/upgrade", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { plan_type, duration_months = 1, payment_method = "bank_transfer", discount_code } = req.body;

        if (!PLANS[plan_type as PlanType]) {
            res.status(400).json({ error: "Invalid plan type" });
            return;
        }

        // ── Guard: block duplicate pending transactions (PM-01) ─────────────
        // If a pending transaction for the same plan was created within the last
        // 2 hours, return it instead of creating a duplicate.
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const existingPending = await PaymentTransaction.findOne({
            user_id: user._id,
            plan_type,
            target_type: "user",
            status: "pending",
            created_at: { $gte: twoHoursAgo },
        }).sort({ created_at: -1 });

        if (existingPending) {
            res.status(409).json({
                error: "pending_transaction_exists",
                message: "Bạn đã có giao dịch đang chờ thanh toán. Vui lòng hoàn tất hoặc đợi 2 giờ trước khi tạo mới.",
                tx_id: existingPending._id,
                payment_ref: buildRef(String(existingPending._id)),
                amount: existingPending.final_amount,
                payment_method: existingPending.payment_method,
                created_at: existingPending.created_at,
            });
            return;
        }

        const plan = PLANS[plan_type as PlanType];
        let baseAmount = plan.price_monthly * Number(duration_months);
        let finalAmount = baseAmount;

        // Apply global system-wide discount first (respects applicable_plans)
        const globalPct = await getGlobalDiscountPct(plan_type);
        if (globalPct > 0) {
            finalAmount = Math.round(finalAmount * (1 - globalPct / 100));
        }

        // Then apply user's discount code on top
        if (discount_code) {
            const code = await DiscountCode.findOne({
                code: discount_code.toUpperCase(),
                is_active: true,
                $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }],
            });
            if (code) {
                if (code.discount_type === "percentage") {
                    finalAmount = Math.round(baseAmount * (1 - code.discount_value / 100));
                } else {
                    finalAmount = Math.max(0, baseAmount - code.discount_value);
                }
                await DiscountCode.findByIdAndUpdate(code._id, { $inc: { used_count: 1 } });
            }
        }

        const tx = await PaymentTransaction.create({
            user_id: user._id,
            plan_type,
            target_type: "user",
            duration_months: Number(duration_months),
            amount: baseAmount,
            final_amount: finalAmount,
            discount_code: discount_code || undefined,
            status: "pending",
            payment_method,
        });

        const txId = String(tx._id);
        const ref  = buildRef(txId);

        // ── PayOS checkout link ──────────────────────────────────────────────
        if (payment_method === "payos") {
            const payos      = getPayOS();
            const clientUrl  = process.env.CLIENT_URL || "http://localhost:2004";
            // orderCode: 32-bit unsigned int derived from last 8 hex chars of txId
            const orderCode  = parseInt(txId.slice(-8), 16);
            // description max 25 chars — ref is "CALOXXXXXXXX" (12 chars)
            const description = ref.slice(0, 25);

            const link = await payos.paymentRequests.create({
                orderCode,
                amount: finalAmount,
                description,
                returnUrl: `${clientUrl}/subscription/success?txId=${txId}`,
                cancelUrl:  `${clientUrl}/subscription/cancel?txId=${txId}`,
                items: [{
                    name:     `${plan.name} ${Number(duration_months)}th`,
                    quantity: 1,
                    price:    finalAmount,
                }],
            });

            // Store orderCode string so the webhook can look it up
            tx.payment_ref = String(orderCode);
            await tx.save();

            return res.status(201).json({
                transaction_id: tx._id,
                plan_type,
                amount:       baseAmount,
                final_amount: finalAmount,
                status:       "pending",
                payment_method: "payos",
                checkout_url:  link.checkoutUrl,
                qr_code:       link.qrCode,
            });
        }

        // ── Bank transfer / MoMo fallback ────────────────────────────────────
        res.status(201).json({
            transaction_id: tx._id,
            plan_type,
            amount:       baseAmount,
            final_amount: finalAmount,
            status:       "pending",
            payment_ref_code: ref,
            payment_instructions: getPaymentInstructions(payment_method, finalAmount, ref),
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
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
        if (expectedSecret && secret !== expectedSecret) {
            res.status(401).json({ error: "Invalid webhook secret" });
            return;
        }

        if (!ref) {
            res.status(400).json({ error: "ref is required" });
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

        // Optional amount validation
        if (amount !== undefined && Number(amount) < tx.final_amount) {
            res.status(400).json({ error: "Payment amount insufficient" });
            return;
        }

        await activateSubscription(tx, payment_ref || ref);

        res.json({ message: "Subscription activated", transaction_id: tx._id });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// POST /api/subscription/webhook/payos — PayOS payment webhook
// PayOS sends this after each payment event; no auth header, verified by signature.
router.post("/webhook/payos", async (req: Request, res: Response) => {
    try {
        // Throws PayOS.InvalidSignatureError when signature is wrong
        let webhookData: Awaited<ReturnType<typeof getPayOS>["webhooks"]["verify"]>;
        try {
            webhookData = await getPayOS().webhooks.verify(req.body);
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
            target_type: "user",
        });

        if (!tx) {
            // Unknown or already processed — return 200 to stop PayOS retrying
            res.json({ message: "not found" });
            return;
        }

        await activateSubscription(tx, webhookData.reference);

        res.json({ message: "activated", transaction_id: tx._id });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// GET /api/subscription/return/payos — redirect after PayOS checkout page
// PayOS appends ?code=00&... on success, other codes on cancel/failure.
// Activation is handled by the webhook above — this only redirects the browser.
router.get("/return/payos", (req: Request, res: Response) => {
    const clientUrl = process.env.CLIENT_URL || "http://localhost:2004";
    if (req.query.code === "00") {
        res.redirect(`${clientUrl}/subscription/success?txId=${req.query.txId ?? ""}`);
    } else {
        res.redirect(`${clientUrl}/subscription/cancel?txId=${req.query.txId ?? ""}`);
    }
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

        await activateSubscription(tx, req.body.payment_ref || undefined);

        res.json({ message: "Subscription activated", transaction_id: tx._id });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
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
        if (tx.status === "completed") {
            res.status(400).json({ error: "Already completed" });
            return;
        }

        await activateSubscription(tx, req.body.payment_ref || undefined);

        res.json({ message: "Payment confirmed, subscription activated", transaction_id: tx._id });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
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

// ── IAP webhook (mobile u2192 server after RevenueCat purchase) ─────────────────
// Called optimistically by the mobile app; real entitlement sync goes through
// the RevenueCat server-to-server webhook configured in the RC dashboard.
router.post("/iap-webhook", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { tier } = req.body as { tier?: string; platform?: string; customer_id?: string };

        if (!tier || !["premium", "pro", "free"].includes(tier)) {
            return res.status(400).json({ error: "Invalid tier" });
        }

        await User.findByIdAndUpdate(user._id, { subscription_tier: tier });

        res.json({ ok: true, tier });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
