import { buildMenuItemInput } from "../routes/stores";

describe("store menu item validation", () => {
    it("normalizes the data needed for a searchable, loggable restaurant dish", () => {
        const { data, errors } = buildMenuItemInput({
            name_vi: "  Cơm gà nướng  ",
            serving_label: "1 phần",
            serving_weight_grams: "420",
            menu_category: "main",
            search_keywords: "cơm gà, chicken rice, eat clean",
            dietary_tags: ["high_protein", "unknown"],
            allergens: "egg, soy, unknown",
            energy_kcal: "520",
            protein: "38",
            nutrition_source_reference: "Công thức quán",
        }, { creating: true });

        expect(errors).toEqual([]);
        expect(data).toMatchObject({
            name_vi: "Cơm gà nướng",
            serving_label: "1 phần",
            serving_weight_grams: 420,
            menu_category: "main",
            search_keywords: ["cơm gà", "chicken rice", "eat clean"],
            dietary_tags: ["high_protein"],
            allergens: ["egg", "soy"],
            energy_kcal: 520,
            protein: 38,
            nutrition_status: "owner_provided",
            nutrition_verified: false,
        });
    });

    it("does not allow an owner request to self-verify nutrition", () => {
        const { data, errors } = buildMenuItemInput({
            name_vi: "Salad ức gà",
            energy_kcal: 320,
            nutrition_verified: true,
        }, { creating: true });

        expect(errors).toEqual([]);
        expect(data.nutrition_verified).toBe(false);
        expect(data.nutrition_status).toBe("owner_provided");
    });

    it("allows the verified state only for an admin-authorized update", () => {
        const { data, errors } = buildMenuItemInput({ nutrition_verified: true }, { allowAdminVerification: true });

        expect(errors).toEqual([]);
        expect(data).toMatchObject({ nutrition_verified: true, nutrition_status: "admin_verified" });
    });

    it("keeps old CSV rows valid when they do not contain a category column", () => {
        const { data, errors } = buildMenuItemInput({
            name_vi: "Phở bò",
            menu_category: undefined,
            energy_kcal: "420",
        }, { creating: true });

        expect(errors).toEqual([]);
        expect(data.menu_category).toBeUndefined();
    });

    it("rejects invalid nutrition and category values", () => {
        const { errors } = buildMenuItemInput({
            name_vi: "Món thử",
            energy_kcal: -10,
            menu_category: "anything",
        }, { creating: true });

        expect(errors).toEqual(expect.arrayContaining([
            "energy_kcal phải là số không âm.",
            "Nhóm món không hợp lệ.",
        ]));
    });
});
