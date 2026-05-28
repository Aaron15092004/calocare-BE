# Meal Plan Generation — Fix Plan

**Ngày:** 2026-05-01  
**Trạng thái:** Cần implement

---

## 1. Vấn Đề Hiện Tại

### 1.1 Thiếu dữ liệu món ăn
Food collection và Recipe collection gần như trống. UsdaFood đã có **5000+ items** với embedding sẵn, nhưng meal plan generator không khai thác đúng cách:
- Vector search trả UsdaFood hits với `source_type="usda"` ✓
- Nhưng khi lưu vào `MealPlanItem.food_id` → trỏ sai collection (`foods` thay vì `usdafoods`) → FE populate thất bại

### 1.2 Enrichment không sync với meal plan
- Enrichment chạy qua cron mỗi 10 phút (background)
- Khi user generate meal plan lúc 9:00 → phải đợi đến 9:10 trở đi mới có Food record từ USDA
- Trong khoảng thời gian đó, MealPlanItem.food_id trỏ vào UsdaFood._id (sai collection) → FE không hiển thị được thông tin dinh dưỡng

### 1.3 Tiêu chí chọn món quá đơn giản
LLM prompt hiện tại chỉ có:
- Calorie target
- Danh sách candidates
- Avoid repeat list
- Một dòng note về cooking style

Thiếu:
- Điều kiện sức khỏe / ghi chú của user
- Ưu tiên độ lành mạnh (thực phẩm tươi, ít chế biến)
- Ngữ cảnh bữa ăn cụ thể (nấu ở nhà, nấu 1 lần dùng cả ngày, v.v.)
- Macro balance thực sự (không chỉ calo)

### 1.4 `input_foods` của UsdaFood không được dùng
Mỗi UsdaFood có field `input_foods` chứa nguyên liệu nguồn (fdc_id, description, amount, unit). Field này là thông tin thành phần thực tế từ USDA — đây là dữ liệu thật, không phải AI estimate.

Hiện tại khi enrich UsdaFood → Food, `input_foods` bị bỏ qua hoàn toàn.

---

## 2. Business Rule Đúng

### 2.1 Nguồn dữ liệu thực phẩm (ưu tiên theo thứ tự)
```
1. Recipe collection   — công thức nấu ăn đã approved
2. Food collection     — thực phẩm đã được review/import
3. UsdaFood collection — 5000+ items USDA (nguồn dự phòng chính)
```

### 2.2 Khi UsdaFood được chọn vào meal plan
**KHÔNG dùng AI để estimate nutrition** — UsdaFood đã có đủ dữ liệu thật:
```
energy_kcal, protein, lipid, glucid, fiber, water
nutrients_extended: { minerals, vitamins, fats }
input_foods: [{ fdc_id, description, amount, unit }]
portions: [{ description, gram_weight }]
```

→ Tạo Food record trực tiếp từ dữ liệu này (sync, không đợi cron)  
→ Lưu `input_foods` vào `notes` hoặc field mới trong Food record để traceable

### 2.3 Tiêu chí chọn món (ngoài calorie)
| Tiêu chí | Mô tả |
|---|---|
| **Macro balance** | Protein/carbs/fat phải theo split của goal, không chỉ tổng calo |
| **Cooking style** | `batch`: ưu tiên món nấu được nhiều, hâm lại được (cơm, kho, canh); `fresh`: ưu tiên món nhanh, đơn giản |
| **Dietary restrictions** | Allergen, vegetarian/vegan/halal phải được lọc sạch trước khi vào prompt |
| **Food healthiness** | Ưu tiên thực phẩm nguyên chất (thịt, cá, rau, gạo) hơn đồ chế biến sẵn |
| **Cuisine preference** | Ưu tiên ẩm thực theo `cuisine_preferences` của user (mặc định Vietnamese) |
| **Variety** | Tránh lặp món trong 3 ngày gần nhất, tránh lặp protein nguồn trong cùng ngày |
| **Portion realism** | `portions` từ UsdaFood cho phép chọn serving size thực tế (không tự bịa weight_grams) |

### 2.4 User notes & conditions
User có thể cung cấp điều kiện ngoài schema chuẩn (dị ứng, bệnh lý, lịch sinh hoạt). Những thông tin này phải được đưa vào LLM context, không phải chỉ lọc ở vector query.

---

## 3. Các Thay Đổi Cần Làm

---

