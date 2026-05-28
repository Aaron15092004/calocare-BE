/**
 * Build search_text strings optimized for Voyage AI embedding.
 * Structured markers help the model learn field semantics.
 */

interface UsdaSearchTextInput {
    description_vi?: string;
    description_en: string;
    wweia_category?: string;
    input_foods?: Array<{ description: string; description_vi?: string }>;
    portions?: Array<{ description: string; gram_weight: number }>;
    energy_kcal: number;
    protein: number;
    lipid: number;
    glucid: number;
    diet_tags?: string[];
}

export function buildUsdaSearchText(food: UsdaSearchTextInput): string {
    const name = food.description_vi
        ? `${food.description_vi} | ${food.description_en}`
        : food.description_en;

    const category = food.wweia_category ?? "";

    const ingredients = (food.input_foods ?? [])
        .slice(0, 5)
        .map((f) => f.description_vi ?? f.description)
        .join(", ");

    const portions = (food.portions ?? [])
        .map((p) => `${p.description} (${p.gram_weight}g)`)
        .join("; ");

    const nutrition = [
        `${Math.round(food.energy_kcal)}kcal`,
        `P${food.protein.toFixed(1)}g`,
        `L${food.lipid.toFixed(1)}g`,
        `G${food.glucid.toFixed(1)}g`,
    ].join(" ");

    const tags = (food.diet_tags ?? []).join(" ");

    const parts = [
        `[TÊN] ${name}`,
        category ? `[LOẠI] ${category}` : "",
        ingredients ? `[NGUYÊN LIỆU] ${ingredients}` : "",
        portions ? `[KHẨU PHẦN] ${portions}` : "",
        `[DINH DƯỠNG/100g] ${nutrition}`,
        tags ? `[TAGS] ${tags}` : "",
    ].filter(Boolean);

    return parts.join("\n");
}

interface FoodSearchTextInput {
    name_vi: string;
    name_en?: string;
    food_group_name?: string;
    search_keywords?: string[];
    energy_kcal: number;
    protein: number;
    lipid: number;
    glucid: number;
    diet_tags?: string[];
}

export function buildFoodSearchText(food: FoodSearchTextInput): string {
    const name = food.name_en
        ? `${food.name_vi} | ${food.name_en}`
        : food.name_vi;

    const keywords = (food.search_keywords ?? []).join(", ");
    const nutrition = [
        `${Math.round(food.energy_kcal)}kcal`,
        `P${food.protein.toFixed(1)}g`,
        `L${food.lipid.toFixed(1)}g`,
        `G${food.glucid.toFixed(1)}g`,
    ].join(" ");
    const tags = (food.diet_tags ?? []).join(" ");

    const parts = [
        `[TÊN] ${name}`,
        food.food_group_name ? `[NHÓM] ${food.food_group_name}` : "",
        keywords ? `[TỪ KHÓA] ${keywords}` : "",
        `[DINH DƯỠNG/100g] ${nutrition}`,
        tags ? `[TAGS] ${tags}` : "",
    ].filter(Boolean);

    return parts.join("\n");
}

interface RecipeSearchTextInput {
    name: string;
    description?: string;
    category?: string;
    meal_type?: string;
    cuisine?: string;
    instructions?: string;
    tags?: string[];
    energy_kcal?: number;
    protein?: number;
    lipid?: number;
    glucid?: number;
    diet_tags?: string[];
}

export function buildRecipeSearchText(recipe: RecipeSearchTextInput): string {
    // First 50 words of instructions capture key ingredients and technique
    const instructionSnippet = recipe.instructions
        ? recipe.instructions.split(/\s+/).slice(0, 50).join(" ")
        : "";

    const nutrition =
        recipe.energy_kcal !== undefined
            ? [
                  `${Math.round(recipe.energy_kcal)}kcal`,
                  `P${(recipe.protein ?? 0).toFixed(1)}g`,
                  `L${(recipe.lipid ?? 0).toFixed(1)}g`,
                  `G${(recipe.glucid ?? 0).toFixed(1)}g`,
              ].join(" ")
            : "";

    const tags = [...(recipe.tags ?? []), ...(recipe.diet_tags ?? [])].join(" ");

    const parts = [
        `[TÊN] ${recipe.name}`,
        recipe.description ? `[MÔ TẢ] ${recipe.description}` : "",
        recipe.category ? `[LOẠI] ${recipe.category}` : "",
        recipe.meal_type ? `[BỮA] ${recipe.meal_type}` : "",
        recipe.cuisine ? `[ẨM THỰC] ${recipe.cuisine}` : "",
        instructionSnippet ? `[CÁCH LÀM] ${instructionSnippet}` : "",
        nutrition ? `[DINH DƯỠNG] ${nutrition}` : "",
        tags ? `[TAGS] ${tags}` : "",
    ].filter(Boolean);

    return parts.join("\n");
}
