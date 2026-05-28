import mongoose, { Schema, Document, Types } from "mongoose";

export interface IFood extends Document {
    code?: string;
    name_vi: string;
    name_en?: string;
    food_group_id?: Types.ObjectId;
    energy_kcal: number;
    protein: number;
    lipid: number;
    glucid: number;
    fiber?: number;
    water?: number;
    ash?: number;
    waste_percentage?: number;
    nutrients_extended?: Record<string, unknown>;
    search_keywords?: string[];
    is_approved: boolean;
    creator_id?: Types.ObjectId;
    updated_by?: Types.ObjectId;
    notes?: string;
    source_reference?: string;
    sequence_number?: number;
    image_url?: string;
    image_attribution?: {
        source: string;
        photographer_name: string;
        photographer_url: string;
        photo_url: string;
        download_location: string;
    };
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
}

const FoodSchema = new Schema<IFood>(
    {
        code: { type: String, sparse: true },
        name_vi: { type: String, required: true, index: true },
        name_en: { type: String },
        food_group_id: { type: Schema.Types.ObjectId, ref: "FoodGroup" },
        energy_kcal: { type: Number, default: 0 },
        protein: { type: Number, default: 0 },
        lipid: { type: Number, default: 0 },
        glucid: { type: Number, default: 0 },
        fiber: { type: Number },
        water: { type: Number },
        ash: { type: Number },
        waste_percentage: { type: Number },
        nutrients_extended: { type: Schema.Types.Mixed },
        search_keywords: [{ type: String }],
        is_approved: { type: Boolean, default: false },
        creator_id: { type: Schema.Types.ObjectId, ref: "User" },
        updated_by: { type: Schema.Types.ObjectId, ref: "User" },
        notes: { type: String },
        source_reference: { type: String },
        sequence_number: { type: Number },
        image_url: { type: String },
        image_attribution: {
            source: { type: String },
            photographer_name: { type: String },
            photographer_url: { type: String },
            photo_url: { type: String },
            download_location: { type: String },
        },
        is_deleted: { type: Boolean, default: false, index: true },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

FoodSchema.index({ name_vi: "text", search_keywords: "text" });

export default mongoose.model<IFood>("Food", FoodSchema);