### [FIX-1] MealPlanItem — Thêm `usda_food_id`

**File:** `src/models/MealPlanItem.ts`

Thêm field `usda_food_id` để khi UsdaFood chưa kịp enrich → vẫn có reference đúng:

```typescript
usda_food_id: { type: Schema.Types.ObjectId, ref: "UsdaFood" }
```

**Lý do:** `food_id` ref sang `Food` collection. Khi UsdaFood được chọn nhưng Food record chưa tồn tại, cần trỏ đúng vào `usdafoods` collection để FE có thể fallback hiển thị thông tin từ UsdaFood trực tiếp.

**Khi nào dùng field nào:**
```
source_type = "recipe"  → recipe_id   populated
source_type = "food"    → food_id     populated
source_type = "usda"    → usda_food_id + food_id (sau khi enrich xong)
```

---

### [FIX-2] EnrichmentService — Enrich UsdaFood → Food dùng `input_foods`

**File:** `src/services/rag/EnrichmentService.ts`

`_processJob()` hiện tại đã đúng hướng (dùng data thật từ UsdaFood). Cần bổ sung:

**a) Lưu `input_foods` vào Food record:**
```typescript
const inputFoodsNote = usdaDoc.input_foods?.length
    ? `Nguyên liệu USDA: ${usdaDoc.input_foods.map(f => `${f.description} (${f.amount}${f.unit})`).join(", ")}`
    : undefined;

const food = await Food.create({
    name_vi: usdaDoc.description_vi ?? usdaDoc.description_en,
    name_en: usdaDoc.description_en,
    // ... các field dinh dưỡng như cũ ...
    notes: inputFoodsNote,
    source_reference: `USDA-${fdcId}`,
    // portions từ UsdaFood → serving suggestions
    // (nếu Food model có field này)
});
```

**b) Export `_processJob` public để gọi sync từ MealPlanGeneratorService:**

Đổi `private async _processJob` → `async processJob` (public, không có `_`).

**c) Sau khi sync-enrich thành công → update UsdaFood.imported_food_id ngay:**

Đã có trong code hiện tại, giữ nguyên.

---

### [FIX-3] MealPlanGeneratorService — Sync Enrich UsdaFood khi chọn vào meal

**File:** `src/services/rag/MealPlanGeneratorService.ts`

Hiện tại: UsdaFood items được xử lý giống food/recipe (lưu `_id` vào `food_id`), nhưng `_id` là `usdafoods._id`, không phải `foods._id`.

**Thay đổi trong vòng lặp build items:**

```typescript
// Khi source_type === "usda":
// 1. Gọi sync enrich để tạo Food record từ UsdaFood
// 2. Dùng Food._id mới làm food_id
// 3. Lưu usda_food_id để traceable

let resolvedFoodId: Types.ObjectId | undefined;
if (source_type === "usda") {
    try {
        const existingFood = await Food.findOne({
            source_reference: `USDA-${usdaFdcId}`
        }).select("_id").lean();

        if (existingFood) {
            resolvedFoodId = existingFood._id as Types.ObjectId;
        } else {
            // Enrich ngay lập tức (sync, không đợi cron)
            resolvedFoodId = await this.enrichment.processJob(usdaFdcId, false) ?? undefined;
        }
    } catch (err) {
        console.warn(`[MealPlanGenerator] Sync enrich failed for fdc_id=${usdaFdcId}:`, err);
        // Fallback: lưu usda_food_id, không có food_id
    }

    itemsToInsert.push({
        ...baseItem,
        food_id: resolvedFoodId,
        usda_food_id: new Types.ObjectId(usda_source_id),
        source_type: "usda",
    });
}
```

**Lưu ý:** Chỉ `fetchImage = false` khi sync-enrich trong meal plan (không block generate bằng Unsplash call). Image sẽ được fill qua cron bình thường sau đó.

---

### [FIX-4] FoodSearchService — Hydrate UsdaFood đầy đủ hơn

**File:** `src/services/rag/FoodSearchService.ts`

Kết quả search UsdaFood hiện trả về ít field. Cần hydrate thêm:
- `portions[]` → để LLM và service biết serving size thực tế
- `input_foods[]` → cho context về thành phần
- `wweia_category` → để lọc theo bữa ăn (baby food, breakfast cereals, v.v.)

Bổ sung trong `_hydrateResults()`:
```typescript
// Với source_type = "usda":
// select thêm: portions, input_foods, wweia_category, description_vi
```

