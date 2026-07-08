/**
 * Batch-import popular Vietnamese foods from FatSecret (locale=vi, region=VN)
 * into the local Food + FoodVector collections.
 *
 * Usage:
 *   npm run import:fatsecret-vn
 *
 * Requires FATSECRET_KEY + FATSECRET_SECRET in .env.
 * Free tier: 5,000 req/day.  This script makes ~(queries × 1) search calls.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/database";
import { FatSecretImportService, getFatSecretImportService } from "../services/rag/FatSecretImportService";

// ── Vietnamese food queries to seed the local DB ─────────────────────────────
// Group them so related foods cluster together in the vector space.
const VN_QUERIES: string[] = [
    // ── Phở / bún / miến / hủ tiếu / mì (noodle dishes) ──
    "phở bò",
    "phở gà",
    "phở tái",
    "phở xào",
    "bún bò Huế",
    "bún thịt nướng",
    "bún chả",
    "bún riêu",
    "bún mắm",
    "bún cá",
    "bún mọc",
    "bún ốc",
    "bún đậu mắm tôm",
    "miến gà",
    "miến xào",
    "hủ tiếu",
    "hủ tiếu Nam Vang",
    "mì Quảng",
    "mì xào bò",
    "mì xào giòn",
    "bánh canh",
    "bánh canh cua",
    "cao lầu",
    // ── Cơm & xôi (rice dishes) ──
    "cơm tấm",
    "cơm chiên",
    "cơm chiên dương châu",
    "cơm rang",
    "cơm gà",
    "cơm gà Hội An",
    "cơm cháy",
    "cơm lam",
    "cơm hến",
    "cơm gạo lứt",
    "xôi",
    "xôi gà",
    "xôi xéo",
    "xôi đậu xanh",
    "xôi gấc",
    "xôi lạc",
    // ── Bánh (savory cakes & breads) ──
    "bánh mì",
    "bánh mì thịt",
    "bánh mì trứng",
    "bánh xèo",
    "bánh cuốn",
    "bánh bèo",
    "bánh bột lọc",
    "bánh khọt",
    "bánh giò",
    "bánh chưng",
    "bánh tét",
    "bánh bao",
    "bánh căn",
    "bánh đúc",
    "bánh ướt",
    "bánh hỏi",
    // ── Gỏi / nộm / cuốn (salads & rolls) ──
    "gỏi cuốn",
    "gỏi gà",
    "gỏi đu đủ",
    "gỏi ngó sen",
    "nem cuốn",
    "bò bía",
    "nem nướng",
    "nem lụi",
    "chả giò",
    "nem rán",
    "chả lụa",
    "chả cá",
    // ── Món mặn gia đình (home-style mains) ──
    "thịt kho tàu",
    "thịt kho trứng",
    "thịt heo kho",
    "thịt luộc",
    "thịt gà nướng",
    "gà kho gừng",
    "gà chiên nước mắm",
    "gà luộc",
    "thịt bò xào",
    "bò lúc lắc",
    "bò kho",
    "sườn xào chua ngọt",
    "sườn nướng",
    "cá kho tộ",
    "cá chiên",
    "cá hấp",
    "tôm rang",
    "tôm chiên",
    "mực xào",
    "trứng chiên",
    "trứng luộc",
    "hột vịt lộn",
    "đậu phụ",
    "đậu hũ chiên",
    "đậu hũ sốt cà",
    // ── Canh / súp / lẩu / nướng (soups, hotpot & grill) ──
    "canh chua",
    "canh chua cá",
    "canh khổ qua",
    "canh bí đỏ",
    "canh rau ngót",
    "canh cải",
    "canh mồng tơi",
    "súp",
    "súp cua",
    "lẩu",
    "lẩu thái",
    "lẩu gà lá é",
    "lẩu hải sản",
    "bò nướng lá lốt",
    "bò né",
    // ── Cháo & đồ ăn sáng / vặt (porridge, breakfast & street snacks) ──
    "cháo gà",
    "cháo lòng",
    "cháo sườn",
    "cháo trắng",
    "phá lấu",
    "bột chiên",
    "há cảo",
    "xíu mại",
    "bánh tráng trộn",
    "bánh tráng nướng",
    // ── Vegetables & sides ──
    "rau muống xào tỏi",
    "rau cải xào",
    "cải thìa xào",
    "đậu que xào",
    "giá đỗ xào",
    "dưa chuột",
    "cà chua",
    "dưa cải muối",
    "khoai lang",
    "khoai tây chiên",
    "khoai môn",
    "bắp ngô",
    // ── Fruits ──
    "xoài",
    "chuối",
    "dưa hấu",
    "thanh long",
    "ổi",
    "bưởi",
    "cam",
    "đu đủ",
    "dứa",
    "vải",
    "nhãn",
    "chôm chôm",
    "măng cụt",
    "sầu riêng",
    "mít",
    "bơ",
    // ── Rice & noodle staples ──
    "gạo trắng",
    "gạo lứt",
    "bún tươi",
    "bánh phở",
    "miến",
    "mì tôm",
    // ── Chè / tráng miệng (desserts) ──
    "chè ba màu",
    "chè đậu xanh",
    "chè thái",
    "chè bắp",
    "chè chuối",
    "sữa chua nếp cẩm",
    "bánh flan",
    "rau câu",
    // ── Beverages & dairy ──
    "sữa tươi",
    "sữa chua",
    "sữa đậu nành",
    "nước dừa",
    "nước mía",
    "nước cam",
    "sinh tố bơ",
    "sinh tố xoài",
    "trà sữa trân châu",
    "cà phê sữa đá",
    "cà phê đen",
    // ── Condiments / sauces ──
    "nước mắm",
    "tương hoisin",
    "tương ớt",
    "mắm tôm",
];

const DELAY_MS = 1200; // ~50 req/min — well within free tier 5000/day

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    if (!FatSecretImportService.isAvailable()) {
        console.error("❌  FATSECRET_KEY hoặc FATSECRET_SECRET chưa được set trong .env");
        process.exit(1);
    }

    await connectDB();

    const service = getFatSecretImportService();
    let totalImported = 0;
    let totalSkipped  = 0;
    let totalExcluded = 0;

    console.log(`\n🥗  FatSecret VN Import — ${VN_QUERIES.length} queries\n`);

    for (let i = 0; i < VN_QUERIES.length; i++) {
        const query = VN_QUERIES[i];
        try {
            const result = await service.batchImportQuery(query, 10);
            totalImported += result.imported;
            totalSkipped  += result.skipped;
            totalExcluded += result.excluded;

            console.log(
                `[${i + 1}/${VN_QUERIES.length}] "${query}" → ` +
                `✅ ${result.imported} imported  ⏭ ${result.skipped} skipped` +
                (result.excluded > 0 ? `  🚫 ${result.excluded} junk excluded` : ""),
            );
        } catch (err) {
            console.warn(`[${i + 1}/${VN_QUERIES.length}] "${query}" → ⚠️  ${(err as Error).message}`);
        }

        if (i < VN_QUERIES.length - 1) await sleep(DELAY_MS);
    }

    console.log(`\n✅  Done — ${totalImported} foods imported, ${totalSkipped} skipped (all-zero nutrition or already exists), ${totalExcluded} junk excluded\n`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
