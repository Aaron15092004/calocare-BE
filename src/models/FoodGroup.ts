import mongoose, { Schema, Document, Types } from "mongoose";

export interface IFoodGroup extends Document {
    code?: number;        // legacy integer ID from PostgreSQL — used for CSV import mapping
    name_vi: string;
    name_en?: string;
    description?: string;
    icon_url?: string;
    sort_order?: number;
    creator_id?: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const FoodGroupSchema = new Schema<IFoodGroup>(
    {
        code: { type: Number, sparse: true, unique: true },
        name_vi: { type: String, required: true },
        name_en: { type: String },
        description: { type: String },
        icon_url: { type: String },
        sort_order: { type: Number, default: 0 },
        creator_id: { type: Schema.Types.ObjectId, ref: "User" },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IFoodGroup>("FoodGroup", FoodGroupSchema);
