import mongoose, { Schema, Document, Types } from "mongoose";

export interface IRecipeVector extends Document {
    source_id: Types.ObjectId;
    source_type: "recipe";
    embedding: number[];
    // Snapshot metadata u2014 filter nhanh khu00f4ng cu1ea7n lookup
    name: string;
    diet_tags: string[];
    is_approved: boolean;
    embedding_model: string;
    embedding_version: number;
    created_at: Date;
    updated_at: Date;
}

const RecipeVectorSchema = new Schema<IRecipeVector>(
    {
        source_id: { type: Schema.Types.ObjectId, ref: "Recipe", required: true, unique: true },
        source_type: { type: String, default: "recipe" },
        embedding: [{ type: Number }],
        name: { type: String, required: true },
        diet_tags: [{ type: String }],
        is_approved: { type: Boolean, default: false },
        embedding_model: { type: String, default: "voyage-4-lite" },
        embedding_version: { type: Number, default: 1 },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IRecipeVector>("RecipeVector", RecipeVectorSchema);
