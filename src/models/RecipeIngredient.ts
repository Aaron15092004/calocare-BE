import mongoose, { Schema, Document, Types } from "mongoose";

export interface IRecipeIngredient extends Document {
    recipe_id: Types.ObjectId;
    food_id: Types.ObjectId;
    amount: number;
    unit?: string;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
}

const RecipeIngredientSchema = new Schema<IRecipeIngredient>(
    {
        recipe_id: { type: Schema.Types.ObjectId, ref: "Recipe", required: true, index: true },
        food_id: { type: Schema.Types.ObjectId, ref: "Food", required: true },
        amount: { type: Number, required: true },
        unit: { type: String },
        sort_order: { type: Number, default: 0 },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IRecipeIngredient>("RecipeIngredient", RecipeIngredientSchema);