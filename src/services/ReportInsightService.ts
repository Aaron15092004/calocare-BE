export interface Insight {
    type: "warning" | "success" | "tip";
    title: string;
    body: string;
    suggestion?: string;
}

interface DailyAggregate {
    calories: number;
    protein: number;
    fiber: number;
    mealTypes: Set<string>;
    isWeekend: boolean;
}

export function computeInsights(
    entries: Array<{
        meal_type: string;
        totals: { calories: number; protein: number; fiber: number };
        scanned_at: Date | string;
    }>,
    goals: { calories?: number; protein?: number },
    period_days: number,
): Insight[] {
    const insights: Insight[] = [];
    if (entries.length === 0) return insights;

    const dailyMap = new Map<string, DailyAggregate>();

    for (const entry of entries) {
        const d = new Date(entry.scanned_at);
        const key = d.toISOString().slice(0, 10);
        const dow = d.getDay();
        if (!dailyMap.has(key)) {
            dailyMap.set(key, {
                calories: 0, protein: 0, fiber: 0,
                mealTypes: new Set(),
                isWeekend: dow === 0 || dow === 6,
            });
        }
        const day = dailyMap.get(key)!;
        day.calories += entry.totals.calories ?? 0;
        day.protein  += entry.totals.protein  ?? 0;
        day.fiber    += entry.totals.fiber    ?? 0;
        day.mealTypes.add(entry.meal_type);
    }

    const days = Array.from(dailyMap.values());
    const n = days.length;
    if (n === 0) return insights;

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const avgCalories = avg(days.map((d) => d.calories));
    const avgProtein  = avg(days.map((d) => d.protein));
    const avgFiber    = avg(days.map((d) => d.fiber));

    // Rule 1: Protein
    const goalProtein = goals.protein;
    if (goalProtein && goalProtein > 0) {
        if (avgProtein < goalProtein * 0.8) {
            insights.push({
                type: "warning",
                title: "Thiếu protein",
                body: `Protein trung bình của bạn là ${Math.round(avgProtein)}g/ngày, thấp hơn ${Math.round((1 - avgProtein / goalProtein) * 100)}% so với mục tiêu ${goalProtein}g.`,
                suggestion: "Thêm trứng, đậu hũ hoặc cá vào bữa sáng để cải thiện.",
            });
        } else if (avgProtein >= goalProtein * 0.9) {
            insights.push({
                type: "success",
                title: "Protein ổn định",
                body: `Bạn đạt trung bình ${Math.round(avgProtein)}g protein/ngày — sát với mục tiêu ${goalProtein}g. Xuất sắc!`,
            });
        }
    }

    // Rule 2: Fiber
    if (avgFiber < 20) {
        insights.push({
            type: "warning",
            title: "Chất xơ thấp",
            body: `Chất xơ trung bình chỉ ${avgFiber.toFixed(1)}g/ngày, thấp hơn mức khuyến nghị 25g.`,
            suggestion: "Thêm rau xanh, trái cây hoặc đậu vào mỗi bữa ăn.",
        });
    } else {
        insights.push({
            type: "success",
            title: "Chất xơ đạt chuẩn",
            body: `Trung bình ${avgFiber.toFixed(1)}g chất xơ/ngày — đáp ứng khuyến nghị của WHO.`,
        });
    }

    // Rule 3: Breakfast skipping
    const daysWithBreakfast = days.filter((d) => d.mealTypes.has("breakfast")).length;
    const breakfastRate = daysWithBreakfast / n;
    if (breakfastRate < 0.7) {
        insights.push({
            type: "tip",
            title: "Hay bỏ bữa sáng",
            body: `Bạn có bữa sáng chỉ ${daysWithBreakfast}/${n} ngày đã ghi (${Math.round(breakfastRate * 100)}%).`,
            suggestion: "Ăn sáng giúp kiểm soát cơn đói và duy trì năng lượng cả ngày.",
        });
    }

    // Rule 4: Weekend vs weekday calorie spike
    const weekdayDays = days.filter((d) => !d.isWeekend);
    const weekendDays = days.filter((d) => d.isWeekend);
    if (weekdayDays.length >= 3 && weekendDays.length >= 1) {
        const avgWeekday = avg(weekdayDays.map((d) => d.calories));
        const avgWeekend = avg(weekendDays.map((d) => d.calories));
        if (avgWeekend > avgWeekday * 1.2 && avgWeekday > 0) {
            const diff = Math.round(avgWeekend - avgWeekday);
            insights.push({
                type: "warning",
                title: "Ăn nhiều hơn vào cuối tuần",
                body: `Cuối tuần bạn ăn nhiều hơn ngày thường trung bình ${diff} kcal.`,
                suggestion: "Lên thực đơn cuối tuần trước để kiểm soát khẩu phần tốt hơn.",
            });
        }
    }

    // Rule 5: Calorie consistency (std deviation)
    if (n >= 5 && avgCalories > 0) {
        const variance = avg(days.map((d) => (d.calories - avgCalories) ** 2));
        const stdDev = Math.sqrt(variance);
        if (stdDev > 400) {
            insights.push({
                type: "tip",
                title: "Calo không ổn định",
                body: `Lượng calo dao động lớn (±${Math.round(stdDev)} kcal/ngày) so với mức trung bình ${Math.round(avgCalories)} kcal.`,
                suggestion: "Ăn đều đặn mỗi ngày giúp tối ưu trao đổi chất.",
            });
        }
    }

    // Rule 6: Low logging frequency
    const avgMealsPerDay = entries.length / n;
    if (avgMealsPerDay < 2) {
        insights.push({
            type: "tip",
            title: "Ghi nhật ký chưa đầy đủ",
            body: `Trung bình bạn chỉ ghi ${avgMealsPerDay.toFixed(1)} bữa/ngày.`,
            suggestion: "Ghi đủ các bữa ăn để theo dõi dinh dưỡng chính xác hơn.",
        });
    }

    // Rule 7: Positive — on-target calorie days
    const goalCalories = goals.calories;
    if (goalCalories && goalCalories > 0 && period_days >= 7) {
        const onTarget = days.filter(
            (d) => d.calories >= goalCalories * 0.9 && d.calories <= goalCalories * 1.1,
        ).length;
        if (onTarget >= 5) {
            insights.push({
                type: "success",
                title: "Kiểm soát calo tốt",
                body: `${onTarget}/${n} ngày bạn ăn trong vùng mục tiêu calo (±10%). Tiếp tục phát huy!`,
            });
        }
    }

    return insights;
}
