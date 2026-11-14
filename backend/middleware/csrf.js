/**
 * CSRF Protection Middleware (BUG-044)
 * 
 * Implements the Double-Submit Cookie pattern for state-changing operations.
 * - Exempts Bearer-token authenticated API requests (which are immune to ambient browser credential attachment).
 * - Enforces CSRF validation on all cookie-authenticated state-changing requests (POST, PUT, DELETE, PATCH).
 * - Issues a cryptographically secure, non-HttpOnly 'XSRF-TOKEN' cookie accessible to client-side scripts.
 * - Uses constant-time string comparison to prevent timing attacks.
 */

const crypto = require("crypto");

const isProduction = process.env.NODE_ENV === "production";
const CSRF_COOKIE_NAME = "XSRF-TOKEN";

const CSRF_COOKIE_OPTIONS = {
    httpOnly: false, // Must be readable by client JS to include in headers
    sameSite: "lax",
    path: "/",
    secure: isProduction
};

if (process.env.COOKIE_DOMAIN) {
    CSRF_COOKIE_OPTIONS.domain = process.env.COOKIE_DOMAIN;
}

function generateCsrfToken() {
    return crypto.randomBytes(32).toString("hex");
}

function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(";").forEach((cookie) => {
        let [name, ...rest] = cookie.split("=");
        name = name?.trim();
        if (!name) return;
        const value = rest.join("=").trim();
        list[name] = decodeURIComponent(value);
    });
    return list;
}

function csrfProtection(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    let csrfCookie = cookies[CSRF_COOKIE_NAME];

    // Ensure a CSRF cookie exists on the client for all requests
    if (!csrfCookie) {
        csrfCookie = generateCsrfToken();
        res.cookie(CSRF_COOKIE_NAME, csrfCookie, CSRF_COOKIE_OPTIONS);
    }

    // Expose CSRF token to views and responses
    res.locals.csrfToken = csrfCookie;

    // Safe idempotent methods do not mutate state
    const safeMethods = ["GET", "HEAD", "OPTIONS"];
    if (safeMethods.includes(req.method.toUpperCase())) {
        return next();
    }

    const hasBearerAuth = req.headers.authorization && 
                          req.headers.authorization.startsWith("Bearer ") && 
                          req.headers.authorization.trim().length > 7;
    const hasAuthCookie = !!cookies.token;

    // 1. If request explicitly presents a non-empty Bearer token or custom x-auth-token header,
    // it is inherently immune to ambient browser CSRF (browsers never attach custom auth headers cross-site).
    if (hasBearerAuth || req.headers["x-auth-token"]) {
        return next();
    }

    // 2. If there is no authenticated session cookie, there is no ambient session to forge.
    if (!hasAuthCookie) {
        return next();
    }

    // 3. Cookie-authenticated state-changing request: CSRF token is MANDATORY.
    const submittedToken = req.headers["x-csrf-token"] ||
                           req.headers["x-xsrf-token"] ||
                           (req.body && req.body._csrf) ||
                           req.query?._csrf;

    if (!submittedToken || !csrfCookie) {
        // If it's a view route form submission, render error; otherwise return 403 JSON
        if (req.accepts && req.accepts("html") && !req.xhr && !req.path.startsWith("/api")) {
            return res.status(403).render("error", {
                title: "403 Forbidden - Invalid CSRF Token",
                message: "Form submission failed security verification. Please refresh the page and try again."
            });
        }
        return res.status(403).json({
            error: "CSRF token validation failed. State-changing requests must include a valid X-CSRF-Token header or _csrf token.",
            code: "EBADCSRFTOKEN"
        });
    }

    // Constant-time token comparison using SHA-256 fixed-length digests
    try {
        const hashA = crypto.createHash("sha256").update(String(submittedToken)).digest();
        const hashB = crypto.createHash("sha256").update(String(csrfCookie)).digest();

        if (!crypto.timingSafeEqual(hashA, hashB)) {
            if (req.accepts && req.accepts("html") && !req.xhr && !req.path.startsWith("/api")) {
                return res.status(403).render("error", {
                    title: "403 Forbidden - Invalid CSRF Token",
                    message: "CSRF token mismatch. Please refresh and try again."
                });
            }
            return res.status(403).json({
                error: "CSRF token mismatch. Token is invalid or expired.",
                code: "EBADCSRFTOKEN"
            });
        }
    } catch (err) {
        return res.status(403).json({
            error: "CSRF verification error.",
            code: "EBADCSRFTOKEN"
        });
    }

    next();
}

module.exports = {
    csrfProtection,
    generateCsrfToken,
    CSRF_COOKIE_NAME,
    CSRF_COOKIE_OPTIONS
};
