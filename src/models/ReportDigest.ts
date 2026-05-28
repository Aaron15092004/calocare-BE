import mongoose, { Schema, Document, Types } from "mongoose";

export interface IReportDigestContent {
    nhan_xet_tong_quan: string;
    diem_manh: string[];
    can_cai_thien: string[];
    thuc_pham_nen_them: string[];
    thuc_pham_nen_giam: string[];
    ke_hoach_tuan_toi: string;
}

export interface IReportDigest extends Document {
    user_id: Types.ObjectId;
    generated_at: Date;
    period_days: number;
    content: IReportDigestContent;
    expires_at: Date;
}

const ReportDigestSchema = new Schema<IReportDigest>({
    user_id:      { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    generated_at: { type: Date, default: Date.now },
    period_days:  { type: Number, default: 30 },
    content: {
        nhan_xet_tong_quan: { type: String, default: "" },
        diem_manh:          { type: [String], default: [] },
        can_cai_thien:      { type: [String], default: [] },
        thuc_pham_nen_them: { type: [String], default: [] },
        thuc_pham_nen_giam: { type: [String], default: [] },
        ke_hoach_tuan_toi:  { type: String, default: "" },
    },
    expires_at: { type: Date, index: { expires: 0 } }, // MongoDB TTL
});

export default mongoose.model<IReportDigest>("ReportDigest", ReportDigestSchema);
