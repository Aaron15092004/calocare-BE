# RAG Meal Plan — Luồng Hoạt Động Chi Tiết

**Ngày viết:** 2026-05-01  
**Liên quan:** `MealPlanGeneratorService`, `FoodSearchService`, `RetrievalService`, `LLMService`

---

## 1. Tổng Quan Kiến Trúc

```
FE (GenerateMealPlan.tsx)
    │  POST /api/rag/generate-meal-plan
    │  Body: { duration_days, goal, meals_per_day, cooking_style, preferences }
    ▼
routes/rag/mealPlan.ts
    │  Zod validation → SSE headers → gọi MealPlanGeneratorService.generate()
    │  Trả về SSE stream (text/event-stream)
    ▼
MealPlanGeneratorService.generate()
    │  Loop từng ngày → _generateDay()
    │  Mỗi ngày emit SSE event "day"
    │  Cuối emit "done"
    ▼
    ├─► FoodSearchService.search()  (vector search)
    ├─► LLMService.generate()       (Groq LLM)
    └─► MongoDB write               (MealPlan, MealPlanItem, UserMealPlan)
```

**Protocol:** Server-Sent Events (SSE) — client nhận từng ngày ngay khi sinh xong, không cần đợi toàn bộ kế hoạch.

---

## 2. Input Validation (Zod Schema)

```
POST /api/rag/generate-meal-plan
```

| Field | Kiểu | Constraint |
|---|---|---|
| `duration_days` | `7 \| 21` | literal — chỉ 7 hoặc 21 ngày |
| `goal` | enum | `weight_loss \| muscle_gain \| maintenance` |
| `meals_per_day` | `3 \| 4 \| 5` | optional, mặc định 4 |
| `cooking_style` | `fresh \| batch` | optional |
| `preferences.dietary_preference` | string | omnivore/vegetarian/vegan/... |
| `preferences.allergies` | string[] | dị ứng — dùng để lọc vector results |
| `preferences.cuisine_preferences` | string[] | ưu tiên ẩm thực trong query |

Middleware: `authenticate` (JWT) + `ragRateLimit("meal-plan")`.

---

## 3. Tính Toán Nutrition Targets

### 3.1 Calorie hàng ngày

```
dailyCalories = user.daily_nutrition_goals.calories   (mặc định 2000)
              + CALORIE_OFFSET[goal]
```

| Goal | Offset |
|---|---|
| `weight_loss` | −500 kcal |
| `muscle_gain` | +300 kcal |
| `maintenance` | 0 |

### 3.2 Macro targets

Phân chia % protein/carbs/fat theo goal:

| Goal | Protein | Carbs | Fat |
|---|---|---|---|
| `weight_loss` | 30% | 40% | 30% |
| `muscle_gain` | 30% | 50% | 20% |
| `maintenance` | 25% | 45% | 30% |

Chuyển sang gram:
- Protein (g) = `dailyCalories × pPct% / 4`  (4 kcal/g)
- Carbs (g) = `dailyCalories × cPct% / 4`
- Fat (g) = `dailyCalories × fPct% / 9`  (9 kcal/g)

### 3.3 Phân bổ calo theo bữa (MEAL_CONFIGS)

| `meals_per_day` | Bữa | % calo |
|---|---|---|
| 3 | breakfast / lunch / dinner | 30% / 40% / 30% |
| 4 | breakfast / lunch / dinner / snack | 25% / 35% / 30% / 10% |
| 5 | breakfast / morning_snack / lunch / afternoon_snack / dinner | 20% / 10% / 30% / 10% / 30% |

---

## 4. Luồng Sinh Từng Ngày — `_generateDay()`

Mỗi ngày chạy tối đa **3 lần retry** nếu thất bại (parse lỗi hoặc LLM timeout). Lần retry 2+ tăng temperature lên 0.4 (mặc định 0.2) để LLM chọn kết quả khác.

### 4.1 Vector Search — Tìm Candidates

Gọi song song `FoodSearchService.search()` cho **mỗi meal type**:

```
query = "{meal_type} {cuisine[0] ?? 'Vietnamese'} {targetCal}kcal"
top_k = 8
sources = ["food", "recipe", "usda"]
```

**Ví dụ:** `"breakfast Vietnamese 400kcal"`

**Optimisation:** `EmbeddingService` cache kết quả embed theo query string → từ ngày 2 trở đi, cùng target + cuisine → cache hit, không gọi lại Voyage AI.

