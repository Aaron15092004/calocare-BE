import { Request, Response, NextFunction } from "express";
import passport from "passport";
import { IUser } from "../models/User";

export const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    passport.authenticate("jwt", { session: false }, (err: Error, user: IUser) => {
        if (err) return next(err);
        if (!user) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        req.user = user;
        next();
    })(req, res, next);
};