import mongoose, { Schema, Document } from "mongoose";

export interface IBanner extends Document {
    title: string;
    subtitle?: string;
    image_url?: string;
    link_url?: string;
    cta_text?: string;
    bg_gradient?: string;
    text_color?: string;
    show_text: boolean;
    is_active: boolean;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
}

const BannerSchema = new Schema<IBanner>(
    {
        title:       { type: String, default: "" },
        subtitle:    { type: String },
        image_url:   { type: String },
        link_url:    { type: String },
        cta_text:    { type: String, default: "Xem ngay" },
        bg_gradient: { type: String, default: "from-violet-600 to-purple-700" },
        text_color:  { type: String, default: "white" },
        show_text:   { type: Boolean, default: true },
        is_active:   { type: Boolean, default: true },
        sort_order:  { type: Number, default: 0 },
    },
    { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

export default mongoose.model<IBanner>("Banner", BannerSchema);
