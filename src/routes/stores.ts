import { Router, Request, Response } from "express";
import { parse as csvParse } from "csv-parse/sync";
import { authenticate, optionalAuthenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roleCheck";
import { IUser } from "../models/User";
import Store from "../models/Store";
import Review from "../models/Review";
import PaymentTransaction from "../models/PaymentTransaction";

const router = Router();

const STORE_PRO_PRICE        = 49000;
const STORE_MENU_LIMIT_BASIC = 20;
const STORE_LIMIT_BASIC      = 1; // basic owners may have only 1 store

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOwnerOrAdmin(user: IUser, ownerId: unknown): boolean {
    const adminRoles = ["admin", "moderator"];
    if (adminRoles.includes((user as any).role)) return true;
    return String(ownerId) === String((user as any)._id);
}

function ownerStoreOrFail(store: InstanceType<typeof Store> | null, user: IUser, res: Response): boolean {
    if (!store) { res.status(404).json({ error: "Store not found" }); return false; }
    if (!isOwnerOrAdmin(user, store.owner_id)) { res.status(403).json({ error: "Forbidden" }); return false; }
    return true;
}

function normalizeText(value: string): string {
    return value.toLowerCase();
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const toRad = (deg: number) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getPriceRange(store: any): { min: number; max: number } | null {
    const prices = (store.menu_items ?? [])
        .map((item: any) => Number(item.price))
        .filter((value: number) => Number.isFinite(value) && value > 0);
    if (!prices.length) return null;
    return { min: Math.min(...prices), max: Math.max(...prices) };
}

function scoreStoreForUser(store: any, user?: IUser): { recommendation_score: number; match_reasons: string[] } {
    const prefs = (user?.preferences ?? {}) as Record<string, unknown>;
    const goal = String(prefs.goal ?? "");
    const dietaryPreference = String(prefs.dietary_preference ?? "");
    const allergies = Array.isArray(prefs.allergies) ? prefs.allergies.map((v) => String(v).toLowerCase()) : [];
    const cuisines = Array.isArray(prefs.cuisine_preferences) ? prefs.cuisine_preferences.map((v) => String(v).toLowerCase()) : [];
    const goals = (user?.daily_nutrition_goals ?? {}) as Record<string, unknown>;
    const calorieGoal = Number(goals.calories ?? 0);

    const haystack = normalizeText([
        store.name,
        store.description,
        store.category,
        ...(store.menu_items ?? []).map((item: any) => `${item.name_vi ?? ""} ${item.name_en ?? ""} ${item.description ?? ""}`),
    ].filter(Boolean).join(" "));

    let score = 0;
    const reasons: string[] = [];

    const addReason = (reason: string, amount: number) => {
        score += amount;
        if (!reasons.includes(reason)) reasons.push(reason);
    };

    if (store.is_verified) addReason("Da xac minh dinh duong", 1);
    if (store.subscription_tier === "pro") addReason("Menu duoc cap nhat day du hon", 1);

    const lightKeywords = ["salad", "healthy", "eat clean", "rau", "uc ga", "grill", "granola", "smoothie bowl"];
    const proteinKeywords = ["protein", "bo", "ga", "ca hoi", "steak", "trung", "sua chua greek", "uc ga"];
    const veganKeywords = ["vegan", "chay", "plant-based", "thuần chay"];
    const ketoKeywords = ["keto", "low carb", "it duong", "it tinh bot"];

    if (goal === "weight_loss" || calorieGoal > 0 && calorieGoal <= 1800) {
        if (lightKeywords.some((kw) => haystack.includes(kw))) addReason("Hop muc tieu giam can", 4);
    }

    if (goal === "muscle_gain" || calorieGoal > 2200) {
        if (proteinKeywords.some((kw) => haystack.includes(kw))) addReason("Co mon giau protein", 4);
    }

    if (dietaryPreference) {
        if (dietaryPreference.includes("vegan") || dietaryPreference.includes("vegetarian")) {
            if (veganKeywords.some((kw) => haystack.includes(kw))) addReason("Phu hop che do an chay", 4);
        }
        if (dietaryPreference.includes("keto") || dietaryPreference.includes("low_carb")) {
            if (ketoKeywords.some((kw) => haystack.includes(kw))) addReason("Co lua chon it carb", 3);
        }
    }

    for (const cuisine of cuisines) {
        if (cuisine && haystack.includes(cuisine)) {
            addReason(`Co mon hop so thich ${cuisine}`, 2);
            break;
        }
    }

    const allergenKeywords: Record<string, string[]> = {
        milk: ["milk", "cheese", "sua"],
        dairy: ["milk", "cheese", "sua"],
        egg: ["egg", "trung"],
        peanut: ["peanut", "lac", "dau phong"],
        nuts: ["hat", "almond", "cashew", "walnut"],
        shellfish: ["tom", "cua", "shellfish"],
        seafood: ["hai san", "tom", "ca", "muc"],
        soy: ["soy", "dau nanh", "tofu", "tau hu"],
        gluten: ["mi", "bread", "banh mi", "pasta"],
    };

    const allergenMentioned = allergies.some((allergy) =>
        (allergenKeywords[allergy] ?? []).some((kw) => haystack.includes(kw)),
    );
    if (!allergenMentioned && allergies.length > 0) addReason("It dau hieu xung dot voi di ung da khai bao", 2);

    return { recommendation_score: score, match_reasons: reasons.slice(0, 3) };
}

function decorateStore(store: any, user?: IUser, distance_km?: number) {
    const plain = typeof store.toObject === "function" ? store.toObject() : store;
    const { recommendation_score, match_reasons } = scoreStoreForUser(plain, user);
    return {
        ...plain,
        recommendation_score,
        match_reasons,
        price_range: getPriceRange(plain),
        ...(distance_km !== undefined ? { distance_km: Number(distance_km.toFixed(2)) } : {}),
    };
}

// ── GET /api/stores — public list ─────────────────────────────────────────────

router.get("/", optionalAuthenticate, async (req: Request, res: Response) => {
    try {
        const { q, category, city, limit = 50, offset = 0 } = req.query;
        const filter: Record<string, unknown> = { is_active: true };

        if (q) {
            filter.$or = [
                { name: { $regex: q as string, $options: "i" } },
                { description: { $regex: q as string, $options: "i" } },
            ];
        }
        if (category) filter.category = category;
        if (city) filter.city = { $regex: city as string, $options: "i" };

        const stores = await Store.find(filter)
            .sort({ subscription_tier: -1, views_count: -1 })
            .limit(Number(limit))
            .skip(Number(offset));

        const total = await Store.countDocuments(filter);
        const decorated = stores
            .map((store) => decorateStore(store, req.user as IUser | undefined))
            .sort((a, b) =>
                (b.recommendation_score - a.recommendation_score)
                || ((b.subscription_tier === "pro" ? 1 : 0) - (a.subscription_tier === "pro" ? 1 : 0))
                || ((b.views_count ?? 0) - (a.views_count ?? 0)),
            );
        res.json({ data: decorated, total });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── GET /api/stores/nearby — public nearby list with optional personalization ──

router.get("/nearby", optionalAuthenticate, async (req: Request, res: Response) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const radiusKm = Math.min(Number(req.query.radius ?? 5), 30);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            res.status(400).json({ error: "lat and lng are required" });
            return;
        }

        const stores = await Store.find({ is_active: true });
        const nearby = stores
            .filter((store: any) => store.location?.lat != null && store.location?.lng != null)
            .map((store: any) => ({
                store,
                distance_km: haversineKm(lat, lng, store.location.lat, store.location.lng),
            }))
            .filter((entry) => entry.distance_km <= radiusKm)
            .map((entry) => decorateStore(entry.store, req.user as IUser | undefined, entry.distance_km))
            .sort((a, b) =>
                (b.recommendation_score - a.recommendation_score)
                || ((a.distance_km ?? 999) - (b.distance_km ?? 999))
                || ((b.subscription_tier === "pro" ? 1 : 0) - (a.subscription_tier === "pro" ? 1 : 0)),
            );

        res.json(nearby);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── GET /api/stores/mine ──────────────────────────────────────────────────────

router.get("/mine", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const stores = await Store.find({ owner_id: (user as any)._id }).sort({ created_at: -1 });
        res.json({ data: stores });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── GET /api/stores/pending — admin ──────────────────────────────────────────

router.get("/pending", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const stores = await Store.find({ is_active: false }).sort({ created_at: -1 });
        res.json({ data: stores, total: stores.length });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── POST /api/stores/:id/approve ──────────────────────────────────────────────

router.post("/:id/approve", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await Store.findByIdAndUpdate(
            req.params.id,
            { is_active: true, $unset: { reject_reason: "" } },
            { new: true },
        );
        if (!updated) { res.status(404).json({ error: "Store not found" }); return; }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── POST /api/stores/:id/reject ───────────────────────────────────────────────

router.post("/:id/reject", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const { reason } = req.body;
        const updated = await Store.findByIdAndUpdate(
            req.params.id,
            { is_active: false, reject_reason: reason || "Không đủ điều kiện" },
            { new: true },
        );
        if (!updated) { res.status(404).json({ error: "Store not found" }); return; }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── GET /api/stores/:id — detail + menu ──────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
    try {
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        Store.updateOne({ _id: store._id }, { $inc: { views_count: 1 } }).exec();
        res.json(store);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── POST /api/stores — register (authenticated) ───────────────────────────────

router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const { name, description, address, city, phone, website, location, category, images, google_place_id, google_maps_url } = req.body;

        if (!name || !address) {
            res.status(400).json({ error: "name and address are required" });
            return;
        }

        // Basic store owners are limited to 1 store
        const adminRoles = ["admin", "moderator"];
        if (!adminRoles.includes((user as any).role)) {
            const existingCount = await Store.countDocuments({ owner_id: (user as any)._id });
            const isPro = (user as any).role === "store_owner"
                && await Store.findOne({ owner_id: (user as any)._id, subscription_tier: "pro" });
            if (!isPro && existingCount >= STORE_LIMIT_BASIC) {
                res.status(403).json({
                    error: "store_limit_reached",
                    message: "Gói Basic chỉ cho phép 1 quán. Nâng cấp Store Pro để thêm nhiều quán.",
                });
                return;
            }
        }

        const store = await Store.create({
            owner_id: (user as any)._id,
            name, description, address, city, phone, website, location, category,
            images: images || [],
            google_place_id, google_maps_url,
            subscription_tier: "basic",
            is_verified: false,
            is_active: false,
        });

        res.status(201).json(store);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── PUT /api/stores/:id — update (triggers re-approval) ──────────────────────

router.put("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!ownerStoreOrFail(store, user, res)) return;

        const {
            name, description, address, city, phone, website,
            location, category, images, google_place_id, google_maps_url,
        } = req.body;

        const updateData: Record<string, unknown> = {};
        if (name)                         updateData.name             = name;
        if (description !== undefined)    updateData.description      = description;
        if (address)                      updateData.address          = address;
        if (city !== undefined)           updateData.city             = city;
        if (phone !== undefined)          updateData.phone            = phone;
        if (website !== undefined)        updateData.website          = website;
        if (location !== undefined)       updateData.location         = location;
        if (category)                     updateData.category         = category;
        if (images)                       updateData.images           = images;
        if (google_place_id !== undefined) updateData.google_place_id = google_place_id;
        if (google_maps_url !== undefined) updateData.google_maps_url = google_maps_url;

        // Non-admin updates require re-approval
        const isAdmin = ["admin", "moderator"].includes((user as any).role);
        if (!isAdmin) {
            updateData.is_active     = false;
            updateData.reject_reason = undefined;
        }

        const updated = await Store.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── DELETE /api/stores/:id ───────────────────────────────────────────────────

router.delete("/:id", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!ownerStoreOrFail(store, user, res)) return;
        await Store.findByIdAndUpdate(req.params.id, { is_active: false });
        res.json({ message: "Store deactivated" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── Menu items ────────────────────────────────────────────────────────────────

router.post("/:id/menu", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (String(store.owner_id) !== String((user as any)._id)) {
            res.status(403).json({ error: "Forbidden" }); return;
        }

        if (store.subscription_tier === "basic" && store.menu_items.length >= STORE_MENU_LIMIT_BASIC) {
            res.status(403).json({
                error: "menu_limit_reached",
                message: `Gói Basic tối đa ${STORE_MENU_LIMIT_BASIC} món. Nâng cấp Store Pro để thêm không giới hạn.`,
                limit: STORE_MENU_LIMIT_BASIC,
            });
            return;
        }

        const { name_vi, name_en, price, description, image_url, energy_kcal, protein, lipid, glucid, fiber } = req.body;
        store.menu_items.push({
            name_vi, name_en, price, description, image_url,
            energy_kcal, protein, lipid, glucid, fiber,
            is_available: true,
        });
        await store.save();
        res.json(store);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.put("/:id/menu/:itemId", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (String(store.owner_id) !== String((user as any)._id)) {
            res.status(403).json({ error: "Forbidden" }); return;
        }
        const item = (store.menu_items as any).id(req.params.itemId);
        if (!item) { res.status(404).json({ error: "Menu item not found" }); return; }
        Object.assign(item, req.body);
        await store.save();
        res.json(store);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.delete("/:id/menu/:itemId", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (String(store.owner_id) !== String((user as any)._id)) {
            res.status(403).json({ error: "Forbidden" }); return;
        }
        store.menu_items = store.menu_items.filter(
            (item) => (item as any)._id?.toString() !== req.params.itemId,
        ) as any;
        await store.save();
        res.json({ message: "Menu item removed" });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── POST /api/stores/:id/menu/bulk — bulk CSV upload (Pro) ───────────────────

router.post("/:id/menu/bulk", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (String(store.owner_id) !== String((user as any)._id)) {
            res.status(403).json({ error: "Forbidden" }); return;
        }
        if (store.subscription_tier !== "pro") {
            res.status(403).json({ error: "pro_required", message: "Bulk upload yêu cầu Store Pro." });
            return;
        }

        const { csv_data } = req.body; // raw CSV string
        if (!csv_data) { res.status(400).json({ error: "csv_data is required" }); return; }

        const rows = csvParse(csv_data, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
        }) as Record<string, string>[];

        let added = 0;
        for (const row of rows) {
            const name_vi = row["name_vi"] || row["Tên món"] || row["name"];
            if (!name_vi) continue;
            store.menu_items.push({
                name_vi,
                name_en: row["name_en"] || row["English name"] || undefined,
                price: row["price"] ? Number(row["price"]) : undefined,
                description: row["description"] || undefined,
                energy_kcal: row["energy_kcal"] || row["Calories"] ? Number(row["energy_kcal"] || row["Calories"]) : undefined,
                protein: row["protein"] ? Number(row["protein"]) : undefined,
                lipid:   row["lipid"]   ? Number(row["lipid"])   : undefined,
                glucid:  row["glucid"]  ? Number(row["glucid"])  : undefined,
                fiber:   row["fiber"]   ? Number(row["fiber"])   : undefined,
                is_available: true,
            });
            added++;
        }

        await store.save();
        res.json({ added, total: store.menu_items.length, store });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── POST /api/stores/:id/menu/:itemId/ai-nutrition (Pro) ─────────────────────

router.post("/:id/menu/:itemId/ai-nutrition", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (String(store.owner_id) !== String((user as any)._id)) {
            res.status(403).json({ error: "Forbidden" }); return;
        }
        if (store.subscription_tier !== "pro") {
            res.status(403).json({ error: "pro_required", message: "AI Nutrition yêu cầu Store Pro." });
            return;
        }

        const item = (store.menu_items as any).id(req.params.itemId);
        if (!item) { res.status(404).json({ error: "Menu item not found" }); return; }

        // Estimate nutrition via Anthropic Claude API if available, else use heuristic
        let estimate: { energy_kcal: number; protein: number; lipid: number; glucid: number; fiber: number };

        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
            const axios = (await import("axios")).default;
            const prompt = `Estimate the nutritional values per serving for this Vietnamese food item: "${item.name_vi}"${item.description ? ` (${item.description})` : ""}.
Return ONLY a JSON object with these exact fields (numbers only, no units):
{"energy_kcal": number, "protein": number, "lipid": number, "glucid": number, "fiber": number}`;

            const resp = await axios.post(
                "https://api.anthropic.com/v1/messages",
                {
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 150,
                    messages: [{ role: "user", content: prompt }],
                },
                {
                    headers: {
                        "x-api-key": anthropicKey,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                },
            );

            const text = resp.data.content[0]?.text || "";
            const match = text.match(/\{[\s\S]*\}/);
            estimate = match ? JSON.parse(match[0]) : buildHeuristicEstimate(item.name_vi);
        } else {
            estimate = buildHeuristicEstimate(item.name_vi);
        }

        Object.assign(item, estimate, { nutrition_verified: false });
        await store.save();
        res.json({ estimate, item });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

function buildHeuristicEstimate(name: string): { energy_kcal: number; protein: number; lipid: number; glucid: number; fiber: number } {
    const n = name.toLowerCase();
    // Simple category heuristics
    if (n.includes("cơm") || n.includes("rice"))            return { energy_kcal: 380, protein: 12, lipid: 8,  glucid: 58, fiber: 2 };
    if (n.includes("phở") || n.includes("bún"))             return { energy_kcal: 420, protein: 18, lipid: 10, glucid: 55, fiber: 2 };
    if (n.includes("bánh mì"))                              return { energy_kcal: 350, protein: 15, lipid: 12, glucid: 45, fiber: 3 };
    if (n.includes("salad") || n.includes("rau"))           return { energy_kcal: 120, protein: 3,  lipid: 5,  glucid: 14, fiber: 4 };
    if (n.includes("cà phê") || n.includes("coffee"))       return { energy_kcal: 60,  protein: 1,  lipid: 2,  glucid: 8,  fiber: 0 };
    if (n.includes("sinh tố") || n.includes("smoothie"))    return { energy_kcal: 180, protein: 3,  lipid: 2,  glucid: 38, fiber: 3 };
    if (n.includes("trà") || n.includes("tea"))             return { energy_kcal: 45,  protein: 0,  lipid: 0,  glucid: 11, fiber: 0 };
    if (n.includes("gà") || n.includes("chicken"))          return { energy_kcal: 300, protein: 28, lipid: 14, glucid: 10, fiber: 1 };
    if (n.includes("bò") || n.includes("beef"))             return { energy_kcal: 350, protein: 30, lipid: 18, glucid: 8,  fiber: 1 };
    if (n.includes("hải sản") || n.includes("tôm") || n.includes("cá")) return { energy_kcal: 250, protein: 24, lipid: 8, glucid: 12, fiber: 1 };
    if (n.includes("bánh") || n.includes("cake"))           return { energy_kcal: 320, protein: 5,  lipid: 12, glucid: 48, fiber: 1 };
    // Default
    return { energy_kcal: 280, protein: 12, lipid: 10, glucid: 35, fiber: 2 };
}

// ── GET /api/stores/:id/analytics ────────────────────────────────────────────

router.get("/:id/analytics", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!ownerStoreOrFail(store, user, res)) return;

        const isPro = store!.subscription_tier === "pro";

        const basic = {
            tier:             store!.subscription_tier,
            total_views:      store!.views_count,
            average_rating:   store!.average_rating,
            rating_count:     store!.rating_count,
            total_menu_items: store!.menu_items.length,
            is_active:        store!.is_active,
            is_verified:      store!.is_verified,
        };

        if (!isPro) { res.json(basic); return; }

        // Pro: rating distribution
        const reviews = await Review.find({ target_type: "store", target_id: store!._id, is_deleted: false });
        const ratingDist: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
        reviews.forEach((r) => { ratingDist[String(r.rating)] = (ratingDist[String(r.rating)] || 0) + 1; });

        // Simulated daily views over last 30 days (proportionally distributed)
        const totalViews = store!.views_count;
        const dailyViews: { date: string; views: number }[] = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            dailyViews.push({
                date:  d.toISOString().split("T")[0],
                views: Math.max(0, Math.round((totalViews / 30) * (0.4 + Math.random() * 1.2))),
            });
        }

        // Simulated check-in heatmap [day 0-6, hour 0-23]
        const heatmap: { day: number; hour: number; count: number }[] = [];
        for (let d = 0; d < 7; d++) {
            for (let h = 0; h < 24; h++) {
                const isPeak = (h >= 11 && h <= 14) || (h >= 18 && h <= 21);
                const count  = isPeak
                    ? Math.round(Math.random() * 10 + 2)
                    : Math.round(Math.random() * 3);
                if (count > 0) heatmap.push({ day: d, hour: h, count });
            }
        }

        res.json({ ...basic, rating_distribution: ratingDist, daily_views: dailyViews, checkin_heatmap: heatmap });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── GET /api/stores/:id/analytics/export — CSV (Pro) ─────────────────────────

router.get("/:id/analytics/export", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!ownerStoreOrFail(store, user, res)) return;
        if (store!.subscription_tier !== "pro") {
            res.status(403).json({ error: "pro_required", message: "Export CSV yêu cầu Store Pro." });
            return;
        }

        const totalViews = store!.views_count;
        const rows: string[] = ["Ngày,Lượt xem"];
        for (let i = 29; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split("T")[0];
            const views   = Math.max(0, Math.round((totalViews / 30) * (0.4 + Math.random() * 1.2)));
            rows.push(`${dateStr},${views}`);
        }

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="analytics-${store!._id}.csv"`);
        res.send("\uFEFF" + rows.join("\n")); // BOM for Excel
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── Store Pro upgrade ─────────────────────────────────────────────────────────

router.post("/:id/upgrade", authenticate, async (req: Request, res: Response) => {
    try {
        const user  = req.user as IUser;
        const store = await Store.findById(req.params.id);
        if (!store) { res.status(404).json({ error: "Store not found" }); return; }
        if (String(store.owner_id) !== String((user as any)._id)) {
            res.status(403).json({ error: "Forbidden" }); return;
        }

        const { duration_months = 1, payment_method } = req.body;
        const amount = STORE_PRO_PRICE * duration_months;

        const tx = await PaymentTransaction.create({
            user_id:        (user as any)._id,
            plan_type:      "store_pro",
            target_type:    "store",
            store_id:       store._id,
            duration_months,
            amount,
            final_amount:   amount,
            status:         "pending",
            payment_method: payment_method || undefined,
        });

        const ref = `STORE${String(tx._id).slice(-8).toUpperCase()}`;
        res.status(201).json({
            transaction_id: tx._id,
            store_id:       store._id,
            amount,
            final_amount:   amount,
            status:         "pending",
            payment_instructions: {
                method:  payment_method || "bank_transfer",
                amount:  amount.toLocaleString("vi-VN"),
                note:    ref,
                message: `Chuyển ${amount.toLocaleString("vi-VN")}₫ với nội dung: ${ref}`,
            },
        });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/:id/confirm-upgrade", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const { tx_id } = req.body;
        const tx = await PaymentTransaction.findById(tx_id);
        if (!tx || tx.plan_type !== "store_pro" || tx.target_type !== "store") {
            res.status(404).json({ error: "Transaction not found" }); return;
        }
        tx.status      = "completed";
        tx.payment_ref = req.body.payment_ref || undefined;
        await tx.save();

        const now   = new Date();
        const store = await Store.findById(tx.store_id);
        if (store) {
            const base    = store.subscription_expires_at && store.subscription_expires_at > now
                ? store.subscription_expires_at : now;
            const expiry  = new Date(base);
            expiry.setMonth(expiry.getMonth() + tx.duration_months);
            store.subscription_tier       = "pro";
            store.subscription_expires_at = expiry;
            await store.save();
        }
        res.json({ message: "Store Pro activated", store });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.post("/:id/verify", authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
        const updated = await Store.findByIdAndUpdate(
            req.params.id,
            { is_verified: true },
            { new: true },
        );
        if (!updated) { res.status(404).json({ error: "Store not found" }); return; }
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
