import request from "supertest";
import express from "express";

// ── Mocks must be declared before importing the route ──────────────────────
jest.mock("../middleware/auth", () => ({
  authenticate: jest.fn((req: any, _res: any, next: any) => {
    req.user = {
      _id: { toString: () => "aaaaaaaaaaaaaaaaaaaaaaaa" },
      email: "test@calocare.app",
      display_name: "Test User",
      subscription_tier: "premium",
      subscription_expires_at: new Date("2027-01-01"),
      referral_code: "MYCODE11",
      role: "user",
    };
    next();
  }),
  optionalAuthenticate: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock("../models/User", () => ({
  __esModule: true,
  default: { findById: jest.fn(), findOne: jest.fn(), findByIdAndUpdate: jest.fn(), exists: jest.fn() },
}));

jest.mock("../models/Referral", () => ({
  __esModule: true,
  default: { countDocuments: jest.fn(), find: jest.fn(), exists: jest.fn(), create: jest.fn() },
}));

// ── Imports after mocks ────────────────────────────────────────────────────
import referralsRouter from "../routes/referrals";
import UserModel from "../models/User";
import ReferralModel from "../models/Referral";

const User = UserModel as any;
const Referral = ReferralModel as any;

// ── Helpers ────────────────────────────────────────────────────────────────
/** Creates a fake chainable Mongoose query that resolves lean() with `value`. */
function mockQuery(value: any) {
  const q: any = {};
  for (const m of ["select", "sort", "limit", "skip", "populate", "exec"]) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.lean = jest.fn().mockResolvedValue(value);
  return q;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/referrals", referralsRouter);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/referrals/my-code", () => {
  it("returns existing code with stats", async () => {
    User.findById.mockReturnValue(mockQuery({ referral_code: "MYCODE11" }));
    Referral.countDocuments.mockResolvedValue(3);
    Referral.find.mockReturnValue(mockQuery([]));

    const res = await request(buildApp()).get("/api/referrals/my-code");

    expect(res.status).toBe(200);
    expect(res.body.code).toBe("MYCODE11");
    expect(res.body.total_referrals).toBe(3);
    expect(res.body.bonus_days_earned).toBe(90); // 3 × 30
    expect(res.body.referral_url).toContain("MYCODE11");
    expect(res.body.referrer_bonus_days).toBe(30);
    expect(res.body.referee_bonus_days).toBe(7);
  });

  it("generates a new code when user has none and saves it", async () => {
    User.findById.mockReturnValue(mockQuery({ referral_code: undefined }));
    User.exists.mockResolvedValue(null);
    User.findByIdAndUpdate.mockResolvedValue({});
    Referral.countDocuments.mockResolvedValue(0);
    Referral.find.mockReturnValue(mockQuery([]));

    const res = await request(buildApp()).get("/api/referrals/my-code");

    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[A-F0-9]{8}$/);
    expect(User.findByIdAndUpdate).toHaveBeenCalled();
  });

  it("returns 401 when no auth token provided", async () => {
    const { authenticate } = require("../middleware/auth");
    authenticate.mockImplementationOnce((_req: any, res: any) => {
      res.status(401).json({ error: "Unauthorized" });
    });

    const res = await request(buildApp()).get("/api/referrals/my-code");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/referrals/apply", () => {
  const REFERRER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(() => {
    Referral.exists.mockResolvedValue(null);
    User.findOne.mockReturnValue(
      mockQuery({
        _id: REFERRER_ID,
        subscription_tier: "premium",
        subscription_expires_at: new Date("2027-01-01"),
      })
    );
    User.findByIdAndUpdate.mockResolvedValue({});
    User.findById.mockReturnValue(
      mockQuery({ subscription_tier: "free", subscription_expires_at: undefined })
    );
    Referral.create.mockResolvedValue({});
  });

  it("applies a valid code — 200 with bonus days", async () => {
    const res = await request(buildApp())
      .post("/api/referrals/apply")
      .send({ code: "OTHERXXX" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.referee_bonus_days).toBe(7);
    expect(res.body.referrer_bonus_days).toBe(30);
    expect(Referral.create).toHaveBeenCalledWith(
      expect.objectContaining({ code: "OTHERXXX" })
    );
  });

  it("400 — cannot apply own code", async () => {
    const res = await request(buildApp())
      .post("/api/referrals/apply")
      .send({ code: "MYCODE11" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chính mình/);
  });

  it("400 — already applied a referral code before", async () => {
    Referral.exists.mockResolvedValue({ _id: "existing" });

    const res = await request(buildApp())
      .post("/api/referrals/apply")
      .send({ code: "AAABBBCC" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/đã sử dụng/);
  });

  it("404 — code does not exist in system", async () => {
    User.findOne.mockReturnValue(mockQuery(null));

    const res = await request(buildApp())
      .post("/api/referrals/apply")
      .send({ code: "NOTFOUND" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/không tồn tại/);
  });

  it("400 — referrer never had premium", async () => {
    User.findOne.mockReturnValue(
      mockQuery({ _id: REFERRER_ID, subscription_tier: "free", subscription_expires_at: undefined })
    );

    const res = await request(buildApp())
      .post("/api/referrals/apply")
      .send({ code: "FREEUSER" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Premium/);
  });

  it("400 — missing code in request body", async () => {
    const res = await request(buildApp())
      .post("/api/referrals/apply")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/không hợp lệ/);
  });

  it("normalises code to uppercase before lookup", async () => {
    await request(buildApp())
      .post("/api/referrals/apply")
      .send({ code: "otherxxx" });

    expect(User.findOne).toHaveBeenCalledWith({ referral_code: "OTHERXXX" });
  });
});
