import mongoose, { Schema, Document, Types } from "mongoose";

export type EnrichmentTargetType = "food" | "recipe";
export type EnrichmentTriggerType = "search" | "scan" | "meal_plan" | "diary" | "admin";
export type EnrichmentStatus =
    | "pending"
    | "processing"
    | "imported"
    | "failed"
    | "skipped"
    | "failed_retryable";

export interface IEnrichmentTrigger {
    type: EnrichmentTriggerType;
    user_id?: Types.ObjectId;
    score?: number;
}

export interface IEnrichmentQueue extends Document {
    target_type: EnrichmentTargetType;
    // food jobs
    usda_food_id?: Types.ObjectId;
    fdc_id?: number;
    // recipe jobs
    recipe_id?: Types.ObjectId;
    triggered_by: IEnrichmentTrigger;
    status: EnrichmentStatus;
    imported_food_id?: Types.ObjectId;
    error_message?: string;
    // retry support
    retry_count: number;
    next_retry_at?: Date;
    created_at: Date;
    updated_at: Date;
}

const EnrichmentQueueSchema = new Schema<IEnrichmentQueue>(
    {
        target_type: {
            type: String,
            enum: ["food", "recipe"],
            default: "food",
            required: true,
        },
        usda_food_id: { type: Schema.Types.ObjectId, ref: "UsdaFood" },
        fdc_id: { type: Number },
        recipe_id: { type: Schema.Types.ObjectId, ref: "Recipe" },
        triggered_by: {
            type: {
                type: String,
                enum: ["search", "scan", "meal_plan", "diary"],
                required: true,
            },
            user_id: { type: Schema.Types.ObjectId, ref: "User" },
            score: { type: Number },
        },
        status: {
            type: String,
            enum: ["pending", "processing", "imported", "failed", "skipped", "failed_retryable"],
            default: "pending",
            index: true,
        },
        imported_food_id: { type: Schema.Types.ObjectId, ref: "Food" },
        error_message: { type: String },
        retry_count: { type: Number, default: 0 },
        next_retry_at: { type: Date },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

// Worker: pick pending FIFO
EnrichmentQueueSchema.index({ status: 1, created_at: 1 });

// Unique partial indexes — atomic race-condition guard.
// NOTE: if upgrading from a previous version, manually drop old indexes first:
//   db.enrichmentqueues.dropIndex("fdc_id_1_status_1")
//   db.enrichmentqueues.dropIndex("recipe_id_1_status_1")
// Then restart the app to let Mongoose recreate them with unique:true.
EnrichmentQueueSchema.index(
    { fdc_id: 1 },
    {
        unique: true,
        partialFilterExpression: { status: "pending", fdc_id: { $exists: true } },
        name: "uniq_fdc_id_pending",
    },
);
EnrichmentQueueSchema.index(
    { recipe_id: 1 },
    {
        unique: true,
        partialFilterExpression: { status: "pending", recipe_id: { $exists: true } },
        name: "uniq_recipe_id_pending",
    },
);

export default mongoose.model<IEnrichmentQueue>("EnrichmentQueue", EnrichmentQueueSchema);
