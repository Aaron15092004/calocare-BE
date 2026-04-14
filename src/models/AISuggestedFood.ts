import mongoose, { Schema, Document } from "mongoose";

export interface IAISuggestedFood extends Document {
    name: string;
    calories_per_100g: number;
    protein_per_100g: number;
    carbs_per_100g: number;
    fat_per_100g: number;
    fiber_per_100g: number;
    reference_weight_grams: number;
    times_seen: number;
    created_at: Date;
    updated_at: Date;
}

const AISuggestedFoodSchema = new Schema<IAISuggestedFood>(
    {
        name: { type: String, required: true, unique: true, index: true },
        calories_per_100g: { type: Number, default: 0 },
        protein_per_100g: { type: Number, default: 0 },
        carbs_per_100g: { type: Number, default: 0 },
        fat_per_100g: { type: Number, default: 0 },
        fiber_per_100g: { type: Number, default: 0 },
        reference_weight_grams: { type: Number, default: 300 },
        times_seen: { type: Number, default: 1 },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

AISuggestedFoodSchema.index({ name: "text" });

export default mongoose.model<IAISuggestedFood>("AISuggestedFood", AISuggestedFoodSchema);
