/**
 * Seeds the community meal-plan catalog by running the real AI generator under
 * a "CaloVie" system account. Plans are created with is_public:true,
 * is_approved:false — review and approve each one in the admin UI before it
 * appears in the community feed (that review IS the QA gate).
 *
 * Run LOCALLY against the target DB (never wire into Render start):
 *   npx ts-node src/scripts/seedCommunityPlans.ts             # full matrix (~17 plans)
 *   npx ts-node src/scripts/seedCommunityPlans.ts --only 3    # first N specs (smoke test)
 *
 * Requires: MONGODB_URI, GROQ_API_KEY (+ GEMINI/VOYAGE keys for fallback/search),
 * UNSPLASH_ACCESS_KEY for images. Cost: roughly $0.02 per 7-day plan.
 */
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User";
import MealPlan from "../models/MealPlan";
import { getMealPlanGeneratorService, GoalType, MealsPerDay, CookingStyle } from "../services/rag/MealPlanGeneratorService";

const SYSTEM_EMAIL = "system@calovie.app";

interface SeedSpec {
    title: string;
    description: string;
    tags: string[];
    duration_days: 7 | 21;
    goal: GoalType;
    meals_per_day: MealsPerDay;
    cooking_style?: CookingStyle;
    dietary_preference?: string;
    notes?: string;
}

const SPECS: SeedSpec[] = [
    {
        title: "Giảm cân 7 ngày — cơm nhà dễ nấu",
        description: "Thực đơn giảm cân với các món cơm nhà quen thuộc, nguyên liệu dễ tìm, ai cũng nấu được.",
        tags: ["giảm cân", "cơm nhà", "dễ nấu"],
        duration_days: 7, goal: "weight_loss", meals_per_day: 3,
    },
    {
        title: "Giảm cân 7 ngày — chay thanh đạm",
        description: "Một tuần ăn chay trứng sữa nhẹ bụng, đủ chất, phù hợp người muốn giảm cân bền vững.",
        tags: ["giảm cân", "ăn chay", "thanh đạm"],
        duration_days: 7, goal: "weight_loss", meals_per_day: 3, dietary_preference: "vegetarian",
    },
    {
        title: "Giảm cân low-carb 7 ngày",
        description: "Hạn chế tinh bột, tăng rau xanh và protein — giảm mỡ nhanh mà không đói.",
        tags: ["giảm cân", "low-carb"],
        duration_days: 7, goal: "weight_loss", meals_per_day: 3,
        notes: "Chế độ low-carb: hạn chế cơm/bún/bánh mì, ưu tiên rau xanh, protein nạc và chất béo tốt",
    },
    {
        title: "Giảm cân 7 ngày — 5 bữa nhỏ",
        description: "Chia nhỏ 5 bữa mỗi ngày để không bao giờ quá đói — phù hợp người hay thèm ăn vặt.",
        tags: ["giảm cân", "5 bữa", "ăn vặt lành mạnh"],
        duration_days: 7, goal: "weight_loss", meals_per_day: 5,
    },
    {
        title: "Giảm mỡ giữ cơ 7 ngày",
        description: "Protein cao trong khi calo vừa phải — giữ cơ bắp khi siết mỡ, hợp người tập gym.",
        tags: ["giảm mỡ", "giữ cơ", "gym"],
        duration_days: 7, goal: "weight_loss", meals_per_day: 4,
        notes: "Ưu tiên protein cao ở mọi bữa (thịt nạc, cá, trứng, sữa chua Hy Lạp)",
    },
    {
        title: "Giảm cân 7 ngày — hải sản nhẹ bụng",
        description: "Cá, tôm, mực thay thịt đỏ — ít calo, giàu omega-3, đổi vị cho tuần giảm cân.",
        tags: ["giảm cân", "hải sản"],
        duration_days: 7, goal: "weight_loss", meals_per_day: 3,
        notes: "Ưu tiên hải sản (cá, tôm, mực) làm nguồn đạm chính, hạn chế thịt đỏ",
    },
    {
        title: "Tăng cơ 7 ngày — giàu protein",
        description: "Calo dư nhẹ và protein dày đặc cho người tập luyện muốn tăng cơ.",
        tags: ["tăng cơ", "protein", "gym"],
        duration_days: 7, goal: "muscle_gain", meals_per_day: 5,
    },
    {
        title: "Tăng cân lành mạnh 7 ngày",
        description: "Tăng cân từ thực phẩm sạch, không đồ chiên rán — dành cho người gầy khó hấp thu.",
        tags: ["tăng cân", "lành mạnh"],
        duration_days: 7, goal: "muscle_gain", meals_per_day: 4,
    },
    {
        title: "Tăng cơ chay 7 ngày",
        description: "Đậu phụ, tempeh, trứng và sữa — chứng minh ăn chay vẫn đủ đạm để tăng cơ.",
        tags: ["tăng cơ", "ăn chay"],
        duration_days: 7, goal: "muscle_gain", meals_per_day: 4, dietary_preference: "vegetarian",
    },
    {
        title: "Bulking sạch 7 ngày",
        description: "Calo cao từ nguồn sạch: cơm, thịt nạc, cá hồi, bơ, hạt — tăng khối lượng không tăng mỡ xấu.",
        tags: ["bulking", "gym", "protein"],
        duration_days: 7, goal: "muscle_gain", meals_per_day: 5,
        notes: "Ưu tiên protein cao và carb phức hợp, tránh đồ chiên rán nhiều dầu mỡ",
    },
    {
        title: "Ăn cân bằng 7 ngày — món Việt truyền thống",
        description: "Cơm, canh, món mặn chuẩn bữa cơm Việt — cân bằng dinh dưỡng để duy trì cân nặng.",
        tags: ["duy trì", "món Việt", "truyền thống"],
        duration_days: 7, goal: "maintenance", meals_per_day: 3,
    },
    {
        title: "Duy trì cân nặng 7 ngày — chay",
        description: "Một tuần chay trứng sữa cân bằng cho người muốn ăn nhẹ nhàng mà vẫn đủ năng lượng.",
        tags: ["duy trì", "ăn chay"],
        duration_days: 7, goal: "maintenance", meals_per_day: 3, dietary_preference: "vegetarian",
    },
    {
        title: "Thuần chay 7 ngày",
        description: "Hoàn toàn từ thực vật — đậu, nấm, rau củ và ngũ cốc, đủ chất cho cả tuần.",
        tags: ["thuần chay", "vegan"],
        duration_days: 7, goal: "maintenance", meals_per_day: 3, dietary_preference: "vegan",
    },
    {
        title: "Eat clean 7 ngày",
        description: "Thực phẩm nguyên bản, ít chế biến, không đường tinh luyện — làm mới cơ thể trong 1 tuần.",
        tags: ["eat clean", "duy trì"],
        duration_days: 7, goal: "maintenance", meals_per_day: 4,
        notes: "Eat clean: thực phẩm nguyên bản ít qua chế biến, không đường tinh luyện, không đồ chiên",
    },
    {
        title: "7 ngày nấu 1 lần, ăn cả ngày",
        description: "Thiết kế cho người bận rộn: nấu 1 lần chia nhiều bữa, ít món lắt nhắt.",
        tags: ["bận rộn", "meal prep", "duy trì"],
        duration_days: 7, goal: "maintenance", meals_per_day: 3, cooking_style: "batch",
    },
    // Flagships — 21 ngày
    {
        title: "Hành trình giảm cân 21 ngày",
        description: "Lộ trình 3 tuần đầy đủ: đa dạng món Việt, calo thâm hụt an toàn, đổi món mỗi ngày.",
        tags: ["giảm cân", "21 ngày", "lộ trình"],
        duration_days: 21, goal: "weight_loss", meals_per_day: 4,
    },
    {
        title: "Tăng cơ 21 ngày toàn diện",
        description: "3 tuần ăn theo giáo án tăng cơ: protein cao, 5 bữa/ngày, xoay vòng nguồn đạm.",
        tags: ["tăng cơ", "21 ngày", "gym"],
        duration_days: 21, goal: "muscle_gain", meals_per_day: 5,
    },
];

