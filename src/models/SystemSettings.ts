import mongoose, { Document, Schema } from "mongoose";

export interface ISystemSettings extends Document {
    key: string;
    global_discount_pct: number;     // 0 = no discount; >0 = percentage to deduct
    global_discount_expires: Date | null;
    applicable_plans: string[];      // empty = applies to all paid plans
    updated_by: string;
    updated_at: Date;
}

const SystemSettingsSchema = new Schema<ISystemSettings>({
    key: { type: String, required: true, unique: true, default: "global" },
    global_discount_pct: { type: Number, default: 0, min: 0, max: 100 },
    global_discount_expires: { type: Date, default: null },
    applicable_plans: { type: [String], default: [] },
    updated_by: { type: String, default: "system" },
    updated_at: { type: Date, default: Date.now },
});

export default mongoose.model<ISystemSettings>("SystemSettings", SystemSettingsSchema);
