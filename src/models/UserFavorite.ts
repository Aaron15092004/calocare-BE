import mongoose, { Schema, Document } from "mongoose";

export interface IUserFavorite extends Document {
    user_id: mongoose.Types.ObjectId;
    item_type: "food" | "recipe";
    item_id: mongoose.Types.ObjectId;
    created_at: Date;
}

const UserFavoriteSchema = new Schema<IUserFavorite>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
        item_type: { type: String, enum: ["food", "recipe"], required: true },
        item_id: { type: Schema.Types.ObjectId, required: true },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: false },
    },
);

// Prevent duplicates
UserFavoriteSchema.index({ user_id: 1, item_type: 1, item_id: 1 }, { unique: true });

export default mongoose.model<IUserFavorite>("UserFavorite", UserFavoriteSchema);