---

### [FIX-5] LLM Prompt — Rich Context

**File:** `src/services/rag/MealPlanGeneratorService.ts`, hàm `_generateDay()`

#### Prompt hiện tại (thiếu):
```
Meal candidates (choose ONLY names from each list):
breakfast [target: 400kcal]: ...
```

#### Prompt mới cần có:

**A. Cooking style context chi tiết:**
```
PHONG CÁCH NẤU ĂN:
- batch: Ưu tiên món có thể nấu 1 lần dùng cả ngày/nhiều bữa (cơm, thịt kho, canh, đậu phụ). Tránh món cần ăn ngay sau nấu (salad tươi, trứng ốp la).
- fresh: Ưu tiên món nhanh nấu < 20 phút, đơn giản, ít nguyên liệu.
```

**B. Health criteria:**
```
TIÊU CHÍ LÀNH MẠNH:
- Ưu tiên thực phẩm nguyên chất (thịt, cá, rau, gạo, đậu) hơn thực phẩm chế biến sẵn
- Không chọn > 1 món chiên rán trong cùng 1 ngày
- Đa dạng nguồn protein (không chỉ thịt heo suốt cả ngày)
```

**C. Macro targets per meal (không chỉ calo):**
```
Mục tiêu từng bữa:
- breakfast: ${targetCal}kcal, protein ≥ ${proteinTarget}g, carbs ≤ ${carbsTarget}g
- lunch: ...
```

**D. User notes field (mới):**  
Nếu user cung cấp `notes` (free text) → đưa nguyên vào prompt:
```
YÊU CẦU RIÊNG CỦA USER: "${req.preferences?.notes}"
```

**E. Portion guidance từ UsdaFood:**
Khi candidate là UsdaFood, thêm serving size hint:
```
"Cháo yến mạch [1 chén = 240g]"
```
→ LLM có thể chọn `weight_grams` thực tế hơn.

---

### [FIX-6] GenerateMealPlanRequest — Thêm `notes` field

**File:** `src/services/rag/MealPlanGeneratorService.ts` + `src/routes/rag/mealPlan.ts`

```typescript
export interface GenerateMealPlanRequest {
    // ... existing fields ...
    preferences?: {
        dietary_preference?: string;
        allergies?: string[];
        cuisine_preferences?: string[];
        notes?: string;              // ← MỚI: điều kiện tự do của user
    };
}
```

Zod schema update:
```typescript
preferences: z.object({
    // ...
    notes: z.string().max(500).optional(),   // ← MỚI
})
```

---

### [FIX-7] Search Query — Phản ánh đúng bữa ăn và cooking style

**File:** `src/services/rag/MealPlanGeneratorService.ts`, phần build `searchResults`

Query hiện tại:
```typescript
const query = `${mealType} ${cuisine} ${targetCal}kcal`;
```

Query mới — thêm cooking style và goal context:
```typescript
const cookingHint = req.cooking_style === "batch"
    ? "kho nấu nhiều hâm lại"
    : "nhanh tươi đơn giản";

const goalHint = req.goal === "weight_loss"
    ? "ít dầu mỡ ít tinh bột"
    : req.goal === "muscle_gain"
    ? "nhiều protein thịt cá"
    : "cân bằng";

const query = `${mealType} ${cuisine} ${goalHint} ${cookingHint} ${targetCal}kcal`;
```

---

## 4. Luồng Đúng Sau Khi Fix

