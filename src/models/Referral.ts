import mongoose, { Schema, Document, Types } from "mongoose";

export interface IReferral extends Document {
    referrer_id: Types.ObjectId;
    referee_id: Types.ObjectId;
    code: string;
    status: "applied";
    referrer_bonus_days: number;
    referee_bonus_days: number;
    used_at: Date;
    created_at: Date;
}

const ReferralSchema = new Schema<IReferral>(
    {
        referrer_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        referee_id: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
        code: { type: String, required: true, index: true },
        status: { type: String, enum: ["applied"], default: "applied" },
        referrer_bonus_days: { type: Number, default: 30 },
        referee_bonus_days: { type: Number, default: 7 },
        used_at: { type: Date, default: Date.now },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: false },
    },
);

export default mongoose.model<IReferral>("Referral", ReferralSchema);
