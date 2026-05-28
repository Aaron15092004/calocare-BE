import mongoose, { Schema, Document, Types } from "mongoose";

export interface IUsdaFoodPortion {
    description: string;
    gram_weight: number;
}

export interface IUsdaFoodInputFood {
    fdc_id?: number;
    description: string;
    description_vi?: string;
    amount?: number;
    unit?: string;
}

export interface INutrientsExtended {
    minerals?: Record<string, number>;
    vitamins?: Record<string, number>;
    fats?: Record<string, number>;
    [key: string]: unknown;
}

export interface IUsdaFood extends Document {
    fdc_id: number;
    food_code?: string;
    description_en: string;
    description_vi?: string;
    wweia_category?: string;
    wweia_category_code?: number;
    // Nutrition flat (tru00f9ng tu00ean vu1edbi Food schema u2014 per 100g)
    energy_kcal: number;
    protein: number;
    lipid: number;
    glucid: number;
    fiber?: number;
    water?: number;
    // Extended nutrients
    nutrients_extended?: INutrientsExtended;
    portions: IUsdaFoodPortion[];
    input_foods: IUsdaFoodInputFood[];
    diet_tags: string[];
    search_text: string;
    // Atlas Vector Search u2014 lu01b0u tru1ef1c tiu1ebfp trong document
    embedding?: number[];
    // Tracking enrichment
    imported_to_foods: boolean;
    imported_food_id?: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const UsdaFoodSchema = new Schema<IUsdaFood>(
    {
        fdc_id: { type: Number, required: true, unique: true, index: true },
        food_code: { type: String },
        description_en: { type: String, required: true },
        description_vi: { type: String },
        wweia_category: { type: String, index: true },
        wweia_category_code: { type: Number },
        energy_kcal: { type: Number, default: 0 },
        protein: { type: Number, default: 0 },
        lipid: { type: Number, default: 0 },
        glucid: { type: Number, default: 0 },
        fiber: { type: Number },
        water: { type: Number },
        nutrients_extended: { type: Schema.Types.Mixed },
        portions: [
            {
                description: { type: String },
                gram_weight: { type: Number },
                _id: false,
            },
        ],
        input_foods: [
            {
                fdc_id: { type: Number },
                description: { type: String },
                description_vi: { type: String },
                amount: { type: Number },
                unit: { type: String },
                _id: false,
            },
        ],
        diet_tags: [{ type: String, index: true }],
        search_text: { type: String, required: true },
        embedding: [{ type: Number }],
        imported_to_foods: { type: Boolean, default: false, index: true },
        imported_food_id: { type: Schema.Types.ObjectId, ref: "Food" },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IUsdaFood>("UsdaFood", UsdaFoodSchema);