async function getSystemUserId(): Promise<string> {
    let user = await User.findOne({ email: SYSTEM_EMAIL });
    if (!user) {
        // No password → account can never log in; it only owns the seed plans
        user = await User.create({
            email: SYSTEM_EMAIL,
            display_name: "CaloVie",
        });
        console.log(`Created system user ${SYSTEM_EMAIL}`);
    }
    return (user._id as { toString(): string }).toString();
}

async function main() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error("MONGODB_URI missing");
    await mongoose.connect(uri);

    const onlyArgIdx = process.argv.indexOf("--only");
    const limit = onlyArgIdx >= 0 ? Number(process.argv[onlyArgIdx + 1]) || 1 : SPECS.length;
    const specs = SPECS.slice(0, limit);

    const userId = await getSystemUserId();
    const generator = getMealPlanGeneratorService();
    const results: Array<{ title: string; ok: boolean; planId?: string; error?: string }> = [];

    for (const [index, spec] of specs.entries()) {
        // Skip specs already seeded (idempotent re-runs)
        const existing = await MealPlan.findOne({ title: spec.title, creator_id: userId }).lean();
        if (existing) {
            console.log(`[${index + 1}/${specs.length}] SKIP (exists): ${spec.title}`);
            results.push({ title: spec.title, ok: true, planId: String(existing._id) });
            continue;
        }

        console.log(`\n[${index + 1}/${specs.length}] Generating: ${spec.title} (${spec.duration_days}d, ${spec.goal}, ${spec.meals_per_day} bữa)`);
        try {
            const { planId } = await generator.generate(
                {
                    userId,
                    duration_days: spec.duration_days,
                    goal: spec.goal,
                    meals_per_day: spec.meals_per_day,
                    cooking_style: spec.cooking_style,
                    preferences: {
                        dietary_preference: spec.dietary_preference,
                        cuisine_preferences: ["vietnamese"],
                        notes: spec.notes,
                    },
                },
                (event, data) => {
                    if (event === "day") {
                        const d = data as { day_number: number };
                        process.stdout.write(`  ngày ${d.day_number} ✓`);
                    }
                    if (event === "done") process.stdout.write("\n");
                },
            );

            await MealPlan.findByIdAndUpdate(planId, {
                title: spec.title,
                description: spec.description,
                tags: spec.tags,
                is_public: true,
                is_approved: false, // approve manually in admin UI after review
            });
            console.log(`  → OK ${planId} (chờ duyệt trong admin)`);
            results.push({ title: spec.title, ok: true, planId });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`  → FAILED: ${message}`);
            results.push({ title: spec.title, ok: false, error: message });
        }
    }

    const ok = results.filter((r) => r.ok).length;
    console.log(`\nDone: ${ok}/${results.length} plans. Duyệt tại admin → Meal Plans (pending).`);
    // Fire-and-forget image fills / enrichment queueing are still running —
    // give them a grace window before tearing the connection down.
    console.log("Chờ 45s cho background image-fill hoàn tất...");
    await new Promise((resolve) => setTimeout(resolve, 45_000));
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
