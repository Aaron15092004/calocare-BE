import mongoose, { Schema, Document, Types } from "mongoose";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface IChatMessage {
    role: ChatRole;
    content: string;
    tool_call?: {
        name: string;
        arguments: Record<string, unknown>;
    };
    tool_result?: unknown;
    timestamp: Date;
}

export interface IChatSession extends Document {
    user_id: Types.ObjectId;
    messages: IChatMessage[];
    context_summary?: string;
    active: boolean;
    expires_at: Date;
    created_at: Date;
    updated_at: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
    {
        role: { type: String, enum: ["user", "assistant", "system", "tool"], required: true },
        content: { type: String, required: true },
        tool_call: {
            name: { type: String },
            arguments: { type: Schema.Types.Mixed },
        },
        tool_result: { type: Schema.Types.Mixed },
        timestamp: { type: Date, default: Date.now },
    },
    { _id: false },
);

const ChatSessionSchema = new Schema<IChatSession>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        messages: [ChatMessageSchema],
        context_summary: { type: String },
        active: { type: Boolean, default: true, index: true },
        expires_at: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

export default mongoose.model<IChatSession>("ChatSession", ChatSessionSchema);
