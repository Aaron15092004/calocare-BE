import mongoose, { Schema, Document, Types } from "mongoose";

export interface ICustomFood {
    name: string;
    description?: string;
    calories_kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g?: number;
    serving_description?: string;
}

export interface IMealPlanItem extends Document {
    meal_plan_id: Types.ObjectId;
    day_number: number;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack" | "morning_snack" | "afternoon_snack";
    recipe_id?: Types.ObjectId;
    food_id?: Types.ObjectId;
    usda_food_id?: Types.ObjectId;
    custom_food?: ICustomFood;
    source_type?: "food" | "recipe" | "usda" | "ai_generated";
    serving_size?: number;
    calories?: number;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
}

const CustomFoodSchema = new Schema<ICustomFood>(
    {
        name:                { type: String, required: true },
        description:         { type: String },
        calories_kcal:       { type: Number, required: true },
        protein_g:           { type: Number, required: true },
        carbs_g:             { type: Number, required: true },
        fat_g:               { type: Number, required: true },
        fiber_g:             { type: Number },
        serving_description: { type: String },
    },
    { _id: false },
);

const MealPlanItemSchema = new Schema<IMealPlanItem>(
    {
        meal_plan_id: { type: Schema.Types.ObjectId, ref: "MealPlan", required: true, index: true },
        day_number: { type: Number, required: true },
        meal_type: {
            type: String,
            enum: ["breakfast", "lunch", "dinner", "snack", "morning_snack", "afternoon_snack"],
            required: true,
        },
        recipe_id:    { type: Schema.Types.ObjectId, ref: "Recipe" },
        food_id:      { type: Schema.Types.ObjectId, ref: "Food" },
        usda_food_id: { type: Schema.Types.ObjectId, ref: "UsdaFood" },
        custom_food:  { type: CustomFoodSchema },
        source_type: { type: String, enum: ["food", "recipe", "usda", "ai_generated"] },
        serving_size: { type: Number },
        calories: { type: Number },
        sort_order: { type: Number, default: 0 },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IMealPlanItem>("MealPlanItem", MealPlanItemSchema);