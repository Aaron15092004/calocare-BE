# USDA Embed & Enrichment — Root Cause & Fix Checklist

---

## Vấn đề 1: `input_foods: []` cho hầu hết USDA foods

### Lý do
USDA FoodData Central có nhiều loại data:
- **SR Legacy / Foundation / Branded Foods** → basic ingredient foods → `inputFoods = []` trong JSON → **expected, không phải bug**
- **Survey FNDDS foods** (WWEIA) → composite dishes (VD: "Beef stew") → mới có `inputFoods` chứa thành phần

Script dùng file `data/usda_survey.json` nhưng nếu data source là SR Legacy format, `inputFoods` luôn rỗng. Không ảnh hưởng đến nutrition data vì nutrients lấy từ `foodNutrients`, không phải `inputFoods`.

**Kết luận:** `input_foods: []` là bình thường, không phải bug cần fix.

---

## Vấn đề 2: Enrichment không trigger được (queue luôn trống hoặc fail)

### Lý do — Bug trong `ingest-usda.ts`

**File:** `src/scripts/ingest-usda.ts` function `processBatch`, lines ~199–204

```typescript
// ĐÂY LÀ BUG — hardcode 0 khi build search text để embed
const partialSearch = buildUsdaSearchText({
    description_vi: translations[i],
    description_en: r.description,
    wweia_category: getWweiaInfo(r).category,
    input_foods: r.inputFoods?.map(...),
    portions: r.foodPortions?.map(...),
    energy_kcal: 0,   // ← HARDCODED! Không dùng actual nutrition
    protein: 0,        // ← HARDCODED!
    lipid: 0,          // ← HARDCODED!
    glucid: 0,         // ← HARDCODED!
});
```

**Hậu quả dây chuyền:**
1. `search_text` của UsdaFood ghi vào MongoDB có nội dung: `[DINH DƯỠNG/100g] 0kcal P0.0g L0.0g G0.0g`
2. Embedding vector được build từ text đó → **không có calorie/nutrition context**
3. Khi meal plan search: `"breakfast Vietnamese 540kcal"` → cosine similarity với USDA vector rất thấp (vector không biết food này bao nhiêu kcal)
4. `score < 0.7` → `FoodSearchService` không queue enrichment
5. **EnrichmentQueue luôn trống** → không có gì để enrich

**Lưu ý:** Nutrition data (`energy_kcal`, `protein`, etc.) trong MongoDB document hoàn toàn đúng (vì `rawToPartialDoc` dùng `extractNutrients(raw.foodNutrients)` đúng cách). Chỉ có embedding bị sai.

---

## Vấn đề 3: Recipe cũng không vào enrichment

### Lý do
Recipe KHÔNG đi qua `EnrichmentService` — không có `EnrichmentQueue` entry cho recipe, đây là by-design.

Recipe được embed riêng qua `embed-existing-recipes.ts` → tạo `RecipeVector` documents → Atlas vector search.

Nếu recipe search cũng trả về ít/không có kết quả, nguyên nhân là:
- `buildRecipeSearchText` dùng `recipe.energy_kcal` = tổng calo cả món (không phải per 100g)
- Query search của meal plan: `"breakfast Vietnamese 540kcal"` → recipe embedding có `[DINH DƯỠNG] 1831kcal` → similarity thấp với `540kcal` query

---

## Fix Checklist

### [E1] ✅ Fix bug hardcode zeros trong `ingest-usda.ts`

**File:** `src/scripts/ingest-usda.ts` function `processBatch`

```typescript
// BEFORE (bug):
energy_kcal: 0,
protein: 0,
lipid: 0,
glucid: 0,

// AFTER (fix):
const partialNutrients = extractNutrients(r.foodNutrients ?? []);
// ... trong buildUsdaSearchText call:
energy_kcal: partialNutrients.energy_kcal,
protein: partialNutrients.protein,
lipid: partialNutrients.lipid,
glucid: partialNutrients.glucid,
```

