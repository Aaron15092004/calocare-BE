import mongoose, { Schema, Document } from "mongoose";

export interface IDiscountCode extends Document {
    code: string;
    discount_type: "percentage" | "fixed";
    discount_value: number;
    min_purchase?: number;
    max_uses?: number;
    used_count: number;
    is_active: boolean;
    starts_at?: Date;
    expires_at?: Date;
    description?: string;
    created_at: Date;
    updated_at: Date;
}

const DiscountCodeSchema = new Schema<IDiscountCode>(
    {
        code: { type: String, required: true, unique: true, uppercase: true },
        discount_type: { type: String, enum: ["percentage", "fixed"], required: true },
        discount_value: {
            type: Number,
            required: true,
            min: 0,
            validate: {
                validator(this: IDiscountCode, value: number) {
                    return this.discount_type !== "percentage" || value <= 100;
                },
                message: "Percentage discount cannot exceed 100",
            },
        },
        min_purchase: { type: Number, min: 0 },
        max_uses: { type: Number, min: 1 },
        used_count: { type: Number, default: 0, min: 0 },
        is_active: { type: Boolean, default: true },
        starts_at: { type: Date },
        expires_at: { type: Date },
        description: { type: String },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IDiscountCode>("DiscountCode", DiscountCodeSchema);
