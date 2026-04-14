import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";
import User from "../models/User";

export const configurePassport = (): void => {
    // JWT Strategy
    passport.use(
        new JwtStrategy(
            {
                jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
                secretOrKey: process.env.JWT_SECRET as string,
            },
            async (payload, done) => {
                try {
                    const user = await User.findById(payload.id).select("-password -refresh_tokens");
                    if (!user) return done(null, false);
                    if (user.is_banned) return done(null, false, { message: "Account is banned" });
                    return done(null, user);
                } catch (error) {
                    return done(error, false);
                }
            },
        ),
    );

    // Google OAuth Strategy
    passport.use(
        new GoogleStrategy(
            {
                clientID: process.env.GOOGLE_CLIENT_ID as string,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
                callbackURL: process.env.GOOGLE_CALLBACK_URL as string,
            },
            async (_accessToken, _refreshToken, profile, done) => {
                try {
                    const email = profile.emails?.[0]?.value;
                    if (!email) return done(new Error("No email from Google"), false);

                    let user = await User.findOne({
                        $or: [{ google_id: profile.id }, { email }],
                    });

                    if (user) {
                        // Update google_id if missing
                        if (!user.google_id) {
                            user.google_id = profile.id;
                            await user.save();
                        }
                    } else {
                        user = await User.create({
                            email,
                            google_id: profile.id,
                            display_name: profile.displayName || email.split("@")[0],
                            avatar_url: profile.photos?.[0]?.value,
                        });
                    }

                    return done(null, user);
                } catch (error) {
                    return done(error as Error, false);
                }
            },
        ),
    );
};