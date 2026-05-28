import mongoose, { Schema, Document, Types } from "mongoose";

export interface IRecipe extends Document {
    code?: string;
    name_vi: string;
    name_en?: string;
    description?: string;
    servings: number;
    prep_time_minutes?: number;
    cook_time_minutes?: number;
    difficulty?: "easy" | "medium" | "hard";
    meal_type?: "breakfast" | "lunch" | "dinner" | "snack" | "any";
    cuisine_type?: string;
    instructions?: Record<string, unknown>[];
    tags?: string[];
    category_id?: Types.ObjectId;
    is_public: boolean;
    is_approved: boolean;
    ai_training_approved: boolean;
    creator_id?: Types.ObjectId;
    updated_by?: Types.ObjectId;
    // Nutrition per serving
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    total_weight?: number;   // total gram weight of all ingredients (for per-100g normalization)
    nutrition_source?: "ingredients" | "manual";  // "ingredients" = computed from RecipeIngredients; "manual" = stored directly (e.g. USDA)
    nutrients_extended?: {
        minerals?: Record<string, number>;
        vitamins?: Record<string, number>;
        fats?: Record<string, number>;
        [key: string]: unknown;
    };
    // Images: images[0] is the cover; extra images used for AI training
    image_url?: string;   // kept for backward compat (mirrors images[0])
    images: string[];
    image_attribution?: {
        source: string;               // e.g. "unsplash"
        photographer_name: string;
        photographer_url: string;     // includes utm params
        photo_url: string;            // includes utm params
        download_location: string;    // Unsplash tracking endpoint (ToS required)
    };
    source_reference?: string;  // e.g. "FS-{food_id}" for FatSecret-sourced recipes
    // Engagement
    view_count: number;
    average_rating: number;
    rating_count: number;
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
}

const RecipeSchema = new Schema<IRecipe>(
    {
        code: { type: String, unique: true, sparse: true },
        name_vi: { type: String, required: true, index: true },
        name_en: { type: String },
        description: { type: String },
        servings: { type: Number, default: 1 },
        prep_time_minutes: { type: Number },
        cook_time_minutes: { type: Number },
        difficulty: { type: String, enum: ["easy", "medium", "hard"] },
        meal_type: { type: String, enum: ["breakfast", "lunch", "dinner", "snack", "any"] },
        cuisine_type: { type: String },
        instructions: [{ type: Schema.Types.Mixed }],
        tags: [{ type: String }],
        category_id: { type: Schema.Types.ObjectId, ref: "RecipeCategory" },
        is_public: { type: Boolean, default: true },
        is_approved: { type: Boolean, default: false },
        ai_training_approved: { type: Boolean, default: false },
        creator_id: { type: Schema.Types.ObjectId, ref: "User" },
        updated_by: { type: Schema.Types.ObjectId, ref: "User" },
        calories: { type: Number },
        protein: { type: Number },
        carbs: { type: Number },
        fat: { type: Number },
        fiber: { type: Number },
        total_weight: { type: Number },
        nutrition_source: { type: String, enum: ["ingredients", "manual"] },
        nutrients_extended: { type: Schema.Types.Mixed },
        image_url: { type: String },
        images: [{ type: String }],
        image_attribution: {
            source: { type: String },
            photographer_name: { type: String },
            photographer_url: { type: String },
            photo_url: { type: String },
            download_location: { type: String },
        },
        source_reference: { type: String, sparse: true, index: true },
        view_count: { type: Number, default: 0 },
        average_rating: { type: Number, default: 0 },
        rating_count: { type: Number, default: 0 },
        is_deleted: { type: Boolean, default: false, index: true },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

RecipeSchema.index({ name_vi: "text", tags: "text" });

export default mongoose.model<IRecipe>("Recipe", RecipeSchema);
