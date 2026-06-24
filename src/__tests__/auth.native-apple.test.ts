import request from "supertest";
import express from "express";

jest.mock("passport", () => ({
  __esModule: true,
  default: {
    authenticate: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  },
}));

jest.mock("../utils/jwt", () => ({
  generateAccessToken: jest.fn(() => "access-token"),
  generateRefreshToken: jest.fn(() => "refresh-token"),
  verifyRefreshToken: jest.fn(),
}));

jest.mock("../utils/subscriptionEntitlements", () => ({
  downgradeExpiredUserSubscription: jest.fn(async () => undefined),
}));

jest.mock("../services/nativeIdentityService", () => ({
  NativeIdentityError: class NativeIdentityError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  },
  verifyNativeAppleIdentity: jest.fn(),
  verifyNativeGoogleIdentity: jest.fn(),
  exchangeAppleAuthorizationCode: jest.fn(async () => undefined),
  encryptAppleRefreshToken: jest.fn((value: string) => `encrypted:${value}`),
  revokeAppleRefreshToken: jest.fn(async () => undefined),
}));

jest.mock("../models/User", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));
jest.mock("../models/ChatSession", () => ({ __esModule: true, default: {} }));
jest.mock("../models/FoodDiary", () => ({ __esModule: true, default: {} }));
jest.mock("../models/MealProgress", () => ({ __esModule: true, default: {} }));
jest.mock("../models/PaymentTransaction", () => ({ __esModule: true, default: {} }));
jest.mock("../models/ReportDigest", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Review", () => ({ __esModule: true, default: { aggregate: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn(), find: jest.fn() } }));
jest.mock("../models/Referral", () => ({ __esModule: true, default: {} }));
jest.mock("../models/UserFavorite", () => ({ __esModule: true, default: {} }));
jest.mock("../models/UserMealPlan", () => ({ __esModule: true, default: {} }));
jest.mock("../models/UserMealPlanItem", () => ({ __esModule: true, default: {} }));
jest.mock("../models/MealPlan", () => ({ __esModule: true, default: {} }));
jest.mock("../models/MealPlanItem", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Store", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Recipe", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Food", () => ({ __esModule: true, default: {} }));
jest.mock("../models/EnrichmentQueue", () => ({ __esModule: true, default: {} }));
jest.mock("../models/FamilyGroup", () => ({ __esModule: true, default: {} }));

import authRouter from "../routes/auth";
import UserModel from "../models/User";
import {
  verifyNativeAppleIdentity,
  exchangeAppleAuthorizationCode,
} from "../services/nativeIdentityService";

const User = UserModel as any;
const verifyApple = verifyNativeAppleIdentity as jest.Mock;
const exchangeCode = exchangeAppleAuthorizationCode as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  return app;
}

describe("POST /api/auth/native/apple", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findByIdAndUpdate.mockResolvedValue(undefined);
    exchangeCode.mockResolvedValue(undefined);
  });

  it("creates a user from native Apple credential email when the identity token omits email", async () => {
    verifyApple.mockResolvedValue({ subject: "apple-user-123" });
    User.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    User.create.mockResolvedValue({
      _id: { toString: () => "user-1" },
      email: "first@privaterelay.appleid.com",
      display_name: "Nguyen Manh Huynh",
      avatar_url: undefined,
      role: "user",
      subscription_tier: "free",
      subscription_expires_at: null,
      is_banned: false,
      language: "vi",
      daily_nutrition_goals: {},
      preferences: {},
      created_at: new Date("2026-06-24T00:00:00.000Z"),
    });

    const res = await request(buildApp())
      .post("/api/auth/native/apple")
      .send({
        identity_token: "token",
        authorization_code: "auth-code",
        email: "First@PrivateRelay.AppleID.com",
        full_name: "Nguyen Manh Huynh",
      });

    expect(res.status).toBe(200);
    expect(User.findOne).toHaveBeenNthCalledWith(1, { apple_id: "apple-user-123" });
    expect(User.findOne).toHaveBeenNthCalledWith(2, { email: "first@privaterelay.appleid.com" });
    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "first@privaterelay.appleid.com",
        apple_id: "apple-user-123",
        display_name: "Nguyen Manh Huynh",
      }),
    );
    expect(res.body.access_token).toBe("access-token");
    expect(res.body.refresh_token).toBe("refresh-token");
  });

  it("returns a clear remediation message when Apple provides no email at all", async () => {
    verifyApple.mockResolvedValue({ subject: "apple-user-123" });
    User.findOne.mockResolvedValue(null);

    const res = await request(buildApp())
      .post("/api/auth/native/apple")
      .send({
        identity_token: "token",
        authorization_code: "auth-code",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("apple_email_required");
    expect(res.body.message).toContain("stop using Apple ID");
  });
});
