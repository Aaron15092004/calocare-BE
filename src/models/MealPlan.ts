import mongoose, { Schema, Document, Types } from "mongoose";

export interface IMealPlan extends Document {
    title: string;
    description?: string;
    total_days: number;
    goal_type?: string;
    tags?: string[];
    is_public: boolean;
    is_approved: boolean;
    creator_id?: Types.ObjectId;
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
        is_public: { type: Boolean, default: true },
        is_approved: { type: Boolean, default: false },
        creator_id: { type: Schema.Types.ObjectId, ref: "User" },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IMealPlan>("MealPlan", MealPlanSchema);