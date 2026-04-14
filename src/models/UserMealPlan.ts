import mongoose, { Schema, Document, Types } from "mongoose";

export interface IUserMealPlan extends Document {
    user_id: Types.ObjectId;
    meal_plan_id: Types.ObjectId;
    start_date?: Date;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

const UserMealPlanSchema = new Schema<IUserMealPlan>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        meal_plan_id: { type: Schema.Types.ObjectId, ref: "MealPlan", required: true },
        start_date: { type: Date },
        is_active: { type: Boolean, default: true },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IUserMealPlan>("UserMealPlan", UserMealPlanSchema);