# Qdrant Migration Guide

## Lý do cần migrate

MongoDB Atlas M0 (free tier) chỉ cho **3 Atlas Vector Search indexes** tối đa.  
Hiện tại đã dùng cả 3:
- `foodvectors` (foods)
- `recipevectors` (recipes)  
- `usdafoods` (USDA)

Không thể thêm collection/index mới. Qdrant Cloud có free tier không giới hạn số collection.

---

## Kiến trúc sau migrate

```
MongoDB Atlas (giữ nguyên)          Qdrant Cloud
────────────────────────────         ────────────────────────
foods, recipes, usdafoods       →    foodvectors (collection)
chat_sessions, meal_plans       →    recipevectors (collection)
enrichment_queue, ...           →    usdafoods (collection)
                                     (thêm collection mới thoải mái)

Text search ($text)     → vẫn dùng MongoDB
Vector search           → chuyển sang Qdrant
```

---

## Checklist setup Qdrant Cloud

### Bước 1: Tạo cluster Qdrant
- [ ] Vào https://cloud.qdrant.io → Sign up / Login
- [ ] "Create Cluster" → chọn **Free tier** (1GB, 1 node)
- [ ] Chọn region gần nhất (Singapore hoặc US East)
- [ ] Đặt tên: `calocare`
- [ ] Copy **Cluster URL** (dạng `https://xxxx.qdrant.io`)
- [ ] "API Keys" → tạo key → copy **API Key**

### Bước 2: Thêm env vars
```env
# .env
VECTOR_STORE=qdrant
QDRANT_URL=https://xxxx.qdrant.io
QDRANT_API_KEY=your-api-key-here
```
> **Lưu ý:** Đổi `VECTOR_STORE=qdrant` là đủ để code tự dùng `QdrantVectorStore` — đã có sẵn trong `VectorStoreService.ts`.

### Bước 3: Cài package
```bash
cd calocare-BE
npm install @qdrant/js-client-rest
```

---

## Checklist fix code trước khi embed

### [Q1] ✅ FIX: ObjectId string không hợp lệ làm Qdrant point ID
**File:** `src/services/rag/QdrantVectorStore.ts`  
**Vấn đề:** Qdrant yêu cầu point ID là **uint64** hoặc **UUID**. MongoDB ObjectId là hex string 24 ký tự (`507f1f77bcf86cd799439011`) → không hợp lệ → `upsert` sẽ throw.

**Fix:** Convert ObjectId hex → UUID v5 (deterministic):
```typescript
import { createHash } from "crypto";

function objectIdToUuid(objectId: string): string {
    // Convert 24-char hex ObjectId to a UUID-format string (deterministic)
    const padded = objectId.padEnd(32, "0");
    return [
        padded.slice(0, 8),
        padded.slice(8, 12),
        "4" + padded.slice(13, 16),  // version 4 format
        "8" + padded.slice(17, 20),  // variant bits
        padded.slice(20, 32),
    ].join("-");
}
```

Dùng trong `upsert`:
```typescript
points: items.map((item) => ({
    id: objectIdToUuid(item.id),   // ← convert
    vector: item.vector,
    payload: { ...item.payload, original_id: item.id },  // giữ original_id trong payload
})),
```

Và trong `query`, map ngược lại:
```typescript
return results.map((r) => ({
    id: (r.payload?.original_id as string) ?? String(r.id),  // ← dùng original_id
    score: r.score,
    payload: r.payload as Record<string, unknown>,
}));
```

### [Q2] ✅ FIX: `ensureCollection` cần gọi trước khi embed
**File:** `src/services/rag/QdrantVectorStore.ts`  
**Vấn đề:** Nếu collection chưa tồn tại và `upsert` được gọi trước `ensureCollection`, Qdrant throw "collection not found".  
**Fix:** Trong embed scripts, gọi `await store.ensureCollection(name, 1024)` trước `upsert`. Kiểm tra các file:
- [ ] `scripts/embed-existing-foods.ts` — có gọi `ensureCollection` không?
- [ ] `scripts/embed-existing-recipes.ts` — có gọi `ensureCollection` không?
- [ ] `scripts/ingest-usda.ts` — có gọi `ensureCollection` không?

### [Q3] Kiểm tra Qdrant filter syntax khác Atlas
**File:** `src/services/rag/QdrantVectorStore.ts` method `_buildFilter`  
**Atlas filter syntax:** `{ diet_tags: ["vegetarian"] }` → Atlas: `{ "diet_tags": { "$in": [...] } }`  
**Qdrant filter syntax:** `{ must: [{ key: "diet_tags", match: { any: [...] } }] }`  
**Status:** `_buildFilter` đã handle đúng với Qdrant format. ✓

---

## Checklist re-embed sau setup

```bash
# Đảm bảo .env đã có VECTOR_STORE=qdrant + QDRANT_URL + QDRANT_API_KEY

# 1. Embed foods
npm run embed:foods
# Verify: log "N foods embedded" không có error

# 2. Embed recipes  
npm run embed:recipes
# Verify: log "N recipes embedded"

# 3. (Optional) Ingest USDA nếu chưa có
npm run ingest:usda
# Chú ý: script này chạy ~107 phút, nên chạy qua screen/tmux

# 4. Kiểm tra Qdrant UI
# Vào https://cloud.qdrant.io → cluster → Collections
# ✓ foodvectors: N points
# ✓ recipevectors: N points  
# ✓ usdafoods: N points (nếu đã ingest)
```

---

## Checklist verify sau migrate

```
[ ] Search food hoạt động: POST /api/rag/search-food → trả kết quả
[ ] Meal plan generate: không còn "0 candidates from vector search"
[ ] Scanner: POST /api/rag/scan-food → trả matched = true
[ ] Chatbot: search_food_knowledge tool trả về data thật
[ ] Log không có "Qdrant" error
```

---

## Rollback

Chỉ cần đổi lại `.env`:
```env
VECTOR_STORE=atlas   # hoặc xóa dòng này (atlas là default)
```
Data trong MongoDB Atlas vector search vẫn còn nguyên.

---

## So sánh Atlas M0 vs Qdrant Free

| | Atlas M0 | Qdrant Cloud Free |
|---|---|---|
| Vector indexes | **3 max** | Không giới hạn |
| Storage | 512MB | 1GB |
| Dims tối đa | 2048 | 65535 |
| Hybrid search | Cần text index riêng | Built-in |
| Filter | Atlas filter syntax | Qdrant filter syntax |
| Code đã sẵn sàng | ✓ | ✓ (`QdrantVectorStore.ts`) |
