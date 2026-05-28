import request from "supertest";
import express from "express";

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock("../middleware/auth", () => ({
  authenticate: jest.fn((req: any, _res: any, next: any) => {
    req.user = { _id: "adminid001", role: "admin", subscription_tier: "premium" };
    next();
  }),
  optionalAuthenticate: jest.fn((_r: any, _res: any, next: any) => next()),
}));

jest.mock("../middleware/roleCheck", () => ({
  requireAdminOrModerator: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock("../models/Food", () => ({ __esModule: true, default: { find: jest.fn(), countDocuments: jest.fn(), findByIdAndUpdate: jest.fn() } }));
jest.mock("../models/FoodVector", () => ({ __esModule: true, default: { updateOne: jest.fn(), deleteOne: jest.fn() } }));
jest.mock("../models/Recipe", () => ({ __esModule: true, default: { find: jest.fn(), countDocuments: jest.fn(), findByIdAndUpdate: jest.fn() } }));
jest.mock("../models/RecipeVector", () => ({ __esModule: true, default: { updateOne: jest.fn(), deleteOne: jest.fn() } }));
jest.mock("../models/EnrichmentQueue", () => ({ __esModule: true, default: { find: jest.fn(), countDocuments: jest.fn() } }));

const mockRunImageBackfill = jest.fn();
const mockRunStaleRefresh = jest.fn();

jest.mock("../services/rag/EnrichmentService", () => ({
  getEnrichmentService: jest.fn(() => ({
    runImageBackfill: mockRunImageBackfill,
    runStaleRefresh: mockRunStaleRefresh,
    runWorker: jest.fn(),
  })),
}));

import adminRagRouter from "../routes/admin/rag";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/rag", adminRagRouter);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/admin/rag/image-backfill", () => {
  it("calls runImageBackfill and returns queued counts", async () => {
    mockRunImageBackfill.mockResolvedValue({ recipes: 12, foods: 8 });

    const res = await request(buildApp()).post("/api/admin/rag/image-backfill");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.queued).toEqual({ recipes: 12, foods: 8 });
    expect(mockRunImageBackfill).toHaveBeenCalledWith(50); // default batch size
  });

  it("respects custom batch query param", async () => {
    mockRunImageBackfill.mockResolvedValue({ recipes: 5, foods: 3 });

    await request(buildApp()).post("/api/admin/rag/image-backfill?batch=100");

    expect(mockRunImageBackfill).toHaveBeenCalledWith(100);
  });

  it("caps batch at 500", async () => {
    mockRunImageBackfill.mockResolvedValue({ recipes: 0, foods: 0 });

    await request(buildApp()).post("/api/admin/rag/image-backfill?batch=9999");

    expect(mockRunImageBackfill).toHaveBeenCalledWith(500);
  });
});

describe("POST /api/admin/rag/stale-refresh", () => {
  it("calls runStaleRefresh and returns requeued count", async () => {
    mockRunStaleRefresh.mockResolvedValue(47);

    const res = await request(buildApp()).post("/api/admin/rag/stale-refresh");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.requeued).toBe(47);
    expect(mockRunStaleRefresh).toHaveBeenCalledWith(90); // default staleDays
  });

  it("respects custom days query param", async () => {
    mockRunStaleRefresh.mockResolvedValue(10);

    await request(buildApp()).post("/api/admin/rag/stale-refresh?days=30");

    expect(mockRunStaleRefresh).toHaveBeenCalledWith(30);
  });

  it("caps staleDays at 365", async () => {
    mockRunStaleRefresh.mockResolvedValue(0);

    await request(buildApp()).post("/api/admin/rag/stale-refresh?days=9000");

    expect(mockRunStaleRefresh).toHaveBeenCalledWith(365);
  });
});
