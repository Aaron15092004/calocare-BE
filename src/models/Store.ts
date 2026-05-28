import mongoose, { Schema, Document, Types } from "mongoose";

export interface IMenuItem {
    name_vi: string;
    name_en?: string;
    price?: number;
    description?: string;
    image_url?: string;
    energy_kcal?: number;
    protein?: number;
    lipid?: number;
    glucid?: number;
    fiber?: number;
    nutrients_extended?: Record<string, unknown>;
    nutrition_verified?: boolean;
    is_available: boolean;
}

export interface IStore extends Document {
    owner_id: Types.ObjectId;
    name: string;
    description?: string;
    address: string;
    city?: string;
    phone?: string;
    website?: string;
    location?: { lat: number; lng: number };
    google_place_id?: string;
    google_maps_url?: string;
    category?: string; // "restaurant" | "cafe" | "bakery" | "fastfood" | "other"
    images: string[];
    menu_items: IMenuItem[];
    subscription_tier: "basic" | "pro";
    subscription_expires_at?: Date;
    is_verified: boolean;
    is_active: boolean;
    reject_reason?: string;
    views_count: number;
    average_rating: number;
    rating_count: number;
    created_at: Date;
    updated_at: Date;
}

const MenuItemSchema = new Schema<IMenuItem>({
    name_vi: { type: String, required: true },
    name_en: { type: String },
    price: { type: Number },
    description: { type: String },
    image_url: { type: String },
    energy_kcal: { type: Number },
    protein: { type: Number },
    lipid: { type: Number },
    glucid: { type: Number },
    fiber: { type: Number },
    nutrients_extended: { type: Schema.Types.Mixed },
    nutrition_verified: { type: Boolean, default: false },
    is_available: { type: Boolean, default: true },
}, { _id: true });

const StoreSchema = new Schema<IStore>(
    {
        owner_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        name: { type: String, required: true, trim: true },
        description: { type: String },
        address: { type: String, required: true },
        city: { type: String },
        phone: { type: String },
        website: { type: String },
        location: {
            lat: { type: Number },
            lng: { type: Number },
        },
        google_place_id: { type: String },
        google_maps_url: { type: String },
        category: {
            type: String,
            enum: ["restaurant", "cafe", "bakery", "fastfood", "other"],
            default: "restaurant",
        },
        images: [{ type: String }],
        menu_items: [MenuItemSchema],
        subscription_tier: { type: String, enum: ["basic", "pro"], default: "basic" },
        subscription_expires_at: { type: Date },
        is_verified: { type: Boolean, default: false },
        is_active: { type: Boolean, default: false },
        reject_reason: { type: String },
        views_count: { type: Number, default: 0 },
        average_rating: { type: Number, default: 0 },
        rating_count: { type: Number, default: 0 },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

StoreSchema.index({ name: "text", description: "text" });
StoreSchema.index({ "location.lat": 1, "location.lng": 1 });

export default mongoose.model<IStore>("Store", StoreSchema);
