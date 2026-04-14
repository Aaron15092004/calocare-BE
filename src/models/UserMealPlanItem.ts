import mongoose, { Schema, Document, Types } from "mongoose";

export interface IUserMealPlanItem extends Document {
    user_meal_plan_id: Types.ObjectId;
    day_number: number;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    recipe_id?: Types.ObjectId;
    food_id?: Types.ObjectId;
    serving_size?: number;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
}

const UserMealPlanItemSchema = new Schema<IUserMealPlanItem>(
    {
        user_meal_plan_id: {
            type: Schema.Types.ObjectId,
            ref: "UserMealPlan",
            required: true,
            index: true,
        },
        day_number: { type: Number, required: true },
        meal_type: {
            type: String,
            enum: ["breakfast", "lunch", "dinner", "snack"],
            required: true,
        },
        recipe_id: { type: Schema.Types.ObjectId, ref: "Recipe" },
        food_id: { type: Schema.Types.ObjectId, ref: "Food" },
        serving_size: { type: Number },
        sort_order: { type: Number, default: 0 },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IUserMealPlanItem>("UserMealPlanItem", UserMealPlanItemSchema);