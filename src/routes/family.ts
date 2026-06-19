import { Router, Request, Response } from "express";
import crypto from "crypto";
import { authenticate } from "../middleware/auth";
import User, { IUser } from "../models/User";
import FamilyGroup, { IFamilyGroup } from "../models/FamilyGroup";

const router = Router();
router.use(authenticate);

const FAMILY_SEAT_LIMIT = 5;
const INVITE_TTL_DAYS = 7;

function isActiveFamilyTier(user?: Pick<IUser, "subscription_tier" | "subscription_expires_at"> | null): boolean {
    if (!user || !["family", "pro"].includes(user.subscription_tier)) return false;
    return !!user.subscription_expires_at && user.subscription_expires_at > new Date();
}

function activeMembers(group: IFamilyGroup) {
    return group.members.filter((member) => member.status === "active");
}

function activeInvites(group: IFamilyGroup) {
    const now = new Date();
    return group.invites.filter((invite) => invite.status === "active" && invite.expires_at > now);
}

function makeInviteCode(): string {
    return crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function ensureOwnerGroup(owner: IUser): Promise<IFamilyGroup> {
    let group = await FamilyGroup.findOne({ owner_id: owner._id, status: "active" });
    if (!group) {
        group = await FamilyGroup.create({
            owner_id: owner._id,
            max_members: FAMILY_SEAT_LIMIT,
            members: [{
                user_id: owner._id,
                role: "owner",
                status: "active",
                joined_at: new Date(),
            }],
        });
    } else if (!group.members.some((member) => String(member.user_id) === String(owner._id) && member.status === "active")) {
        group.members.push({
            user_id: owner._id as any,
            role: "owner",
            status: "active",
            joined_at: new Date(),
        });
        await group.save();
    }

    await User.updateOne(
        { _id: owner._id },
        {
            $set: {
                family_group_id: group._id,
                family_role: "owner",
                family_access_source: group._id,
            },
        },
    );

    return group;
}

async function serializeGroup(group: IFamilyGroup) {
    const populated = await FamilyGroup.findById(group._id)
        .populate("owner_id", "display_name email avatar_url subscription_expires_at subscription_tier")
        .populate("members.user_id", "display_name email avatar_url subscription_tier subscription_expires_at")
        .lean();

    if (!populated) return null;
    const members = (populated.members || []).filter((member: any) => member.status === "active");
    const invites = (populated.invites || [])
        .filter((invite: any) => invite.status === "active" && invite.expires_at > new Date())
        .map((invite: any) => ({
            code: invite.code,
            expires_at: invite.expires_at,
            created_at: invite.created_at,
        }));

    return {
        id: populated._id,
        owner: populated.owner_id,
        max_members: populated.max_members,
        seats_used: members.length,
        seats_available: Math.max(0, populated.max_members - members.length),
        members,
        invites,
    };
}

router.get("/", async (req: Request, res: Response) => {
    try {
        const user = await User.findById((req.user as IUser)._id).select(
            "subscription_tier subscription_expires_at family_group_id family_role family_access_source",
        );
        if (!user) { res.status(404).json({ error: "User not found" }); return; }

        let ownedGroup = null;
        if (isActiveFamilyTier(user) && user.family_role !== "member") {
            const group = await ensureOwnerGroup(user);
            ownedGroup = await serializeGroup(group);
        }

        let memberGroup = null;
        if (user.family_group_id && user.family_role === "member") {
            const group = await FamilyGroup.findOne({
                _id: user.family_group_id,
                status: "active",
                members: { $elemMatch: { user_id: user._id, status: "active" } },
            });
            if (group) memberGroup = await serializeGroup(group);
        }

        res.json({
            is_family_active: isActiveFamilyTier(user),
            role: user.family_role || null,
            owned_group: ownedGroup,
            member_group: memberGroup,
            invite_base_url: `${process.env.FRONTEND_URL || process.env.CLIENT_URL || "https://calovie.app"}/subscription`,
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/invites", async (req: Request, res: Response) => {
    try {
        const owner = await User.findById((req.user as IUser)._id).select("subscription_tier subscription_expires_at family_role");
        if (!owner || !isActiveFamilyTier(owner) || owner.family_role === "member") {
            res.status(403).json({ error: "family_required", message: "Tính năng mời thành viên yêu cầu gói Family đang hoạt động." });
            return;
        }

        const group = await ensureOwnerGroup(owner);
        const usedSeats = activeMembers(group).length;
        const reservedSeats = activeInvites(group).length;
        if (usedSeats >= group.max_members || usedSeats + reservedSeats >= group.max_members) {
            res.status(400).json({ error: "family_full", message: "Gói Family đã hết chỗ trống hoặc có mã mời đang giữ chỗ." });
            return;
        }

        let code = makeInviteCode();
        for (let i = 0; i < 8 && await FamilyGroup.exists({ "invites.code": code }); i++) {
            code = makeInviteCode();
        }

        const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
        group.invites.push({
            code,
            status: "active",
            created_by: owner._id as any,
            created_at: new Date(),
            expires_at: expiresAt,
        });
        await group.save();

        res.status(201).json({
            code,
            expires_at: expiresAt,
            invite_url: `${process.env.FRONTEND_URL || process.env.CLIENT_URL || "https://calovie.app"}/subscription?familyCode=${code}`,
            group: await serializeGroup(group),
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/join", async (req: Request, res: Response) => {
    try {
        const code = typeof req.body.code === "string" ? req.body.code.trim().toUpperCase() : "";
        if (!code) { res.status(400).json({ error: "code_required", message: "Vui lòng nhập mã mời Family." }); return; }

        const user = await User.findById((req.user as IUser)._id).select(
            "subscription_tier subscription_expires_at family_group_id family_role family_access_source",
        );
        if (!user) { res.status(404).json({ error: "User not found" }); return; }
        if (user.family_role === "owner" && user.family_group_id) {
            res.status(400).json({ error: "already_family_owner", message: "Bạn đang là chủ một gói Family khác." });
            return;
        }
        if (user.family_role === "member" && user.family_group_id) {
            res.status(400).json({ error: "already_family_member", message: "Bạn đang là thành viên của một gói Family khác." });
            return;
        }

        const group = await FamilyGroup.findOne({ "invites.code": code, status: "active" });
        const invite = group?.invites.find((item) => item.code === code);
        if (!group || !invite || invite.status !== "active") {
            res.status(404).json({ error: "invite_not_found", message: "Mã mời không tồn tại hoặc đã được sử dụng." });
            return;
        }
        if (invite.expires_at <= new Date()) {
            invite.status = "expired";
            await group.save();
            res.status(400).json({ error: "invite_expired", message: "Mã mời đã hết hạn." });
            return;
        }

        const owner = await User.findById(group.owner_id).select("subscription_tier subscription_expires_at");
        if (!isActiveFamilyTier(owner)) {
            res.status(400).json({ error: "owner_family_inactive", message: "Gói Family của chủ nhóm hiện không hoạt động." });
            return;
        }

        const existingMember = group.members.find((member) => String(member.user_id) === String(user._id) && member.status === "active");
        if (existingMember) {
            res.json({ ok: true, group: await serializeGroup(group), message: "Bạn đã ở trong nhóm Family này." });
            return;
        }

        if (activeMembers(group).length >= group.max_members) {
            res.status(400).json({ error: "family_full", message: "Gói Family đã đủ 5 thành viên." });
            return;
        }

        invite.status = "used";
        invite.used_by = user._id as any;
        invite.used_at = new Date();
        group.members.push({
            user_id: user._id as any,
            role: "member",
            status: "active",
            joined_at: new Date(),
        });
        await group.save();

        await User.updateOne(
            { _id: user._id },
            {
                $set: {
                    subscription_tier: "family",
                    subscription_expires_at: owner!.subscription_expires_at,
                    family_group_id: group._id,
                    family_role: "member",
                    family_access_source: group._id,
                },
            },
        );

        res.json({
            ok: true,
            message: "Bạn đã tham gia gói Family.",
            group: await serializeGroup(group),
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.delete("/members/:userId", async (req: Request, res: Response) => {
    try {
        const owner = await User.findById((req.user as IUser)._id).select("subscription_tier subscription_expires_at family_role");
        if (!owner || !isActiveFamilyTier(owner) || owner.family_role === "member") {
            res.status(403).json({ error: "family_required", message: "Chỉ chủ gói Family đang hoạt động mới có thể xóa thành viên." });
            return;
        }

        const group = await ensureOwnerGroup(owner);
        if (String(req.params.userId) === String(owner._id)) {
            res.status(400).json({ error: "cannot_remove_owner", message: "Không thể xóa chủ gói Family." });
            return;
        }

        const member = group.members.find((item) => String(item.user_id) === req.params.userId && item.status === "active");
        if (!member) { res.status(404).json({ error: "member_not_found", message: "Không tìm thấy thành viên." }); return; }

        member.status = "removed";
        member.removed_at = new Date();
        await group.save();

        await User.updateOne(
            { _id: req.params.userId, family_access_source: group._id },
            {
                $set: { subscription_tier: "free" },
                $unset: {
                    subscription_expires_at: "",
                    family_group_id: "",
                    family_role: "",
                    family_access_source: "",
                },
            },
        );

        res.json({ ok: true, group: await serializeGroup(group) });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/invites/:code/revoke", async (req: Request, res: Response) => {
    try {
        const owner = await User.findById((req.user as IUser)._id).select("subscription_tier subscription_expires_at family_role");
        if (!owner || !isActiveFamilyTier(owner) || owner.family_role === "member") {
            res.status(403).json({ error: "family_required" });
            return;
        }
        const group = await ensureOwnerGroup(owner);
        const invite = group.invites.find((item) => item.code === req.params.code.toUpperCase() && item.status === "active");
        if (!invite) { res.status(404).json({ error: "invite_not_found" }); return; }
        invite.status = "revoked";
        await group.save();
        res.json({ ok: true, group: await serializeGroup(group) });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
