import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { authenticate, optionalAuthenticate } from "../middleware/auth";
import Review from "../models/Review";
import Recipe from "../models/Recipe";
import Store from "../models/Store";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function recalcRating(target_type: string, target_id: mongoose.Types.ObjectId) {
    const agg = await Review.aggregate([
        { $match: { target_type, target_id, is_deleted: false } },
        { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]);
    const avg   = agg[0]?.avg   ?? 0;
    const count = agg[0]?.count ?? 0;

    if (target_type === "recipe") {
        await Recipe.findByIdAndUpdate(target_id, {
            average_rating: Math.round(avg * 10) / 10,
            rating_count: count,
        });
    } else {
        await Store.findByIdAndUpdate(target_id, {
            average_rating: Math.round(avg * 10) / 10,
            rating_count: count,
        });
    }
}

// ── GET /reviews?target_type=recipe&target_id=xxx ─────────────────────────────

router.get("/", optionalAuthenticate, async (req: Request, res: Response) => {
    try {
        const { target_type, target_id, limit = "20", offset = "0" } = req.query as Record<string, string>;
        if (!target_type || !target_id) {
            return res.status(400).json({ error: "target_type and target_id are required" });
        }

        const reviews = await Review.find({
            target_type,
            target_id: new mongoose.Types.ObjectId(target_id),
            is_deleted: false,
        })
            .populate("user_id", "display_name avatar_url")
            .sort({ created_at: -1 })
            .skip(parseInt(offset))
            .limit(Math.min(parseInt(limit), 50));

        const total = await Review.countDocuments({
            target_type,
            target_id: new mongoose.Types.ObjectId(target_id),
            is_deleted: false,
        });

        const userId = (req as any).user?._id?.toString();
        const data = reviews.map((r) => ({
            _id: r._id,
            user: r.user_id,
            rating: r.rating,
            content: r.content,
            images: r.images,
            helpful_count: r.helpful_votes.length,
            is_helpful: userId ? r.helpful_votes.some((v) => v.toString() === userId) : false,
            is_own: userId ? r.user_id._id?.toString() === userId : false,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }));

        res.json({ data, total });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch reviews" });
    }
});

// ── POST /reviews ─────────────────────────────────────────────────────────────

router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { target_type, target_id, rating, content, images } = req.body;

        if (!target_type || !target_id || !rating) {
            return res.status(400).json({ error: "target_type, target_id and rating are required" });
        }
        if (rating < 1 || rating > 5) {
            return res.status(400).json({ error: "rating must be 1–5" });
        }

        const existing = await Review.findOne({
            user_id: user._id,
            target_type,
            target_id: new mongoose.Types.ObjectId(target_id),
        });

        if (existing) {
            // Update existing review
            existing.rating  = rating;
            existing.content = content;
            existing.images  = images ?? existing.images;
            existing.is_deleted = false;
            await existing.save();
            await recalcRating(target_type, new mongoose.Types.ObjectId(target_id));
            return res.json(existing);
        }

        const review = await Review.create({
            target_type,
            target_id: new mongoose.Types.ObjectId(target_id),
            user_id: user._id,
            rating,
            content,
            images: images ?? [],
        });

        await recalcRating(target_type, new mongoose.Types.ObjectId(target_id));
        res.status(201).json(review);
    } catch (err: any) {
        if (err.code === 11000) {
            return res.status(409).json({ error: "You have already reviewed this item" });
        }
        res.status(500).json({ error: "Failed to create review" });
    }
});

// ── PUT /reviews/:id ──────────────────────────────────────────────────────────

router.put("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user   = (req as any).user;
        const review = await Review.findById(req.params.id);
        if (!review || review.is_deleted) return res.status(404).json({ error: "Not found" });

        const isOwner = review.user_id.toString() === user._id.toString();
        const isAdmin = ["admin", "moderator"].includes(user.role);
        if (!isOwner && !isAdmin) return res.status(403).json({ error: "Forbidden" });

        const { rating, content, images } = req.body;
        if (rating !== undefined) review.rating  = rating;
        if (content !== undefined) review.content = content;
        if (images  !== undefined) review.images  = images;
        await review.save();

        await recalcRating(review.target_type, review.target_id as mongoose.Types.ObjectId);
        res.json(review);
    } catch {
        res.status(500).json({ error: "Failed to update review" });
    }
});

// ── DELETE /reviews/:id ───────────────────────────────────────────────────────

router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user   = (req as any).user;
        const review = await Review.findById(req.params.id);
        if (!review || review.is_deleted) return res.status(404).json({ error: "Not found" });

        const isOwner = review.user_id.toString() === user._id.toString();
        const isAdmin = ["admin", "moderator"].includes(user.role);
        if (!isOwner && !isAdmin) return res.status(403).json({ error: "Forbidden" });

        review.is_deleted = true;
        await review.save();

        await recalcRating(review.target_type, review.target_id as mongoose.Types.ObjectId);
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: "Failed to delete review" });
    }
});

// ── POST /reviews/:id/reply — store owner replies (Pro) ──────────────────────

router.post("/:id/reply", authenticate, async (req: Request, res: Response) => {
    try {
        const user   = (req as any).user;
        const review = await Review.findById(req.params.id);
        if (!review || review.is_deleted) return res.status(404).json({ error: "Review not found" });
        if (review.target_type !== "store") return res.status(400).json({ error: "Can only reply to store reviews" });

        const store = await Store.findById(review.target_id);
        if (!store) return res.status(404).json({ error: "Store not found" });

        const isAdmin = ["admin", "moderator"].includes(user.role);
        const isOwner = store.owner_id.toString() === user._id.toString();
        if (!isAdmin && !isOwner) return res.status(403).json({ error: "Forbidden" });

        if (store.subscription_tier !== "pro" && !isAdmin) {
            return res.status(403).json({ error: "pro_required", message: "Phản hồi review yêu cầu Store Pro." });
        }

        const { reply } = req.body;
        if (!reply?.trim()) return res.status(400).json({ error: "reply is required" });

        review.store_reply    = reply.trim();
        review.store_reply_at = new Date();
        await review.save();
        res.json(review);
    } catch {
        res.status(500).json({ error: "Failed to post reply" });
    }
});

// ── POST /reviews/:id/helpful — toggle helpful vote ───────────────────────────

router.post("/:id/helpful", authenticate, async (req: Request, res: Response) => {
    try {
        const user   = (req as any).user;
        const review = await Review.findById(req.params.id);
        if (!review || review.is_deleted) return res.status(404).json({ error: "Not found" });

        const uid  = new mongoose.Types.ObjectId(user._id);
        const idx  = review.helpful_votes.findIndex((v) => v.toString() === uid.toString());
        const voted = idx >= 0;

        if (voted) {
            review.helpful_votes.splice(idx, 1);
        } else {
            review.helpful_votes.push(uid);
        }
        await review.save();

        res.json({ helpful_count: review.helpful_votes.length, is_helpful: !voted });
    } catch {
        res.status(500).json({ error: "Failed to toggle helpful" });
    }
});

export default router;
