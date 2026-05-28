/**
 * Seed recipe categories.
 * Run once: npx ts-node src/scripts/seedCategories.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import RecipeCategory from "../models/RecipeCategory";

const CATEGORIES = [
    { name_vi: "Cơm, cháo, xôi",                              name_en: "Rice, porridge & sticky rice",       sort_order: 1  },
    { name_vi: "Bún, miến, phở, hủ tiếu, mỳ",                name_en: "Noodles & pho",                      sort_order: 2  },
    { name_vi: "Bánh canh, lẩu, súp, hoành thánh",            name_en: "Noodle soup & hotpot",               sort_order: 3  },
    { name_vi: "Các món canh",                                 name_en: "Soups & broths",                     sort_order: 4  },
    { name_vi: "Các món xào",                                  name_en: "Stir-fries",                         sort_order: 5  },
    { name_vi: "Các loại bánh, kẹo",                          name_en: "Pastries, cakes & candy",            sort_order: 6  },
    { name_vi: "Chè, kem, caramen, các món tráng miệng",      name_en: "Sweet soups, desserts & ice cream",  sort_order: 7  },
    { name_vi: "Giải khát",                                    name_en: "Beverages & drinks",                 sort_order: 8  },
    { name_vi: "Các món trứng, sữa và chế phẩm",              name_en: "Eggs & dairy",                       sort_order: 9  },
    { name_vi: "Các loại trái cây",                           name_en: "Fruits",                             sort_order: 10 },
    { name_vi: "Các món chế biến sẵn",                        name_en: "Processed & ready-made foods",       sort_order: 11 },
    { name_vi: "Burger, pizza",                                name_en: "Burgers & pizza",                    sort_order: 12 },
    { name_vi: "Ngao, ốc, hải sản",                           name_en: "Shellfish & seafood",                sort_order: 13 },
    { name_vi: "Các món khác",                                 name_en: "Others",                             sort_order: 14 },
];

async function seed() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI not set in .env");

    await mongoose.connect(uri);
    console.log("Connected to MongoDB");

    let created = 0;
    let skipped = 0;

    for (const cat of CATEGORIES) {
        const exists = await RecipeCategory.findOne({ name_vi: cat.name_vi });
        if (exists) {
            console.log(`  SKIP  ${cat.name_vi}`);
            skipped++;
        } else {
            await RecipeCategory.create(cat);
            console.log(`  ADD   ${cat.name_vi}`);
            created++;
        }
    }

    console.log(`\nDone — ${created} added, ${skipped} skipped.`);
    await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
