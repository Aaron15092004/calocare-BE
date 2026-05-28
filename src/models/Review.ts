import mongoose, { Schema, Document } from "mongoose";

export interface IReview extends Document {
    target_type: "recipe" | "store";
    target_id: mongoose.Types.ObjectId;
    user_id: mongoose.Types.ObjectId;
    rating: number;           // 1–5
    content?: string;
    images?: string[];
    helpful_votes: mongoose.Types.ObjectId[];
    store_reply?: string;
    store_reply_at?: Date;
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
}

const ReviewSchema = new Schema<IReview>(
    {
        target_type: { type: String, enum: ["recipe", "store"], required: true, index: true },
        target_id:   { type: Schema.Types.ObjectId, required: true, index: true },
        user_id:     { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        rating:      { type: Number, required: true, min: 1, max: 5 },
        content:     { type: String, maxlength: 2000 },
        images:      [{ type: String }],
        helpful_votes: [{ type: Schema.Types.ObjectId, ref: "User" }],
        store_reply:    { type: String, maxlength: 2000 },
        store_reply_at: { type: Date },
        is_deleted:  { type: Boolean, default: false, index: true },
    },
    { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

// One review per user per target
ReviewSchema.index({ user_id: 1, target_type: 1, target_id: 1 }, { unique: true });

export default mongoose.model<IReview>("Review", ReviewSchema);
