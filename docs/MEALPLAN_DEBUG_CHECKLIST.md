# Meal Plan Generator — Debug Checklist

**Triệu chứng:** Generate xong nhưng "0 ngày · 0 kcal/ngày · 0 bữa ăn"
**Nguyên nhân gốc:** `_generateDay` throw ở cả 3 lần retry → ngày bị skip → `days.length = 0` → không emit `day` event → FE nhận `done` với `days_generated: 0`

---

## P0 — Blockers (gây ra 0 bữa ăn)

### [P0-1] Không có log chi tiết lý do thất bại ✅ CẦN SỬA
**File:** `src/services/rag/MealPlanGeneratorService.ts`  
**Vấn đề:** Retry loop chỉ log ở attempt thứ 3, không log attempt 1 & 2, không log tên lỗi cụ thể.  
**Hậu quả:** Hoàn toàn không biết `_generateDay` đang fail vì lý do gì.  
**Fix:** Log toàn bộ attempt với `console.error('[MealPlanGenerator] Day X attempt Y:', err.message)`.

### [P0-2] Calorie deviation check quá chặt ✅ CẦN SỬA
**File:** `src/services/rag/MealPlanGeneratorService.ts` line ~346  
**Vấn đề:** `if (calDev > 0.20)` throw nếu LLM ước tính lệch > 20%.  
**Hậu quả:** Khi vector store trống hoặc candidates không có `energy_kcal`, LLM tự ước tính. Tổng calo LLM tính không khớp chính xác với target → throw tất cả 3 retry → day bị skip.  
**Fix:** Nới lỏng lên `0.35` (35%). LLM không phải calculator, sai số là bình thường.

### [P0-3] `MealPlanItem.meal_type` enum thiếu `morning_snack` và `afternoon_snack` ✅ CẦN SỬA
**File:** `src/models/MealPlanItem.ts` line ~47  
**Vấn đề:** Schema enum chỉ có `["breakfast","lunch","dinner","snack"]`.  
**Hậu quả:** Khi `meals_per_day=5`, `itemsToInsert` chứa `morning_snack`/`afternoon_snack`. Mongoose `insertMany` throw validation error → toàn bộ ngày mất.  
**Fix:** Thêm `"morning_snack"` và `"afternoon_snack"` vào enum.

### [P0-4] Dead code `mealTypes` gây nhầm lẫn ✅ CẦN SỬA
**File:** `src/services/rag/MealPlanGeneratorService.ts` line ~257  
**Vấn đề:** `const mealTypes = ["breakfast","lunch","dinner","snack"] as const` — khai báo nhưng không dùng. Actual meal types lấy từ `mealConfig.types`.  
**Hậu quả:** Confusing khi đọc code, có thể gây bug nếu ai đó dùng nhầm biến này.  
**Fix:** Xóa dòng.

### [P0-5] Vector store trống → candidates rỗng → LLM không có dữ liệu
**File:** `src/services/rag/MealPlanGeneratorService.ts`  
**Vấn đề:** Nếu Qdrant/Atlas không có document nào (chưa embed), `FoodSearchService.search()` trả `[]`. Prompt gửi LLM có candidates rỗng. LLM tự sáng tác food names + calories.  
**Hậu quả kép:**
1. `foodLookup.get(inventedName)` → `undefined` → fallback path
2. `mealTypeCandidates.get(meal_type)?.[0]` → `undefined` (candidates empty) → `continue` → meal bị skip
3. Hoặc: tổng calories LLM tính lệch > 20% → throw → day bị skip
**Fix:** Log rõ khi `results.length === 0` per meal type. Nếu ALL meal types đều 0 candidates, skip ngày sớm với warning thay vì để LLM generate xong rồi fail.  
**Kiểm tra:** Chạy `npm run embed:foods` và `npm run embed:recipes` trước, kiểm tra vector store có data chưa.

---

## P1 — Logic Errors (data sai hoặc mất)

### [P1-1] Duplicate `UserMealPlan` khi bấm "Kích hoạt" ✅ CẦN SỬA
**File FE:** `src/pages/client/GenerateMealPlan.tsx` `handleActivate()`  
**File BE:** `src/services/rag/MealPlanGeneratorService.ts` lines ~230-235  
**Vấn đề:** `generate()` đã tự gọi `UserMealPlan.create()` (is_active: true). Sau đó FE bấm "Kích hoạt" gọi `api.post("/user-meal-plans", { meal_plan_id })` → tạo thêm bản ghi thứ 2.  
**Hậu quả:** User có 2 active UserMealPlan trỏ cùng một plan. `MealPlan.tsx` lấy bản đầu tiên, bản thứ 2 bị orphan.  
**Fix options:**  
- Option A (dễ): Xóa `UserMealPlan.create()` khỏi `generate()`, để FE làm việc đó khi user bấm "Kích hoạt".
- Option B: Giữ logic BE, xóa `handleActivate` ở FE, thay bằng navigate thẳng đến `/meal-plan` sau khi nhận `done` event (plan đã active sẵn).