Kết quả trả về: danh sách tên món từ Food, Recipe, UsdaFood collections (đã lọc allergen + dietary preference).

### 4.2 Xây Dựng foodLookup

```
foodLookup: Map<name.toLowerCase(), { source_id, source_type }>
```

Map này dùng để sau khi LLM trả về `food_name`, tra cứu xem tên đó có trong DB không — trả về `source_id` thực tế.

### 4.3 LLM Prompt

Prompt gửi Groq gồm:
- Daily targets (calories, protein, carbs, fat)
- Danh sách bữa cần thiết
- Cooking style note (fresh vs batch)
- Candidates từng bữa: `"breakfast [target: 400kcal]: Cháo yến mạch; Bánh mì trứng; ..."`
- Anti-repeat: tên 6 món gần nhất đã dùng (rolling window 12 tên, trim mỗi 3 tên/ngày)
- Instruction: **chỉ copy tên từ candidate list, không được tự đặt tên mới**

Output yêu cầu: JSON thuần (không markdown), schema:
```json
{
  "meals": [
    { "meal_type": "breakfast", "food_name": "<exact>", "weight_grams": 150,
      "calories": 350, "protein": 15, "carbs": 45, "fat": 8 }
  ]
}
```

Validate bằng Zod `DayOutputSchema` (min 2 meals, max 6 meals).

### 4.4 Kiểm Tra Calorie Deviation

```
calDev = |dayTotals.calories - targets.calories| / targets.calories
```

Nếu `calDev > 35%` → **log warning nhưng vẫn chấp nhận** (không retry chỉ vì lệch calo). Business rule: không reject plan vì LLM estimate không chính xác — dữ liệu dinh dưỡng thực từ DB sẽ được dùng khi user xem chi tiết.

---

## 5. Fallback Mechanism — Khi LLM Phát Minh Tên

Sau khi nhận JSON từ LLM, với mỗi meal:

```
match = foodLookup.get(meal.food_name.toLowerCase())
```

**Nếu match tìm được** (`food_id` + `source_type` thực trong DB):
→ Dùng `match.source_id` làm `recipe_id` hoặc `food_id` trong MealPlanItem.

**Nếu không match** (LLM tự bịa tên không có trong candidate list):
→ Lấy `mealTypeCandidates.get(meal_type)[0]` — candidate đầu tiên (score cao nhất) của meal type đó.
→ Nếu không có candidate nào → bỏ qua bữa này (`continue`).

> **Tại sao không tạo Recipe mới?**  
> `_createSystemRecipe()` đã bị block (xem comment trong code). Recipes AI-generated không qua review sẽ corrupt vector index bằng dữ liệu hallucinated. Phải qua admin approval queue trước khi embed + serve.

---

## 6. Ghi Vào DB

### 6.1 Cấu trúc tạo ra mỗi lần generate

```
MealPlan (1 bản ghi)
    title: "Kế hoạch giảm cân 21 ngày"
    total_days, goal_type, is_public: false, is_approved: false

MealPlanItem (N bản ghi — mỗi bữa / mỗi ngày)
    meal_plan_id, day_number, meal_type
    recipe_id  (nếu nguồn là recipe)
    food_id    (nếu nguồn là food hoặc usda)
    source_type: "food" | "recipe" | "usda"
    serving_size (weight_grams từ LLM)
    sort_order

UserMealPlan (1 bản ghi)
    user_id, meal_plan_id
    start_date: Date.now()
    is_active: true
```

### 6.2 Source breakdown

Mỗi meal được track theo nguồn để log:
```
{ usda: N, recipe: N, food: N, ai_generated: N }
```

`ai_generated` tăng khi meal dùng fallback candidate nhưng `source_type` không rõ ràng. Log gửi vào `logRag()` sau khi generate xong.

---

## 7. Side Effects Sau Generate

### 7.1 Enrichment Queue

Sau khi hoàn tất tất cả ngày:
```ts
enrichment.queueRecipeEnrichment([...recipeIdsForEnrichment], { type: "meal_plan" })
```

Tất cả recipe IDs được dùng trong plan → queue để enrichment cron (chạy mỗi 10 phút) bổ sung `name_en` và `image_url` từ Unsplash. Đây là fire-and-forget (không block generate).

### 7.2 SSE Events Trả Về Client

