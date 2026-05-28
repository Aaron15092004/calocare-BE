import { Request, Response, NextFunction } from "express";
import { IUser } from "../models/User";

export const requireRole = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const user = req.user as IUser;
        if (!user || !roles.includes(user.role)) {
            res.status(403).json({ error: "Forbidden: insufficient permissions" });
            return;
        }
        next();
    };
};

export const requireAdmin = requireRole("admin");
export const requireAdminOrModerator = requireRole("admin", "moderator");
export const requireStoreOwner = requireRole("admin", "moderator", "store_owner");