### [P1-2] `FoodSearchService._hydrateResults` nuốt lỗi silently
**File:** `src/services/rag/FoodSearchService.ts` line ~192  
**Vấn đề:** `catch { /* Skip failed hydration */ }` — không log gì khi `findById` fail.  
**Hậu quả:** Nếu `source_id` từ vector store không map được sang MongoDB `_id` (e.g., ObjectId format mismatch), tất cả items bị drop → empty results → như P0-5.  
**Fix:** `catch (err) { console.warn('[FoodSearch] hydrate failed for', r.source_id, err.message); }`

### [P1-3] `candidatesByMeal` hiển thị `0kcal/100g` cho food không có energy data
**File:** `src/services/rag/MealPlanGeneratorService.ts` line ~282  
**Vấn đề:** `${r.energy_kcal ?? 0}kcal/100g` — nếu food không có energy_kcal, hiển thị `0kcal/100g`.  
**Hậu quả:** LLM thấy `Cơm trắng (0kcal/100g)` và không biết ước tính calo. Có thể output calorie = 0 → tổng ngày = 0kcal → `calDev = 100%` → throw.  
**Fix:** Bỏ fallback `?? 0`, dùng `r.energy_kcal ? `${r.energy_kcal}kcal/100g` : "unknown kcal"` để LLM biết tự ước tính.

### [P1-4] LLM prompt không nói rõ unit tính calo (per 100g vs per serving)
**File:** `src/services/rag/MealPlanGeneratorService.ts` prompt builder  
**Vấn đề:** Candidate list hiển thị `Xname (Xkcal/100g)` nhưng prompt yêu cầu LLM điền `calories` = tổng calo cho serving (weight_grams). LLM có thể nhầm lẫn giữa calories/100g và total calories.  
**Hậu quả:** LLM output `calories: 340` (kcal/100g) nhưng thực ra serving là 200g → total nên là 680kcal. Tổng ngày sẽ sai.  
**Fix:** Thêm chú thích rõ trong prompt: `Note: calories/protein/carbs/fat fields must be TOTAL for the given weight_grams, not per 100g.`

### [P1-5] `maxTokens: 800` có thể cắt response cho 5 bữa
**File:** `src/services/rag/MealPlanGeneratorService.ts` line ~327  
**Vấn đề:** Với `meals_per_day=5`, output JSON cần ~300-400 tokens. 800 đủ nhưng nếu LLM thêm giải thích trước JSON (không tuân thủ "no markdown"), response bị cắt → JSON parse error → throw.  
**Fix:** Tăng lên `1200` để an toàn.

---

## P2 — Code Quality

### [P2-1] `generate()` log lỗi nhưng không log context đầy đủ
**File:** `src/services/rag/MealPlanGeneratorService.ts` line ~159  
**Vấn đề:** `console.error('[MealPlanGenerator] Day X failed after 3 attempts:', err)` — không log userId, goal, meals_per_day.  
**Fix:** Thêm context: `console.error('[MealPlanGenerator]', { day, userId: req.userId, goal: req.goal, mealsPerDay: req.meals_per_day }, 'failed after 3 attempts:', err.message)`.

### [P2-2] `itemsToInsert` có thể là `[]` mà không có cảnh báo
**File:** `src/services/rag/MealPlanGeneratorService.ts` line ~219  
**Vấn đề:** `MealPlanItem.insertMany([])` succeeds nhưng không insert gì. Ngày được ghi vào `days[]` nhưng không có items trong DB.  
**Fix:** Trước `insertMany`, check `if (itemsToInsert.length === 0) { console.warn('[MealPlanGenerator] Day X: 0 items to insert (all meals skipped)'); continue; }`

### [P2-3] Unused import / unused variable `mealTypes`
**File:** `src/services/rag/MealPlanGeneratorService.ts` line 257  
**Fix:** Xóa `const mealTypes = ...` (đã khai báo, không dùng).

---

## Checklist kiểm tra trước khi generate

```
[ ] npm run embed:foods    → kiểm tra output "N foods embedded"
[ ] npm run embed:recipes  → kiểm tra output "N recipes embedded"
[ ] Atlas UI → foodvectors collection có documents chưa
[ ] Atlas UI → recipevectors collection có documents chưa
[ ] Atlas UI → usdafoods collection có documents chưa (nếu đã ingest)
[ ] BE logs trong khi generate: có thấy "[MealPlanGenerator] Day 1 attempt 1:" không
[ ] Nếu thấy "calorie deviation too high": loosen check P0-2
[ ] Nếu thấy "no DB candidate, skipping meal": vector store trống → P0-5
```

---

## Thứ tự fix đề xuất

1. **P0-1** — Thêm logging đầy đủ (không mất gì, gain toàn bộ visibility)
2. **P0-4** — Xóa dead code `mealTypes`
3. **P0-2** — Nới calorie deviation check lên 35%
4. **P1-3** — Fix `0kcal/100g` display
5. **P1-4** — Thêm note unit vào prompt
6. **P1-5** — Tăng maxTokens lên 1200
7. **P0-3** — Thêm `morning_snack`/`afternoon_snack` vào MealPlanItem enum
8. **P1-1** — Fix duplicate UserMealPlan creation
9. **P1-2** — Thêm log vào `_hydrateResults`
10. **P2-2** — Log khi `itemsToInsert` empty
11. **P0-5** — Kiểm tra & embed data vào vector store (infra task)