| Event | Data | Thời điểm |
|---|---|---|
| `progress` | `{ current_day, total_days }` | Trước khi xử lý mỗi ngày |
| `day` | `{ day_number, plan: DayPlan }` | Sau khi xử lý xong một ngày |
| `done` | `{ meal_plan_id, days_generated, source_breakdown }` | Cuối cùng |
| `error` | `{ message }` | Nếu exception không catch được |

---

## 8. FoodSearchService — Chi Tiết Vector Search

### 8.1 Luồng search

```
FoodSearchService.search()
    ├─► RetrievalService.searchAll()   ← embed query → search Atlas/Qdrant
    ├─► _applyPreferenceFilter()       ← lọc allergen + dietary theo diet_tags
    ├─► _hydrateResults()              ← lấy full data từ MongoDB
    └─► side-effect: queueEnrichment() ← USDA score > 0.70, Recipe score > 0.65
```

### 8.2 Allergen filter (post-query)

Filter được áp dụng **sau** vector search (không filter trong index) vì Atlas vector filter cần exact tag match. Post-filter dựa trên `diet_tags` của từng result:

| Allergen | Tag bị loại |
|---|---|
| dairy | `contains-dairy` |
| gluten | `contains-gluten` |
| eggs | `contains-eggs` |
| shellfish | `contains-shellfish` |
| peanut / peanuts | `contains-peanut` |

Vegetarian: loại kết quả có tag `non-vegetarian`.

### 8.3 Enrichment trigger từ search

- USDA hit với `score > 0.70` và chưa import → `queueEnrichment()` (tạo Food document)
- Recipe hit với `score > 0.65` → `queueRecipeEnrichment()` (bổ sung name_en + image)

---

## 9. Business Rules Tổng Hợp

| Rule | Giá trị | Lý do |
|---|---|---|
| Max retry mỗi ngày | 3 | Tránh timeout 21 ngày |
| Temperature lần 1 / lần retry | 0.2 / 0.4 | Retry cần diversity hơn |
| Calorie deviation alert | > 35% | Log warning, không reject |
| Vector search top_k | 8 per meal type | Đủ diversity, không quá tốn |
| Fetch extra để post-filter | top_k + 5 | Bù cho allergen filter |
| Anti-repeat window | 12 tên (trim 3/ngày) | Tránh ăn lặp lại |
| Max meals per day | 6 (Zod schema) | Guard LLM output |
| SSE protocol | text/event-stream | Stream từng ngày, không block |
| Enrichment trigger | fire-and-forget | Không block generate |
| `_createSystemRecipe` | BLOCKED | Ngăn hallucinated data vào vector index |
| USDA enrich threshold | score > 0.70 | Chỉ import USDA có độ tin cậy cao |
| Recipe enrich threshold | score > 0.65 | Thấp hơn vì recipe thường match tốt hơn |

---

## 10. Điểm Có Thể Fail

| Vị trí | Nguyên nhân | Hành vi |
|---|---|---|
| Vector search trả 0 kết quả | Vector store rỗng / không có RecipeVector | Throw error, ngày đó bị skip |
| LLM JSON parse lỗi | Groq trả markdown hoặc truncate | Retry (tối đa 3 lần) |
| LLM tự đặt tên mới | Không match foodLookup | Dùng top candidate hoặc skip bữa |
| Enrichment queue fail | MongoDB lỗi | Log warning, không ảnh hưởng generate |
| Translation/Image fail trong enrichment | GROQ/Unsplash lỗi | Caught silently, job mark `skipped` (sau fix 2026-05-01) |
| `UserMealPlan` tạo trùng | Bug FE gọi 2 lần | Phải guard ở FE hoặc upsert ở BE |

---

## 11. File Quan Trọng

| File | Vai trò |
|---|---|
| `src/routes/rag/mealPlan.ts` | HTTP endpoint, SSE setup, rate limit |
| `src/services/rag/MealPlanGeneratorService.ts` | Toàn bộ business logic |
| `src/services/rag/FoodSearchService.ts` | Vector search + allergen filter |
| `src/services/rag/RetrievalService.ts` | Embed query → Atlas/Qdrant search |
| `src/services/rag/LLMService.ts` | Gọi Groq LLM |
| `src/services/rag/EnrichmentService.ts` | Queue recipe/USDA enrichment |
| `src/models/MealPlan.ts` | Bản ghi kế hoạch |
| `src/models/MealPlanItem.ts` | Bữa ăn từng ngày |
| `src/models/UserMealPlan.ts` | Liên kết user ↔ plan, is_active |
| `src/models/RecipeVector.ts` | Vector embedding của recipes |