```
User chọn: goal, duration, meals_per_day, cooking_style, preferences, notes
    │
    ▼
MealPlanGeneratorService.generate()
    │
    ├─ Tính dailyCalories + macro targets (giữ nguyên)
    │
    └─ Loop từng ngày:
        │
        ├─ [FIX-5,7] _generateDay() — search với query giàu context hơn
        │       │
        │       ├─ FoodSearchService.search() × (3|4|5) meal types (song song)
        │       │       └─ Vector search: Recipe + Food + UsdaFood (5000+ items)
        │       │          → post-filter allergen, dietary, wweia_category
        │       │          → hydrate thêm portions, input_foods
        │       │
        │       └─ LLM Prompt với full context:
        │               • Macro targets per meal
        │               • Cooking style chi tiết
        │               • Health criteria
        │               • User notes
        │               • Portion hints từ UsdaFood
        │               → LLM chọn từ candidate list (tên exact)
        │
        ├─ Resolve từng meal được LLM chọn:
        │       │
        │       ├─ Match tìm thấy trong foodLookup?
        │       │       ├─ source_type = "recipe" → recipe_id ✓
        │       │       ├─ source_type = "food"   → food_id ✓
        │       │       └─ source_type = "usda"   → [FIX-2,3] sync enrich:
        │       │               ├─ Food.findOne({ source_reference: USDA-{fdc_id} })
        │       │               ├─ Nếu có → dùng food_id luôn ✓
        │       │               └─ Nếu chưa → EnrichmentService.processJob(fdc_id)
        │       │                       → Food.create() từ UsdaFood data thật
        │       │                       → input_foods lưu vào notes
        │       │                       → trả food._id mới
        │       │                       → lưu usda_food_id để traceable [FIX-1]
        │       │
        │       └─ Không match → top candidate fallback (giữ nguyên logic hiện tại)
        │
        └─ MealPlanItem.insertMany() — food_id luôn trỏ đúng Food collection
```

---

## 5. Thứ Tự Implement

| # | File | Việc cần làm | Độ khó |
|---|---|---|---|
| 1 | `models/MealPlanItem.ts` | Thêm `usda_food_id` field | Dễ |
| 2 | `services/rag/EnrichmentService.ts` | Đổi `_processJob` → public `processJob` | Dễ |
| 3 | `services/rag/EnrichmentService.ts` | Lưu `input_foods` vào Food.notes | Dễ |
| 4 | `services/rag/MealPlanGeneratorService.ts` | Sync enrich USDA khi chọn vào meal | Trung bình |
| 5 | `services/rag/MealPlanGeneratorService.ts` | LLM prompt thêm macro/cooking/health/notes | Trung bình |
| 6 | `services/rag/MealPlanGeneratorService.ts` | Search query thêm cooking style + goal hint | Dễ |
| 7 | `services/rag/FoodSearchService.ts` | Hydrate thêm portions, input_foods | Trung bình |
| 8 | `routes/rag/mealPlan.ts` + `GenerateMealPlanRequest` | Thêm `notes` field | Dễ |

---

## 6. Không Thay Đổi

- Logic calorie target + macro split (đang đúng)
- MEAL_CONFIGS 3/4/5 bữa (đang đúng)
- Anti-repeat recentFoodNames window (đang đúng)
- SSE streaming protocol (đang đúng)
- `_createSystemRecipe` giữ BLOCKED
- EnrichmentCron (vẫn chạy background cho image + translation)
- Recipe enrichment flow (không đổi)

---

## 8. Knowledge RAG — Có Cần Import Nghiên Cứu Khoa Học Không?

### 8.1 Làm Rõ Khái Niệm "Training"

"Training" ở đây **không phải** fine-tune model weights của Groq hay Gemini.  
Đây là **RAG knowledge base** — thêm document vào vector store để retrieve và inject vào LLM prompt lúc generate.

Groq/Gemini đã có kiến thức dinh dưỡng tổng quát từ pre-training. Nhưng kiến thức đó:

- Không đặc thù cho người Việt Nam (khẩu phần, thói quen, nguyên liệu địa phương)
- Không phản ánh hướng dẫn chính thức của Bộ Y tế / Viện Dinh Dưỡng VN
- Không có CaloCare business rules (LLM không thể tự biết)
- Có thể hallucinate số liệu cụ thể nếu không có nguồn tham chiếu

---

### 8.2 Phân Loại: Cần vs Không Cần Knowledge RAG

| Loại kiến thức | LLM tự biết? | Cần RAG? | Lý do |
|---|---|---|---|
| Tính macro từ % và calo | ✓ (toán học) | Không | Pure math |
| Phân loại thực phẩm (protein/carb/fat) | ✓ | Không | LLM training đủ |
| Nhận diện allergen phổ biến | ✓ | Không | LLM training đủ |
| Khẩu phần chuẩn người Việt trưởng thành | Mơ hồ | **Có** | Data đặc thù VN |
| Hướng dẫn giảm cân an toàn (−500 kcal/ngày) | Biết chung | **Có** | Cần nguồn có thẩm quyền |
| Chế độ ăn bệnh lý (tiểu đường, gout, thận) | Biết chung | **Có** | Rủi ro nếu sai — cần bác sĩ/guideline |
| Kết hợp thực phẩm tăng hấp thu (Fe + Vit C) | Biết | **Có** | LLM không luôn apply đúng chỗ |
| Ẩm thực Việt: cơm + canh + rau + protein ratio | Rất mơ hồ | **Có** | Không có trong training tốt |
| CaloCare business rules (ưu tiên batch cook, v.v.) | Không | **Có** | LLM không thể tự biết |
| Bữa ăn trước/sau tập luyện (gym, cardio) | Biết chung | **Có** | Cần cụ thể hơn |