Note: `extractNutrients` đã import sẵn ở đầu file.

---

### [E2] ✅ Re-embed USDA docs đã có (không xóa/tạo lại data)

Vì nutrition trong MongoDB đã đúng, chỉ cần cập nhật `embedding` + `search_text`:

```typescript
// scripts/fix-usda-embeddings.ts
// Chạy: npx ts-node src/scripts/fix-usda-embeddings.ts

import UsdaFood from "../models/UsdaFood";
import { getEmbeddingService } from "../services/rag/EmbeddingService";
import { buildUsdaSearchText } from "../utils/searchTextBuilder";

const BATCH = 50;
let updated = 0;

const total = await UsdaFood.countDocuments();
for (let skip = 0; skip < total; skip += BATCH) {
    const docs = await UsdaFood.find().skip(skip).limit(BATCH).lean();
    
    const texts = docs.map((d) => buildUsdaSearchText({
        description_vi: d.description_vi,
        description_en: d.description_en,
        wweia_category: d.wweia_category,
        input_foods: d.input_foods,
        portions: d.portions,
        energy_kcal: d.energy_kcal,    // ← dùng data thật
        protein: d.protein,
        lipid: d.lipid,
        glucid: d.glucid,
        diet_tags: d.diet_tags,
    }));
    
    const embeddings = await getEmbeddingService().embedBatch(texts, "document");
    
    const bulkOps = docs.map((d, i) => ({
        updateOne: {
            filter: { fdc_id: d.fdc_id },
            update: { $set: { embedding: embeddings[i], search_text: texts[i] } },
        },
    }));
    await UsdaFood.bulkWrite(bulkOps);
    updated += docs.length;
    console.log(`Updated ${updated}/${total}`);
}
```

**Không migrate data** — chỉ update 2 fields `embedding` + `search_text` trên documents đã có.  
Sau khi chạy: Atlas vector search sẽ tự pick up embeddings mới (near real-time).

---

### [E3] Fix query search trong meal plan để match USDA data tốt hơn

**File:** `src/services/rag/MealPlanGeneratorService.ts`  

Query hiện tại: `"breakfast Vietnamese 540kcal"`  
Sau khi re-embed [E2], USDA vectors sẽ có `[DINH DƯỠNG/100g] Xkcal` → semantic match tốt hơn.

Nhưng để tăng recall, thêm tên loại food vào query:
```typescript
// BEFORE:
const query = `${mealType} ${cuisine} ${targetCal}kcal`;

// AFTER:
const query = `${mealType} food ${cuisine} about ${targetCal}kcal per serving`;
```

---

### [E4] Hạ threshold trigger enrichment từ 0.7 → 0.5 (tạm thời)

**File:** `src/services/rag/FoodSearchService.ts` line ~71

```typescript
// BEFORE:
(r) => r.source_type === "usda" && r.score > 0.7 && !r.imported_to_foods,

// AFTER (sau khi re-embed, có thể raise lại):
(r) => r.source_type === "usda" && r.score > 0.5 && !r.imported_to_foods,
```

---

## Thứ tự thực hiện

```
1. Fix bug [E1] trong ingest-usda.ts (phòng tương lai)
2. Tạo và chạy script fix-usda-embeddings.ts [E2] — ~30 phút cho 5k docs
3. Verify: query USDA food trong Atlas Search Preview → có score > 0.7 không
4. Nếu vẫn thấp: apply [E3] và [E4]
5. Generate meal plan → check log: "[MealPlanGenerator] Day 1: LLM returned 3 meals"
```

---

## Verify thành công

```
[ ] Atlas UI: usdafoods collection → check embedding field có values (không phải null)
[ ] Log enrichment: "[EnrichmentService] Job XXXX..." xuất hiện sau khi search
[ ] Admin panel EnrichmentQueue: có entries mới với status "imported" hoặc "processing"
[ ] Meal plan generate: log "Day 1: LLM returned 3 meals" (không bị skip)
```
