import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import passport from "passport";
import { connectDB } from "./config/database";
import { configurePassport } from "./config/passport";

// Routes
import authRoutes from "./routes/auth";
import profileRoutes from "./routes/profile";
import foodDiaryRoutes from "./routes/foodDiary";
import foodsRoutes from "./routes/foods";
import foodGroupsRoutes from "./routes/foodGroups";
import recipesRoutes from "./routes/recipes";
import recipeCategoriesRoutes from "./routes/recipeCategories";
import mealPlansRoutes from "./routes/mealPlans";
import userMealPlansRoutes from "./routes/userMealPlans";
import mealProgressRoutes from "./routes/mealProgress";
import analyzeFoodRoutes from "./routes/analyzeFood";
import aiRoutes from "./routes/ai";
import adminDashboardRoutes from "./routes/admin/dashboard";
import adminUsersRoutes from "./routes/admin/users";
import discountCodesRoutes from "./routes/discountCodes";
import subscriptionRoutes from "./routes/subscription";
import storesRoutes from "./routes/stores";
import favoritesRoutes from "./routes/favorites";
import reviewsRoutes from "./routes/reviews";
import bannersRoutes from "./routes/banners";
import adminBannersRoutes from "./routes/admin/banners";
import ragSearchRoutes from "./routes/rag/search";
import ragScannerRoutes from "./routes/rag/scanner";
import ragChatRoutes from "./routes/rag/chat";
import ragMealPlanRoutes from "./routes/rag/mealPlan";
import adminRagRoutes from "./routes/admin/rag";
import adminSystemDiscountRoutes from "./routes/admin/systemDiscount";
import adminAiCostRoutes from "./routes/admin/aiCost";
import reportsRoutes from "./routes/reports";
import referralsRoutes from "./routes/referrals";
import widgetRoutes from "./routes/widget";
import rewardsRoutes from "./routes/rewards";
import { startCronJobs } from "./services/subscriptionCron";
import { startEnrichmentCron } from "./services/rag/enrichmentCron";

const app = express();

// Connect DB
connectDB();

// Passport
configurePassport();
app.use(passport.initialize());

// Core Middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:2004",
    credentials: true,
  }),
);
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/food-diary", foodDiaryRoutes);
app.use("/api/foods", foodsRoutes);
app.use("/api/food-groups", foodGroupsRoutes);
app.use("/api/recipes", recipesRoutes);
app.use("/api/recipe-categories", recipeCategoriesRoutes);
app.use("/api/meal-plans", mealPlansRoutes);
app.use("/api/user-meal-plans", userMealPlansRoutes);
app.use("/api/meal-progress", mealProgressRoutes);
app.use("/api/analyze-food", analyzeFoodRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/admin/dashboard", adminDashboardRoutes);
app.use("/api/admin/users", adminUsersRoutes);
app.use("/api/discount-codes", discountCodesRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/stores", storesRoutes);
app.use("/api/favorites", favoritesRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/banners", bannersRoutes);
app.use("/api/admin/banners", adminBannersRoutes);
app.use("/api/rag/search-food", ragSearchRoutes);
app.use("/api/rag/scan-food", ragScannerRoutes);
app.use("/api/rag/chat", ragChatRoutes);
app.use("/api/rag/generate-meal-plan", ragMealPlanRoutes);
app.use("/api/admin/rag", adminRagRoutes);
app.use("/api/admin/system-discount", adminSystemDiscountRoutes);
app.use("/api/admin/ai-cost", adminAiCostRoutes);
// Public alias so the subscription page can read active discount without admin role
app.use("/api/system-discount", adminSystemDiscountRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/referrals", referralsRoutes);
app.use("/api/widget", widgetRoutes);
app.use("/api/rewards", rewardsRoutes);

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// 404
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message || "Internal server error" });
  },
);

const PORT = process.env.PORT || 1509;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  startCronJobs();
  startEnrichmentCron();
});

export default app;