---

### 8.3 Kiến Trúc Knowledge RAG

Tách biệt hoàn toàn với Food/Recipe/USDA vector store:

```
Vector Collections hiện tại:
  foodvectors      — embedding của Food documents
  recipevectors    — embedding của Recipe documents
  usdafoods        — embedding có sẵn trong UsdaFood documents

Vector Collection MỚI (Knowledge RAG):
  knowledge_chunks — embedding của dietary guidelines, rules, research
```

**Schema một knowledge chunk:**
```typescript
{
  _id: ObjectId,
  title: string,           // "Khẩu phần protein cho người tập thể thao"
  content: string,         // nội dung chunk, tối đa 500 tokens
  category: KnowledgeCategory,
  source: string,          // "Viện Dinh Dưỡng Quốc Gia VN, 2023"
  applies_to: string[],    // ["weight_loss", "muscle_gain"] hoặc ["diabetes"]
  embedding: number[],
  created_at: Date,
}

type KnowledgeCategory =
  | "dietary_guideline"    // hướng dẫn dinh dưỡng chính thức
  | "meal_composition"     // quy tắc xây dựng bữa ăn
  | "food_interaction"     // kết hợp thực phẩm (tăng/giảm hấp thu)
  | "condition_diet"       // ăn theo bệnh lý
  | "vietnamese_pattern"   // thói quen ăn người Việt
  | "business_rule"        // CaloCare-specific rules
  | "cooking_guideline";   // quy tắc batch cook, fresh cook
```

---

### 8.4 Loại Tài Liệu Cần Import

#### Nhóm 1 — Hướng dẫn dinh dưỡng Việt Nam (ưu tiên cao)

- Tháp dinh dưỡng người Việt trưởng thành — Viện Dinh Dưỡng Quốc Gia
- Khuyến nghị nhu cầu dinh dưỡng — Bộ Y tế VN (RDA cho protein, vitamin, khoáng chất)
- Hướng dẫn chế độ ăn cho người thừa cân béo phì — Viện Dinh Dưỡng
- Tỉ lệ cơm/rau/protein trong bữa ăn truyền thống Việt
- Khẩu phần thực tế: 1 bát cơm ≈ 150g nấu chín ≈ 200kcal

#### Nhóm 2 — Quy tắc xây dựng bữa ăn theo mục tiêu

- Giảm cân: deficit 300–500 kcal/ngày an toàn, không dưới 1200kcal/ngày (nữ) / 1500kcal/ngày (nam)
- Tăng cơ: surplus 200–300kcal, protein ≥ 1.6g/kg cân nặng
- Duy trì: protein 0.8–1.2g/kg, carb 45–65% TDEE
- Bữa sáng: nên có protein + carb phức hợp, tránh đường đơn
- Bữa tối: giảm carb, tăng protein + rau xanh (cho mục tiêu giảm cân)

#### Nhóm 3 — Kết hợp thực phẩm (food interactions)

- Sắt (Fe) hấp thu tốt hơn với vitamin C → thịt/cá + rau xanh/cà chua
- Canxi hấp thu bị cản bởi oxalate → không nên ăn rau chân vịt + sữa cùng lúc
- Protein thực vật + động vật kết hợp → đủ amino acid thiết yếu
- Chất béo lành mạnh (avocado, dầu olive) tăng hấp thu vitamin A/D/E/K
- Tránh kết hợp: thịt đỏ + rượu (tăng gout risk)

#### Nhóm 4 — Chế độ ăn theo bệnh lý (future feature, chuẩn bị sẵn)

- Tiểu đường type 2: glycemic index thấp, hạn chế carb refined, chia nhỏ bữa
- Tăng huyết áp: DASH diet, giảm natri < 2300mg/ngày, tăng kali
- Gout: hạn chế purine cao (nội tạng, hải sản vỏ cứng, thịt đỏ)
- Bệnh thận mạn: hạn chế protein, kali, phosphorus
- Mang thai: tăng folate, sắt, canxi, omega-3

