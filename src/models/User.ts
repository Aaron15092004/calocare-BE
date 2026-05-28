import mongoose, { Schema, Document } from "mongoose";
import bcrypt from "bcryptjs";

export interface INutritionGoals {
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
}

export interface IUser extends Document {
    email: string;
    password?: string;
    google_id?: string;
    display_name: string;
    avatar_url?: string;
    role: "user" | "admin" | "moderator" | "store_owner";
    subscription_tier: "free" | "premium" | "pro";
    subscription_expires_at?: Date;
    is_banned: boolean;
    language: "vi" | "en";
    daily_nutrition_goals: INutritionGoals;
    preferences: Record<string, unknown>;
    refresh_tokens: string[];
    referral_code?: string;
    created_at: Date;
    updated_at: Date;
    comparePassword(candidatePassword: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        password: { type: String, select: false },
        google_id: { type: String, sparse: true },
        display_name: { type: String, required: true, trim: true },
        avatar_url: { type: String },
        role: { type: String, enum: ["user", "admin", "moderator", "store_owner"], default: "user" },
        subscription_tier: { type: String, enum: ["free", "premium", "pro"], default: "free" },
        subscription_expires_at: { type: Date },
        is_banned: { type: Boolean, default: false },
        language: { type: String, enum: ["vi", "en"], default: "vi" },
        daily_nutrition_goals: {
            calories: { type: Number },
            protein: { type: Number },
            carbs: { type: Number },
            fat: { type: Number },
            fiber: { type: Number },
        },
        preferences: { type: Schema.Types.Mixed, default: {} },
        refresh_tokens: [{ type: String, select: false }],
        referral_code: { type: String, sparse: true, unique: true },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

UserSchema.pre("save", async function (next) {
    if (!this.isModified("password") || !this.password) return next();
    this.password = await bcrypt.hash(this.password, 12);
    next();
});

UserSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
    if (!this.password) return false;
    return bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model<IUser>("User", UserSchema);