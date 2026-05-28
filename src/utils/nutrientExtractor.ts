/**
 * Map USDA nutrient IDs to flat field names.
 * Source: USDA FDC nutrient number reference.
 */
const NUTRIENT_MAP: Record<number, string> = {
    1008: "energy_kcal",
    1003: "protein",
    1004: "lipid",
    1005: "glucid",
    1079: "fiber",
    1051: "water",
    // Minerals
    1087: "calcium_mg",
    1089: "iron_mg",
    1090: "magnesium_mg",
    1091: "phosphorus_mg",
    1092: "potassium_mg",
    1093: "sodium_mg",
    1095: "zinc_mg",
    1098: "copper_mg",
    1101: "manganese_mg",
    1103: "selenium_ug",
    // Vitamins
    1106: "vitamin_a_ug",
    1162: "vitamin_c_mg",
    1114: "vitamin_d_ug",
    1109: "vitamin_e_mg",
    1183: "vitamin_k_ug",
    1165: "thiamin_mg",
    1166: "riboflavin_mg",
    1167: "niacin_mg",
    1175: "vitamin_b6_mg",
    1177: "folate_ug",
    1178: "vitamin_b12_ug",
    // Fats
    1258: "saturated_fat_g",
    1257: "trans_fat_g",
    1292: "monounsaturated_fat_g",
    1293: "polyunsaturated_fat_g",
    1253: "cholesterol_mg",
};

const FLAT_FIELDS = new Set(["energy_kcal", "protein", "lipid", "glucid", "fiber", "water"]);

export interface ExtractedNutrients {
    energy_kcal: number;
    protein: number;
    lipid: number;
    glucid: number;
    fiber?: number;
    water?: number;
    nutrients_extended: {
        minerals: Record<string, number>;
        vitamins: Record<string, number>;
        fats: Record<string, number>;
    };
}

interface RawFoodNutrient {
    nutrient?: { id?: number; number?: string };
    nutrientId?: number;
    amount?: number;
    value?: number;
}

export function extractNutrients(foodNutrients: RawFoodNutrient[]): ExtractedNutrients {
    const flat: Record<string, number> = {
        energy_kcal: 0,
        protein: 0,
        lipid: 0,
        glucid: 0,
    };
    const minerals: Record<string, number> = {};
    const vitamins: Record<string, number> = {};
    const fats: Record<string, number> = {};

    for (const fn of foodNutrients) {
        const id = fn.nutrient?.id ?? fn.nutrientId ?? parseInt(fn.nutrient?.number ?? "0");
        const amount = fn.amount ?? fn.value ?? 0;
        const field = NUTRIENT_MAP[id];
        if (!field) continue;

        if (FLAT_FIELDS.has(field)) {
            flat[field] = amount;
        } else if (field.endsWith("_mg") || field.endsWith("_ug") || field.endsWith("_g")) {
            const name = field.replace(/_mg|_ug|_g$/, "");
            if (field.includes("vitamin") || field.includes("thiamin") ||
                field.includes("riboflavin") || field.includes("niacin") ||
                field.includes("folate")) {
                vitamins[name] = amount;
            } else if (field.includes("fat") || field.includes("cholesterol")) {
                fats[name] = amount;
            } else {
                minerals[name] = amount;
            }
        }
    }

    return {
        energy_kcal: flat.energy_kcal,
        protein: flat.protein,
        lipid: flat.lipid,
        glucid: flat.glucid,
        fiber: flat.fiber,
        water: flat.water,
        nutrients_extended: { minerals, vitamins, fats },
    };
}
