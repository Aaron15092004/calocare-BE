/**
 * Renames recipes and meal-plan-referenced USDA foods whose Vietnamese name is
 * still English or a clunky machine-translated USDA survey description
 * (e.g. "Congee, with egg", "Cá và rau củ bao gồm cà rốt, broccoli, và/hoặc
 * rau lá xanh đậm; không có khoai tây") into natural Vietnamese dish names
 * ("Cháo trứng", "Cá hấp rau củ") using the LLM. Display-only fields.
 *
 * Run locally:
 *   npx ts-node src/scripts/fix-recipe-names.ts           # dry-run
 *   npx ts-node src/scripts/fix-recipe-names.ts --apply   # write changes
 */
import "dotenv/config";
import mongoose from "mongoose";
import { z } from "zod";
import Recipe from "../models/Recipe";
import MealPlanItem from "../models/MealPlanItem";
import { getLLMService } from "../services/rag/LLMService";

const APPLY = process.argv.includes("--apply");
const BATCH = 20;

const OutputSchema = z.array(z.object({ id: z.string(), name: z.string().min(2).max(80) }));

function isAsciiOnly(s: string): boolean {
    return /^[\x00-\x7F]*$/.test(s);
}

// USDA survey descriptions translated literally read like ingredient audits
function isClunky(s: string): boolean {
    if (/bao gồm|và\/hoặc|không có khoai tây|bữa ăn đông lạnh|, from |, NFS|không xác định/i.test(s)) return true;
    return s.length > 55 && (s.match(/,/g) || []).length >= 2;
}

function stripFences(raw: string): string {
    return raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
}

// Generic LLM rename pass; calls `apply` for each accepted rename.
async function renameBatch(
    rows: Array<{ id: string; current: string }>,
    apply: (id: string, oldName: string, newName: string) => Promise<void>,
): Promise<number> {
    const llm = getLLMService();
    let renamed = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const list = batch.map((r) => JSON.stringify(r)).join("\n");
        const prompt = `Bạn là biên tập viên ẩm thực Việt Nam. Với mỗi món dưới đây, hãy đặt TÊN MÓN ĂN tiếng Việt tự nhiên, ngắn gọn (tối đa ~40 ký tự) như tên trên thực đơn quán ăn. Giữ đúng bản chất món (nguyên liệu chính, cách chế biến). KHÔNG thêm mô tả, KHÔNG liệt kê nguyên liệu phụ.

Ví dụ:
- "Congee, with egg" → "Cháo trứng"
- "Hải sản, NFS" → "Hải sản hấp"
- "Cá và rau củ bao gồm cà rốt, broccoli, và/hoặc rau lá xanh đậm; không có khoai tây, nước sốt cà chua" → "Cá hấp rau củ sốt cà chua"

Danh sách (mỗi dòng một JSON):
${list}

Trả về DUY NHẤT một mảng JSON: [{"id":"...","name":"..."}] cho đủ ${batch.length} món.`;

        try {
            const res = await llm.generate([{ role: "user", content: prompt }], { maxTokens: 2000, temperature: 0.3 });
            const parsed = OutputSchema.safeParse(JSON.parse(stripFences(res.content)));
            if (!parsed.success) {
                console.warn(`  batch ${i / BATCH + 1}: LLM output không hợp lệ — bỏ qua`);
                continue;
            }
            const nameById = new Map(parsed.data.map((x) => [x.id, x.name.trim()]));
            for (const row of batch) {
                const newName = nameById.get(row.id);
                if (!newName || newName === row.current) continue;
                console.log(`  "${row.current}" → "${newName}"`);
                if (APPLY) await apply(row.id, row.current, newName);
                renamed++;
            }
        } catch (err) {
            console.warn(`  batch ${i / BATCH + 1} lỗi:`, err instanceof Error ? err.message : String(err));
        }
    }
    return renamed;
}

async function main() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error("MONGODB_URI missing");
    await mongoose.connect(uri);
    console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);

    // ── 1. Recipes ──
    const recipes = await Recipe.find({ name_vi: { $exists: true, $ne: "" } })
        .select("name_vi name_en")
        .lean();
    const recipeTargets = recipes.filter((r: any) => isAsciiOnly(r.name_vi) || isClunky(r.name_vi));
    console.log(`\nRecipes: ${recipeTargets.length}/${recipes.length} cần đổi tên\n`);
    const recipeRenamed = await renameBatch(
        recipeTargets.map((r: any) => ({ id: String(r._id), current: r.name_vi })),
        async (id, oldName, newName) => {
            // Preserve the original English name if the EN slot is empty
            if (isAsciiOnly(oldName)) {
                await Recipe.updateOne(
                    { _id: id, $or: [{ name_en: { $exists: false } }, { name_en: "" }] },
                    { $set: { name_en: oldName } },
                );
            }
            await Recipe.updateOne({ _id: id }, { $set: { name_vi: newName } });
        },
    );

    // ── 2. USDA foods referenced by meal plans (display name only) ──
    const usdaIds = await MealPlanItem.distinct("usda_food_id", { usda_food_id: { $ne: null } });
    const db = mongoose.connection.db!;
    const usdaDocs = await db.collection("usdafoods")
        .find({ _id: { $in: usdaIds } })
        .project({ description_vi: 1 })
        .toArray();
    const usdaTargets = usdaDocs.filter(
        (u: any) => u.description_vi && (isAsciiOnly(u.description_vi) || isClunky(u.description_vi)),
    );
    console.log(`\nUSDA foods (được meal plan tham chiếu): ${usdaTargets.length}/${usdaDocs.length} cần đổi tên\n`);
    const usdaRenamed = await renameBatch(
        usdaTargets.map((u: any) => ({ id: String(u._id), current: u.description_vi as string })),
        async (id, _oldName, newName) => {
            await db.collection("usdafoods").updateOne(
                { _id: new mongoose.Types.ObjectId(id) },
                { $set: { description_vi: newName } },
            );
        },
    );

    console.log(`\n${APPLY ? "Đã đổi" : "Sẽ đổi"} ${recipeRenamed} recipe + ${usdaRenamed} USDA.${APPLY ? "" : " Chạy lại với --apply để ghi."}`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
