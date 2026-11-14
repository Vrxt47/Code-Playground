const jwt = require("jsonwebtoken");
const User = require("../models/User");

// BUG-006 / SEC-006: Insecure Secrets Hardening
const isProduction = process.env.NODE_ENV === "production";
const INSECURE_DEFAULT_SECRETS = [
    "codeplayground_jwt_super_secret_key_2025",
    "secret",
    "jwt_secret",
    "supersecret",
    "default_secret"
];

let JWT_SECRET = process.env.JWT_SECRET;

if (isProduction) {
    if (!JWT_SECRET || INSECURE_DEFAULT_SECRETS.includes(JWT_SECRET) || JWT_SECRET.length < 32) {
        throw new Error(
            "[SECURITY FATAL]: Production startup aborted. Insecure or missing JWT_SECRET environment variable. " +
            "You must configure a strong, random JWT_SECRET of at least 32 characters in production."
        );
    }
} else {
    if (!JWT_SECRET || INSECURE_DEFAULT_SECRETS.includes(JWT_SECRET)) {
        console.warn(
            "[SECURITY WARNING]: JWT_SECRET is not configured or using default secret in non-production mode. " +
            "Ensure a strong secret is configured for staging and production environments."
        );
        JWT_SECRET = JWT_SECRET || "codeplayground_jwt_dev_insecure_fallback_2025";
    }
}

/**
 * Standard cookie configuration for session persistence (BUG-036 / BUG-037 / BUG-048)
 */
const AUTH_COOKIE_NAME = "token";
const AUTH_COOKIE_OPTIONS = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

if (process.env.COOKIE_DOMAIN) {
    AUTH_COOKIE_OPTIONS.domain = process.env.COOKIE_DOMAIN;
}

function setAuthCookie(res, token) {
    res.cookie(AUTH_COOKIE_NAME, token, AUTH_COOKIE_OPTIONS);
}

function clearAuthCookie(res) {
    const clearOptions = {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProduction
    };
    if (process.env.COOKIE_DOMAIN) {
        clearOptions.domain = process.env.COOKIE_DOMAIN;
    }
    res.clearCookie(AUTH_COOKIE_NAME, clearOptions);
}

/**
 * Extract JWT from Authorization header (Bearer), custom headers, or session cookie
 */
function extractToken(req) {
    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
        return req.headers.authorization.split(" ")[1];
    }
    if (req.headers["x-auth-token"]) {
        return req.headers["x-auth-token"];
    }
    if (req.headers.token) {
        return req.headers.token;
    }
    if (req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)token=([^;]+)/);
        if (match) {
            return decodeURIComponent(match[1]);
        }
    }
    return null;
}

/**
 * Helper to determine if incoming request is an API route
 */
function isApiRoute(req) {
    const fullUrl = req.originalUrl || req.url || req.path || "";
    return fullUrl.startsWith("/api") || (req.baseUrl && req.baseUrl.startsWith("/api")) || !!req.xhr;
}

/**
 * Middleware to require valid JWT authentication.
 * For view routes, redirects unauthenticated requests to signin with return URL.
 * For API requests, returns 401 JSON.
 */
const requireAuth = async (req, res, next) => {
    try {
        const token = extractToken(req);

        if (!token) {
            if (!isApiRoute(req) && req.accepts("html")) {
                return res.redirect(`/signin?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
            }
            return res.status(401).json({ message: "Authentication required. Please sign in." });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId).select("-password");

        if (!user) {
            if (!isApiRoute(req) && req.accepts("html")) {
                return res.redirect(`/signin?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
            }
            return res.status(401).json({ message: "User session expired or user does not exist." });
        }

        // BUG-037: Session invalidation via tokenVersion check
        const currentTokenVersion = user.tokenVersion || 0;
        const tokenVersionInJwt = decoded.tokenVersion !== undefined ? decoded.tokenVersion : 0;

        if (tokenVersionInJwt !== currentTokenVersion) {
            if (!isApiRoute(req) && req.accepts("html")) {
                return res.redirect(`/signin?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
            }
            return res.status(401).json({ message: "Session expired or invalidated. Please sign in again." });
        }

        req.user = {
            id: user._id.toString(),
            userId: user._id.toString(),
            username: user.username,
            email: user.email,
            role: user.role || "user",
            tokenVersion: currentTokenVersion
        };

        next();
    } catch (err) {
        if (!isApiRoute(req) && req.accepts("html")) {
            return res.redirect(`/signin?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
        }
        return res.status(401).json({ message: "Invalid or expired session token." });
    }
};

/**
 * Optional authentication: attaches user if token provided, but allows guests
 */
const optionalAuth = async (req, res, next) => {
    try {
        const token = extractToken(req);
        if (token) {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.userId).select("-password");
            if (user) {
                const currentTokenVersion = user.tokenVersion || 0;
                const tokenVersionInJwt = decoded.tokenVersion !== undefined ? decoded.tokenVersion : 0;
                if (tokenVersionInJwt === currentTokenVersion) {
                    req.user = {
                        id: user._id.toString(),
                        userId: user._id.toString(),
                        username: user.username,
                        email: user.email,
                        role: user.role || "user",
                        tokenVersion: currentTokenVersion
                    };
                }
            }
        }
    } catch (err) {
        // Ignore errors in optional auth
    }
    next();
};

/**
 * Middleware to require admin privileges.
 * For view routes, redirects to signin or renders 403 Forbidden.
 * For API routes, returns 401 or 403 JSON.
 */
const requireAdmin = async (req, res, next) => {
    return requireAuth(req, res, () => {
        if (req.user && req.user.role === "admin") {
            return next();
        }
        if (!isApiRoute(req) && req.accepts("html")) {
            return res.status(403).render("error", {
                title: "403 Forbidden",
                message: "Access Denied: Administrator privileges are required to access this resource."
            });
        }
        return res.status(403).json({ message: "Access denied: Administrator privileges required." });
    });
};

module.exports = {
    requireAuth,
    optionalAuth,
    requireAdmin,
    extractToken,
    setAuthCookie,
    clearAuthCookie,
    AUTH_COOKIE_NAME,
    AUTH_COOKIE_OPTIONS,
    JWT_SECRET
};
