import request from "supertest";
import express from "express";

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock("../middleware/auth", () => ({
  authenticate: jest.fn((req: any, _res: any, next: any) => {
    req.user = {
      _id: { toString: () => "aaaaaaaaaaaaaaaaaaaaaaaa" },
      display_name: "Widget Tester",
      subscription_tier: "premium",
    };
    next();
  }),
  optionalAuthenticate: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock("../models/FoodDiary", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

jest.mock("../models/User", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

import widgetRouter from "../routes/widget";
import FoodDiaryModel from "../models/FoodDiary";
import UserModel from "../models/User";

const FoodDiary = FoodDiaryModel as any;
const User = UserModel as any;

function mockQuery(value: any) {
  const q: any = {};
  for (const m of ["select", "sort", "limit", "lean"]) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.lean = jest.fn().mockResolvedValue(value);
  return q;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/widget", widgetRouter);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/widget/daily-summary", () => {
  it("returns correct calorie math from diary entries", async () => {
    FoodDiary.find.mockReturnValue(
      mockQuery([
        { calories: 400, protein: 30, carbs: 50, fat: 10 },
        { calories: 600, protein: 20, carbs: 80, fat: 15 },
      ])
    );
    User.findById.mockReturnValue(
      mockQuery({
        display_name: "Widget Tester",
        daily_nutrition_goals: { calories: 2000, protein: 120, carbs: 250, fat: 65 },
      })
    );

    const res = await request(buildApp()).get("/api/widget/daily-summary");

    expect(res.status).toBe(200);
    expect(res.body.calories_consumed).toBe(1000);
    expect(res.body.calories_remaining).toBe(1000);
    expect(res.body.calorie_pct).toBe(50);
    expect(res.body.macros.protein.consumed).toBe(50);
    expect(res.body.macros.carbs.consumed).toBe(130);
    expect(res.body.macros.fat.consumed).toBe(25);
  });

  it("uses default goals when user has no custom goals", async () => {
    FoodDiary.find.mockReturnValue(mockQuery([]));
    User.findById.mockReturnValue(
      mockQuery({ display_name: "No Goals", daily_nutrition_goals: {} })
    );

    const res = await request(buildApp()).get("/api/widget/daily-summary");

    expect(res.status).toBe(200);
    expect(res.body.calorie_goal).toBe(2000);
    expect(res.body.macros.protein.goal).toBe(120);
    expect(res.body.macros.carbs.goal).toBe(250);
    expect(res.body.macros.fat.goal).toBe(65);
  });

  it("clamps calories_remaining to 0 when over goal", async () => {
    FoodDiary.find.mockReturnValue(
      mockQuery([{ calories: 2500, protein: 0, carbs: 0, fat: 0 }])
    );
    User.findById.mockReturnValue(
      mockQuery({ display_name: "Over", daily_nutrition_goals: { calories: 2000 } })
    );

    const res = await request(buildApp()).get("/api/widget/daily-summary");

    expect(res.status).toBe(200);
    expect(res.body.calories_remaining).toBe(0);
    expect(res.body.calorie_pct).toBe(100);
  });

  it("returns zero consumed values when no diary entries today", async () => {
    FoodDiary.find.mockReturnValue(mockQuery([]));
    User.findById.mockReturnValue(
      mockQuery({ display_name: "Empty Day", daily_nutrition_goals: { calories: 1800 } })
    );

    const res = await request(buildApp()).get("/api/widget/daily-summary");

    expect(res.status).toBe(200);
    expect(res.body.calories_consumed).toBe(0);
    expect(res.body.calorie_pct).toBe(0);
    expect(res.body.macros.protein.consumed).toBe(0);
  });

  it("response includes required widget fields", async () => {
    FoodDiary.find.mockReturnValue(mockQuery([]));
    User.findById.mockReturnValue(mockQuery({ display_name: "Fields Test", daily_nutrition_goals: {} }));

    const res = await request(buildApp()).get("/api/widget/daily-summary");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("date");
    expect(res.body).toHaveProperty("display_name");
    expect(res.body).toHaveProperty("calorie_goal");
    expect(res.body).toHaveProperty("calories_consumed");
    expect(res.body).toHaveProperty("calories_remaining");
    expect(res.body).toHaveProperty("calorie_pct");
    expect(res.body.macros).toHaveProperty("protein");
    expect(res.body.macros).toHaveProperty("carbs");
    expect(res.body.macros).toHaveProperty("fat");
  });

  it("date field is a valid YYYY-MM-DD string", async () => {
    FoodDiary.find.mockReturnValue(mockQuery([]));
    User.findById.mockReturnValue(mockQuery({ display_name: "Date Test", daily_nutrition_goals: {} }));

    const res = await request(buildApp()).get("/api/widget/daily-summary");

    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
