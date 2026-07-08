/**
 * One-off cleanup for meal-plan orphans accumulated before cascade deletes:
 *   1. UserMealPlanItem / MealProgress rows whose UserMealPlan no longer exists
 *   2. MealPlanItem rows whose MealPlan no longer exists
 *   3. MealPlan docs stuck in status "generating" for > 24h (crashed runs)
 *
 * Run locally against the target DB:
 *   npx ts-node src/scripts/cleanup-meal-plan-orphans.ts          # dry-run (default)
 *   npx ts-node src/scripts/cleanup-meal-plan-orphans.ts --apply  # actually delete
 */
import "dotenv/config";
import mongoose from "mongoose";
import MealPlan from "../models/MealPlan";
import MealPlanItem from "../models/MealPlanItem";
import UserMealPlan from "../models/UserMealPlan";
import UserMealPlanItem from "../models/UserMealPlanItem";
import MealProgress from "../models/MealProgress";

const APPLY = process.argv.includes("--apply");

async function orphanIds(childModel: mongoose.Model<any>, foreignKey: string, parentModel: mongoose.Model<any>): Promise<mongoose.Types.ObjectId[]> {
    const parentIds = new Set((await parentModel.find().select("_id").lean()).map((d: any) => d._id.toString()));
    const children = await childModel.find().select(`_id ${foreignKey}`).lean();
    return children
        .filter((c: any) => !c[foreignKey] || !parentIds.has(c[foreignKey].toString()))
        .map((c: any) => c._id);
}

async function main() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error("MONGODB_URI missing");
    await mongoose.connect(uri);
    console.log(`Connected. Mode: ${APPLY ? "APPLY (deleting)" : "DRY-RUN"}\n`);

    const orphanUserItems = await orphanIds(UserMealPlanItem, "user_meal_plan_id", UserMealPlan);
    const orphanProgress = await orphanIds(MealProgress, "user_meal_plan_id", UserMealPlan);
    const orphanPlanItems = await orphanIds(MealPlanItem, "meal_plan_id", MealPlan);
    const stuckGenerating = await MealPlan.find({
        status: "generating",
        created_at: { $lt: new Date(Date.now() - 24 * 3600 * 1000) },
    }).select("_id title created_at").lean();

    console.log(`UserMealPlanItem orphans: ${orphanUserItems.length}`);
    console.log(`MealProgress orphans:     ${orphanProgress.length}`);
    console.log(`MealPlanItem orphans:     ${orphanPlanItems.length}`);
    console.log(`Stuck "generating" plans: ${stuckGenerating.length}`);
    stuckGenerating.forEach((p: any) => console.log(`  - ${p._id} "${p.title}" (${p.created_at})`));

    if (APPLY) {
        if (orphanUserItems.length) await UserMealPlanItem.deleteMany({ _id: { $in: orphanUserItems } });
        if (orphanProgress.length) await MealProgress.deleteMany({ _id: { $in: orphanProgress } });
        if (orphanPlanItems.length) await MealPlanItem.deleteMany({ _id: { $in: orphanPlanItems } });
        for (const p of stuckGenerating) {
            await MealPlanItem.deleteMany({ meal_plan_id: p._id });
            await MealPlan.deleteOne({ _id: p._id });
        }
        console.log("\nDeleted all of the above.");
    } else {
        console.log("\nDry-run only. Re-run with --apply to delete.");
    }

    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
