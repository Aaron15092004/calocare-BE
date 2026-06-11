import mongoose, { Schema, Document, Types } from "mongoose";

export type PlanType = "premium" | "family" | "pro" | "store_pro";

export interface IPaymentTransaction extends Document {
    user_id: Types.ObjectId;
    plan_type: PlanType;
    target_type: "user" | "store";
    store_id?: Types.ObjectId;
    duration_months: number;
    amount: number;          // before discount
    final_amount: number;    // after discount
    discount_code?: string;
    status: "pending" | "completed" | "failed" | "refunded";
    currency: string;
    payment_method?: string; // "momo" | "vnpay" | "bank_transfer" | "credit_card"
    payment_ref?: string;    // external transaction ID
    notes?: string;
    created_at: Date;
    updated_at: Date;
}

const PaymentTransactionSchema = new Schema<IPaymentTransaction>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        plan_type: {
            type: String,
            enum: ["premium", "family", "pro", "store_pro"],
            required: true,
        },
        target_type: { type: String, enum: ["user", "store"], default: "user" },
        store_id: { type: Schema.Types.ObjectId, ref: "Store" },
        duration_months: { type: Number, default: 1 },
        amount: { type: Number, required: true },
        final_amount: { type: Number, required: true },
        discount_code: { type: String },
        status: {
            type: String,
            enum: ["pending", "completed", "failed", "refunded"],
            default: "pending",
        },
        currency: { type: String, default: "VND" },
        payment_method: { type: String },
        payment_ref: { type: String },
        notes: { type: String },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IPaymentTransaction>("PaymentTransaction", PaymentTransactionSchema);
