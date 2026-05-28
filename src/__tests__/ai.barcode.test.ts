import request from "supertest";
import express from "express";

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock("../middleware/auth", () => ({
  authenticate: jest.fn((_req: any, _res: any, next: any) => next()),
  optionalAuthenticate: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock("../middleware/ragRateLimit", () => ({
  ragRateLimit: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock("../models/Food", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../services/rag/ScannerService", () => ({
  getScannerService: jest.fn(() => ({
    scan: jest.fn(),
    scanMulti: jest.fn(),
  })),
}));

jest.mock("../services/rag/FatSecretService", () => ({
  getFatSecretService: jest.fn(() => ({
    findByBarcode: jest.fn(),
  })),
}));

jest.mock("../utils/logger", () => ({
  logRag: jest.fn(),
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock("axios");

import axiosMock from "axios";
import aiRouter from "../routes/ai";
import FoodModel from "../models/Food";
import { getFatSecretService } from "../services/rag/FatSecretService";

const axios = axiosMock as jest.Mocked<typeof axiosMock>;
const Food = FoodModel as any;
const fatSecretService = getFatSecretService() as any;

function mockQuery(value: any) {
  const q: any = {};
  for (const m of ["select", "lean"]) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.lean = jest.fn().mockResolvedValue(value);
  return q;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", aiRouter);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/ai/barcode/:barcode", () => {
  it("returns 400 for barcode shorter than 8 digits", async () => {
    const res = await request(buildApp()).get("/api/ai/barcode/123");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid barcode/);
  });

  it("returns 400 for barcode with non-numeric characters", async () => {
    const res = await request(buildApp()).get("/api/ai/barcode/8935001A0");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid barcode/);
  });

  it("returns food from local DB when found (source: local)", async () => {
    Food.findOne.mockReturnValue(
      mockQuery({
        name_vi: "Bánh mì sandwich",
        name_en: "Sandwich bread",
        energy_kcal: 265,
        protein: 9,
        glucid: 49,
        lipid: 3.2,
      })
    );

    const res = await request(buildApp()).get("/api/ai/barcode/8935001234567");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("local");
    expect(res.body.name).toBe("Bánh mì sandwich");
    expect(res.body.per_100g.calories).toBe(265);
    expect(Food.findOne).toHaveBeenCalledWith({ code: "8935001234567", is_approved: true });
  });

  it("falls through to Open Food Facts when not in local DB", async () => {
    Food.findOne.mockReturnValue(mockQuery(null));
    (axios.get as jest.Mock).mockResolvedValueOnce({
      data: {
        product: {
          product_name: "Coca-Cola 330ml",
          product_name_vi: "Coca-Cola",
          nutriments: {
            "energy-kcal_100g": 42,
            proteins_100g: 0,
            carbohydrates_100g: 10.6,
            fat_100g: 0,
          },
        },
      },
    });

    const res = await request(buildApp()).get("/api/ai/barcode/05000112637939");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("open_food_facts");
    expect(res.body.name).toBe("Coca-Cola");
    expect(res.body.per_100g.calories).toBe(42);
    expect(res.body.per_100g.carbs).toBeCloseTo(10.6);
  });

  it("returns 404 when not found in any source", async () => {
    Food.findOne.mockReturnValue(mockQuery(null));
    (axios.get as jest.Mock).mockResolvedValueOnce({ data: { product: null } });
    fatSecretService.findByBarcode.mockResolvedValueOnce(null);

    const res = await request(buildApp()).get("/api/ai/barcode/00000000000000");

    expect(res.status).toBe(404);
  });

  it("accepts valid 8-digit EAN-8 barcode", async () => {
    Food.findOne.mockReturnValue(mockQuery({ name_vi: "Test", energy_kcal: 100, protein: 5, glucid: 10, lipid: 2 }));
    const res = await request(buildApp()).get("/api/ai/barcode/12345678");
    expect(res.status).toBe(200);
  });

  it("accepts valid 13-digit EAN-13 barcode", async () => {
    Food.findOne.mockReturnValue(mockQuery({ name_vi: "Test", energy_kcal: 100, protein: 5, glucid: 10, lipid: 2 }));
    const res = await request(buildApp()).get("/api/ai/barcode/1234567890123");
    expect(res.status).toBe(200);
  });
});
