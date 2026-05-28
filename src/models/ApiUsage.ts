import mongoose, { Schema, Document } from "mongoose";

export interface IApiUsage extends Document {
    service: string;  // e.g. "unsplash"
    hour: string;     // ISO hour slice: "2026-04-30T08"
    count: number;
}

const ApiUsageSchema = new Schema<IApiUsage>(
    {
        service: { type: String, required: true },
        hour: { type: String, required: true },
        count: { type: Number, default: 0 },
    },
    { timestamps: false },
);

ApiUsageSchema.index({ service: 1, hour: 1 }, { unique: true });

export default mongoose.model<IApiUsage>("ApiUsage", ApiUsageSchema);
