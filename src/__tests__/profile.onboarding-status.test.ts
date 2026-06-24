import request from "supertest";
import express from "express";

jest.mock("../middleware/auth", () => ({
  authenticate: jest.fn((req: any, _res: any, next: any) => {
    req.user = {
      _id: "user-1",
      email: "tester@example.com",
      display_name: "Tester",
      avatar_url: undefined,
      role: "user",
      subscription_tier: "free",
      subscription_expires_at: null,
      is_banned: false,
      language: "vi",
      daily_nutrition_goals: { calories: 2100 },
      preferences: {
        age: 28,
        gender: "male",
        height_cm: 175,
        weight_kg: 72,
        activity_level: "moderate",
        goal: "maintain",
      },
      created_at: new Date("2026-06-24T00:00:00.000Z"),
    };
    next();
  }),
}));

jest.mock("../models/User", () => ({
  __esModule: true,
  default: {
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../services/CloudinaryService", () => ({
  uploadBuffer: jest.fn(),
}));

import profileRouter from "../routes/profile";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/profile", profileRouter);
  return app;
}

describe("GET /api/profile onboarding status", () => {
  it("treats legacy completed profiles as onboarded even without the explicit flag", async () => {
    const res = await request(buildApp()).get("/api/profile");

    expect(res.status).toBe(200);
    expect(res.body.onboarding_completed).toBe(true);
  });
});