#### Nhóm 5 — CaloCare Business Rules (document hóa, không hardcode)

- Batch cook: ưu tiên cơm, thịt kho, canh nấu được nhiều, giữ tủ lạnh 3 ngày
- Fresh cook: ưu tiên rau xào nhanh, trứng, salad, cá hấp < 20 phút
- Variety rule: tối đa 1 protein nguồn động vật/bữa, tối đa 2 lần/tuần thịt đỏ
- Healthiness score: nguyên chất > nấu đơn giản > chế biến sẵn > ultra-processed
- Phù hợp văn hóa Việt: 70% món Á, 30% western nếu không có preference cụ thể

#### Nhóm 6 — WWEIA Category Rules (từ UsdaFood data)

- `wweia_category "Baby food: *"` → không đưa vào meal plan người lớn
- `wweia_category "Infant formula"` → exclude
- `wweia_category "Alcoholic beverages"` → exclude mặc định, chỉ include nếu user opt-in
- `wweia_category "Dietary supplements"` → không phải thực phẩm, exclude
- Ưu tiên: "Vegetables", "Fruits", "Grains", "Protein foods", "Dairy"

---

### 8.5 Luồng Sử Dụng Knowledge RAG Khi Generate

```text
generate(req)
    │
    ├─ [MỚI] Retrieve knowledge chunks liên quan:
    │       query = "${req.goal} ${req.cooking_style} ${req.preferences.notes}"
    │       + "${req.preferences.dietary_preference}"
    │       → top_k = 4 chunks từ knowledge_chunks collection
    │       → lọc theo: applies_to chứa req.goal hoặc user's conditions
    │
    └─ _generateDay(day, targets, req, recentFoodNames, knowledgeContext)
            │
            └─ LLM Prompt = [food candidates] + [knowledge context]
                    ví dụ injected context:
                    "KIẾN THỨC DINH DƯỠNG ÁP DỤNG:
                     - Bữa tối nên giảm carb, tăng rau xanh và protein (mục tiêu giảm cân)
                     - Khẩu phần cơm chuẩn Việt: 1 bát = 150g ≈ 200kcal
                     - Kết hợp thịt/cá với rau chứa vitamin C để tăng hấp thu sắt"
```

---

### 8.6 Phase Triển Khai

#### Phase 1 — Không cần infrastructure mới (làm ngay)

Nhúng trực tiếp các rules quan trọng nhất vào LLM system prompt như static text:

- Khẩu phần chuẩn Việt
- CaloCare business rules (batch/fresh)
- WWEIA category exclusions
- Diversity rules

→ Làm trong [FIX-5] phần prompt improvement đã có ở trên.

#### Phase 2 — Knowledge RAG collection (khi có đủ content)

Khi nào cần:

- App muốn support bệnh lý đặc thù (tiểu đường, gout, thận)
- Muốn cite nguồn chính thức trong UI ("theo Viện Dinh Dưỡng VN")
- Số lượng rules > 2000 tokens (không nhét hết vào system prompt)

Việc cần làm:

1. Tạo model `KnowledgeChunk` + collection
2. Script import documents → chunk + embed
3. `KnowledgeService.retrieve(query, applies_to)` → top_k chunks
4. Inject vào `_generateDay()` prompt trước food candidates

**Lưu ý:** Knowledge RAG phải dùng embedding model **giống** với food vectors (voyage-4-lite) để cosine similarity có nghĩa khi so sánh cross-collection. Hoặc dùng collection riêng biệt và chỉ search trong `knowledge_chunks` (không merge với food results) → không cần cùng model.

---

## 7. Edge Cases Cần Xử Lý

| Case | Xử lý |
|---|---|
| Sync enrich UsdaFood fail (network/DB lỗi) | Lưu `usda_food_id` không có `food_id`, log warning. FE fallback đọc từ `usdafoods` collection |
| UsdaFood `description_vi` null | Dùng `description_en` làm `name_vi` tạm thời. Enrichment cron sẽ translate sau |
| UsdaFood `wweia_category` là "Baby food" | Filter trong post-process: không đưa baby food vào meal plan người lớn (filter theo wweia_category_code) |
| User nhập notes độc hại / quá dài | Zod max(500 chars), LLM prompt chỉ nhận string thuần |
| Sync enrich tạo Food trùng | `Food.findOne({ source_reference })` check trước khi create — đã có trong `_processJob` |
