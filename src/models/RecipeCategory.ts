import mongoose, { Schema, Document } from "mongoose";

export interface IRecipeCategory extends Document {
    name_vi: string;
    name_en?: string;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
}

const RecipeCategorySchema = new Schema<IRecipeCategory>(
    {
        name_vi: { type: String, required: true },
        name_en: { type: String },
        sort_order: { type: Number, default: 0 },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IRecipeCategory>("RecipeCategory", RecipeCategorySchema);