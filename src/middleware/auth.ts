import { Request, Response, NextFunction } from "express";
import passport from "passport";
import { IUser } from "../models/User";
import { downgradeExpiredUserSubscription } from "../utils/subscriptionEntitlements";

export const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    passport.authenticate("jwt", { session: false }, async (err: Error, user: IUser) => {
        if (err) return next(err);
        if (!user) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        try {
            req.user = await downgradeExpiredUserSubscription(user);
            next();
        } catch (error) {
            next(error);
        }
    })(req, res, next);
};

// Like authenticate but does not reject unauthenticated requests — attaches user if token present
export const optionalAuthenticate = (req: Request, _res: Response, next: NextFunction): void => {
    passport.authenticate("jwt", { session: false }, async (err: Error, user: IUser | false) => {
        if (err) return next(err);
        try {
            if (user) req.user = await downgradeExpiredUserSubscription(user);
            next();
        } catch (error) {
            next(error);
        }
    })(req, _res, next);
};
