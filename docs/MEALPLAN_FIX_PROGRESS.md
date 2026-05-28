# Meal Plan Fix — Progress Tracker

**Started:** 2026-05-01  
**Spec:** `MEALPLAN_FIX_PLAN.md` + `MEALPLAN_FIX_CHECKLIST.md`

---

## Status Summary

| Task | Mô tả | Status |
|---|---|---|
| TASK 1 | MealPlanItem schema — thêm `usda_food_id` | 🔄 In progress |
| TASK 2 | EnrichmentService — public `processJob` + `input_foods` | ⏳ Pending |
| TASK 3 | FoodSearchService — hydrate UsdaFood đầy đủ | ⏳ Pending |
| TASK 4 | MealPlanGenerator — sync enrich USDA | ✅ Done |
| TASK 5 | Search query rich context | ✅ Done |
| TASK 6 | Notes field + Zod validation | ✅ Done |
| TASK 7 | Smoke test E2E | ⏳ Pending |
| TASK 8 | LLM Prompt rich | ✅ Done |
| TASK 9 | Cleanup | ⏳ Pending |

---

## TASK 1 — MealPlanItem schema ✅

**File:** `src/models/MealPlanItem.ts`

- [x] Thêm `usda_food_id?: Types.ObjectId` ref UsdaFood
- [x] Update interface `IMealPlanItem`
- [x] `source_type` enum thêm "ai_generated" (đã có sẵn, giữ nguyên)

**Ghi chú:** Field optional — không cần MongoDB migration, existing documents không ảnh hưởng.

---

## TASK 2 — EnrichmentService refactor ✅

**File:** `src/services/rag/EnrichmentService.ts`

- [x] `_processJob` → `processJob` (public)
- [x] Update `runWorker` caller sang `this.processJob`
- [x] Lưu `input_foods` vào `Food.notes`
- [x] Idempotency check trả `existingFood._id` nếu đã tồn tại
- [x] Return `Types.ObjectId | null` giữ nguyên

---

## TASK 3 — FoodSearchService hydrate UsdaFood ✅

**File:** `src/services/rag/FoodSearchService.ts`

- [x] Select thêm `portions`, `input_foods`, `wweia_category`, `wweia_category_code`
- [x] Thêm `portions` và `wweia_category` vào `FoodSearchResultItem` interface
- [x] WWEIA exclusion filter (Baby food, Infant formula, Supplements, Alcohol)

---

## TASK 4 — MealPlanGenerator sync enrich USDA ✅

**File:** `src/services/rag/MealPlanGeneratorService.ts`

- [x] Resolve `food_id` đúng khi `source_type === "usda"` 
- [x] Check Food tồn tại trước, nếu chưa → sync `processJob(fdc_id, false)`
- [x] Lưu `usda_food_id` vào MealPlanItem
- [x] Error handling + fallback (usda_food_id only)
- [x] `Promise.all` parallel enrich, cap 5

---

## TASK 5 — Search query rich context ✅

**File:** `src/services/rag/MealPlanGeneratorService.ts`

- [x] Add `cookingHint` theo `cooking_style`
- [x] Add `goalHint` theo `goal`
- [x] WWEIA exclusion filter trong `_generateDay`

---

## TASK 6 — Notes field + Zod ✅

**Files:** `MealPlanGeneratorService.ts`, `routes/rag/mealPlan.ts`

- [x] `preferences.notes?: string` trong interface
- [x] Zod: `notes: z.string().max(500).optional()`
- [x] Sanitize: trim + reject control chars

---

## TASK 7 — Smoke test E2E ⏳

Thực hiện sau khi TASK 8 xong.

---

## TASK 8 — LLM Prompt rich ✅

**File:** `src/services/rag/MealPlanGeneratorService.ts`

- [x] SYSTEM_ROLE + BUSINESS_RULES static constants
- [x] User context dynamic (goal, cooking_style, dietary, notes)
- [x] Macro target per meal section
- [x] Anti-repeat section
- [x] Candidates với portion hints từ UsdaFood
- [x] Output JSON schema

---

## TASK 9 — Cleanup ⏳

Sau khi smoke test.

---

## Build Errors / Issues

*(ghi lại nếu có trong quá trình implement)*

---

## Decisions Made

- `FoodSearchResultItem` thêm `portions` và `wweia_category` — không break existing callers vì optional
- Sync enrich dùng `fetchImage=false` để tránh block generation
- WWEIA exclusion hardcode list (Baby food, Infant formula, Alcohol, Supplements) — đủ cho MVP, Phase 2 có thể config
- `notes` sanitize control chars bằng regex (không dùng library) — đủ đơn giản
