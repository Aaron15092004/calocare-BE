import mongoose, { Schema, Document, Types } from "mongoose";

// Generation lifecycle. Legacy docs have no status field — treat undefined as "completed".
export type MealPlanStatus = "generating" | "partial" | "completed" | "failed";

export interface IMealPlan extends Document {
    title: string;
    description?: string;
    total_days: number;
    goal_type?: string;
    tags?: string[];
    is_public: boolean;
    is_approved: boolean;
    creator_id?: Types.ObjectId;
    status?: MealPlanStatus;
    generated_days?: number;
    generation_error?: string;
    created_at: Date;
    updated_at: Date;
}

const MealPlanSchema = new Schema<IMealPlan>(
    {
        title: { type: String, required: true },
        description: { type: String },
        total_days: { type: Number, required: true, default: 7 },
        goal_type: { type: String },
        tags: [{ type: String }],
        is_public: { type: Boolean, default: false },
        is_approved: { type: Boolean, default: false },
        creator_id: { type: Schema.Types.ObjectId, ref: "User" },
        status: { type: String, enum: ["generating", "partial", "completed", "failed"] },
        generated_days: { type: Number },
        generation_error: { type: String },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

MealPlanSchema.index({ creator_id: 1, created_at: -1 });
MealPlanSchema.index({ is_public: 1, is_approved: 1, goal_type: 1 });

export default mongoose.model<IMealPlan>("MealPlan", MealPlanSchema);