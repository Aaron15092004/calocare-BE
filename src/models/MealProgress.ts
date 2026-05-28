import mongoose, { Schema, Document, Types } from "mongoose";

export interface IMealProgress extends Document {
    user_id: Types.ObjectId;
    user_meal_plan_id?: Types.ObjectId;  // scopes progress to a specific UserMealPlan
    day_number: number;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack" | "morning_snack" | "afternoon_snack";
    recipe_id?: Types.ObjectId;
    completed_at: Date;
    notes?: string;
    created_at: Date;
    updated_at: Date;
}

const MealProgressSchema = new Schema<IMealProgress>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        user_meal_plan_id: { type: Schema.Types.ObjectId, ref: "UserMealPlan", index: true },
        day_number: { type: Number, required: true },
        meal_type: {
            type: String,
            enum: ["breakfast", "lunch", "dinner", "snack", "morning_snack", "afternoon_snack"],
            required: true,
        },
        recipe_id: { type: Schema.Types.ObjectId, ref: "Recipe" },
        completed_at: { type: Date, default: Date.now },
        notes: { type: String },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IMealProgress>("MealProgress", MealProgressSchema);