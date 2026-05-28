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
    // Staple dishes
    "phở bò",
    "phở gà",
    "bún bò Huế",
    "bún thịt nướng",
    "bún chả",
    "bún riêu",
    "cơm tấm",
    "cơm chiên",
    "bánh mì",
    "xôi",
    // Soups & hotpot
    "canh chua",
    "lẩu",
    "súp",
    // Snacks / street food
    "bánh cuốn",
    "bánh xèo",
    "chả giò",
    "nem rán",
    "bánh bao",
    "bánh flan",
    // Proteins
    "thịt gà nướng",
    "thịt heo kho",
    "thịt bò xào",
    "cá kho tộ",
    "tôm rang",
    "trứng chiên",
    "đậu phụ",
    // Vegetables & sides
    "rau muống xào",
    "rau cải xào",
    "dưa chuột",
    "cà chua",
    "khoai lang",
    "bắp ngô",
    // Fruits
    "xoài",
    "chuối",
    "dưa hấu",
    "thanh long",
    "ổi",
    "bưởi",
    // Rice & noodles
    "gạo trắng",
    "bún tươi",
    "miến",
    "mì tôm",
    // Beverages & dairy
    "sữa tươi",
    "sữa chua",
    "nước dừa",
    "trà sữa",
    // Condiments / sauces
    "nước mắm",
    "tương hoisin",
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

    console.log(`\n🥗  FatSecret VN Import — ${VN_QUERIES.length} queries\n`);

    for (let i = 0; i < VN_QUERIES.length; i++) {
        const query = VN_QUERIES[i];
        try {
            const result = await service.batchImportQuery(query, 10);
            totalImported += result.imported;
            totalSkipped  += result.skipped;

            console.log(
                `[${i + 1}/${VN_QUERIES.length}] "${query}" → ` +
                `✅ ${result.imported} imported  ⏭ ${result.skipped} skipped`,
            );
        } catch (err) {
            console.warn(`[${i + 1}/${VN_QUERIES.length}] "${query}" → ⚠️  ${(err as Error).message}`);
        }

        if (i < VN_QUERIES.length - 1) await sleep(DELAY_MS);
    }

    console.log(`\n✅  Done — ${totalImported} foods imported, ${totalSkipped} skipped (all-zero nutrition or already exists)\n`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
