import mongoose, { Document, Schema, Types } from "mongoose";

export interface IFamilyMember {
    user_id: Types.ObjectId;
    role: "owner" | "member";
    status: "active" | "removed";
    joined_at: Date;
    removed_at?: Date;
}

export interface IFamilyInvite {
    code: string;
    status: "active" | "used" | "revoked" | "expired";
    created_by: Types.ObjectId;
    created_at: Date;
    expires_at: Date;
    used_by?: Types.ObjectId;
    used_at?: Date;
}

export interface IFamilyGroup extends Document {
    owner_id: Types.ObjectId;
    max_members: number;
    members: IFamilyMember[];
    invites: IFamilyInvite[];
    status: "active" | "disabled";
    created_at: Date;
    updated_at: Date;
}

const FamilyMemberSchema = new Schema<IFamilyMember>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
        role: { type: String, enum: ["owner", "member"], required: true },
        status: { type: String, enum: ["active", "removed"], default: "active" },
        joined_at: { type: Date, default: Date.now },
        removed_at: { type: Date },
    },
    { _id: false },
);

const FamilyInviteSchema = new Schema<IFamilyInvite>(
    {
        code: { type: String, required: true, uppercase: true },
        status: { type: String, enum: ["active", "used", "revoked", "expired"], default: "active" },
        created_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
        created_at: { type: Date, default: Date.now },
        expires_at: { type: Date, required: true },
        used_by: { type: Schema.Types.ObjectId, ref: "User" },
        used_at: { type: Date },
    },
    { _id: false },
);

const FamilyGroupSchema = new Schema<IFamilyGroup>(
    {
        owner_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        max_members: { type: Number, default: 5, min: 2, max: 5 },
        members: { type: [FamilyMemberSchema], default: [] },
        invites: { type: [FamilyInviteSchema], default: [] },
        status: { type: String, enum: ["active", "disabled"], default: "active" },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    },
);

FamilyGroupSchema.index({ owner_id: 1, status: 1 });
FamilyGroupSchema.index({ "members.user_id": 1, status: 1 });
FamilyGroupSchema.index({ "invites.code": 1 }, { unique: true, sparse: true });

export default mongoose.model<IFamilyGroup>("FamilyGroup", FamilyGroupSchema);
