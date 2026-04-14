import mongoose, { Schema, Document, Types } from "mongoose";

export interface IFoodItem {
    dish_name: string;
    source: "recipe" | "food" | "ai_estimate";
    matched_name?: string;
    nutrition: {
        calories: number;
        protein: number;
        carbs: number;
        fat: number;
        fiber: number;
    };
    weight_grams?: number;
    servings?: number;
    recipe_id?: Types.ObjectId;
    food_id?: Types.ObjectId;
}

export interface IFoodDiary extends Document {
    user_id: Types.ObjectId;
    scanned_at: Date;
    image_url?: string;
    foods: IFoodItem[];
    totals: {
        calories: number;
        protein: number;
        carbs: number;
        fat: number;
        fiber: number;
    };
    vitamins?: Record<string, unknown>;
    health_tips?: Record<string, unknown>;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    health_score?: number;
    notes?: string;
    created_at: Date;
    updated_at: Date;
}

const FoodDiarySchema = new Schema<IFoodDiary>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        scanned_at: { type: Date, default: Date.now },
        image_url: { type: String },
        foods: [
            {
                dish_name: String,
                source: { type: String, enum: ["recipe", "food", "ai_estimate"] },
                matched_name: String,
                nutrition: {
                    calories: { type: Number, default: 0 },
                    protein: { type: Number, default: 0 },
                    carbs: { type: Number, default: 0 },
                    fat: { type: Number, default: 0 },
                    fiber: { type: Number, default: 0 },
                },
                weight_grams: Number,
                servings: Number,
                recipe_id: { type: Schema.Types.ObjectId, ref: "Recipe" },
                food_id: { type: Schema.Types.ObjectId, ref: "Food" },
            },
        ],
        totals: {
            calories: { type: Number, default: 0 },
            protein: { type: Number, default: 0 },
            carbs: { type: Number, default: 0 },
            fat: { type: Number, default: 0 },
            fiber: { type: Number, default: 0 },
        },
        vitamins: { type: Schema.Types.Mixed },
        health_tips: { type: Schema.Types.Mixed },
        meal_type: {
            type: String,
            enum: ["breakfast", "lunch", "dinner", "snack"],
            default: "lunch",
        },
        health_score: { type: Number },
        notes: { type: String },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IFoodDiary>("FoodDiary", FoodDiarySchema);