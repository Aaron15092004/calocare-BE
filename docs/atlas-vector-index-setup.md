# Atlas Vector Search Index Setup

Sau khi chu1ea1y script ingest, tu1ea1o 3 vector indexes nu00e0y trong Atlas UI:
**Cluster u2192 Collections u2192 Atlas Search u2192 Create Search Index u2192 JSON Editor**

---

## 1. Collection `usda_foods`

Index name: `vector_index`

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "diet_tags"
    },
    {
      "type": "filter",
      "path": "wweia_category"
    },
    {
      "type": "filter",
      "path": "imported_to_foods"
    }
  ]
}
```

---

## 2. Collection `food_vectors`

Index name: `vector_index`

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "diet_tags"
    },
    {
      "type": "filter",
      "path": "is_approved"
    }
  ]
}
```

---

## 3. Collection `recipe_vectors`

Index name: `vector_index`

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "diet_tags"
    },
    {
      "type": "filter",
      "path": "is_approved"
    }
  ]
}
```

---

## Lu01b0u u00fd quan tru1ecdng

- Atlas M0 free tier chu1ec9 hu1ed7 tru1ee3 **1 vector search index**. Nu1ebfu cu1ea7n 3 indexes, nu00e2ng lu00ean **Atlas Flex** (pay-as-you-go, ~$0.08/h).
- Index type phu1ea3i lu00e0 **`vectorSearch`**, khu00f4ng phu1ea3i `search`.
- Sau khi tu1ea1o index, chu1edd 2-5 phu00fat u0111u1ec3 index build xong tru01b0u1edbc khi chu1ea1y query.
- Kiu1ec3m tra tru1ea1ng thu00e1i index: **Atlas UI u2192 Atlas Search u2192 Status = Active**.

## Kiu1ec3m tra nhanh

```js
// MongoDB Compass Aggregation hoặc mongosh
db.usda_foods.aggregate([
  {
    $vectorSearch: {
      index: "vector_index",
      path: "embedding",
      queryVector: Array(1024).fill(0.1), // placeholder vector
      numCandidates: 10,
      limit: 3
    }
  },
  { $project: { description_en: 1, score: { $meta: "vectorSearchScore" } } }
])
```
