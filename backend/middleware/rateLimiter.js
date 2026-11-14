/**
 * Hybrid Rate Limiting Middleware (BUG-039 / BUG-046)
 * 
 * Supports both single-instance in-memory tracking and multi-instance shared state
 * via MongoDB TTL collection without requiring external infrastructure like Redis.
 * Enforces HTTP 429 and standard RFC rate-limit headers.
 */

const mongoose = require("mongoose");

let RateLimitModel = null;

function getRateLimitModel() {
    if (!RateLimitModel && mongoose.connection && mongoose.connection.readyState === 1) {
        try {
            const schema = new mongoose.Schema({
                key: { type: String, required: true, unique: true },
                count: { type: Number, required: true, default: 1 },
                resetTime: { type: Date, required: true, expires: 0 }
            }, { versionKey: false });
            RateLimitModel = mongoose.models.RateLimit || mongoose.model("RateLimit", schema);
        } catch (e) {
            RateLimitModel = mongoose.models.RateLimit || null;
        }
    }
    return RateLimitModel;
}

function createRateLimiter({
    windowMs = 60 * 1000, // 1 minute default
    max = 30,             // 30 requests per window
    message = "Too many requests. Please try again later.",
    keyGenerator = (req) => req.ip || req.connection?.remoteAddress || "127.0.0.1",
    prefix = "rl"
}) {
    const memoryStore = new Map();

    // Periodic cleanup of expired entries every 2 minutes
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, record] of memoryStore.entries()) {
            if (now >= record.resetTime) {
                memoryStore.delete(key);
            }
        }
    }, 2 * 60 * 1000);

    if (cleanupInterval.unref) {
        cleanupInterval.unref();
    }

    return async function rateLimitMiddleware(req, res, next) {
        const ipKey = keyGenerator(req);
        const fullKey = `${prefix}:${ipKey}`;
        const now = Date.now();

        let count = 0;
        let resetSeconds = Math.ceil(windowMs / 1000);
        let usedMongo = false;

        const Model = getRateLimitModel();
        if (Model && mongoose.connection.readyState === 1) {
            try {
                const expiresAt = new Date(now + windowMs);
                let doc = await Model.findOneAndUpdate(
                    { key: fullKey, resetTime: { $gt: new Date(now) } },
                    { $inc: { count: 1 } },
                    { new: true }
                );

                if (!doc) {
                    try {
                        doc = await Model.findOneAndUpdate(
                            { key: fullKey },
                            { 
                                $inc: { count: 1 },
                                $setOnInsert: { resetTime: expiresAt }
                            },
                            { upsert: true, new: true }
                        );
                        // If an existing expired record was found, reset its window
                        if (doc && doc.resetTime && doc.resetTime.getTime() <= now) {
                            doc = await Model.findOneAndUpdate(
                                { key: fullKey },
                                { $set: { count: 1, resetTime: expiresAt } },
                                { new: true }
                            );
                        }
                    } catch (upsertErr) {
                        if (upsertErr.code === 11000) {
                            // Handle concurrent upsert collision gracefully; retry increment atomically
                            doc = await Model.findOneAndUpdate(
                                { key: fullKey },
                                { $inc: { count: 1 } },
                                { new: true }
                            );
                        } else {
                            throw upsertErr;
                        }
                    }
                }

                if (doc) {
                    count = doc.count;
                    resetSeconds = Math.max(1, Math.ceil((doc.resetTime.getTime() - now) / 1000));
                    usedMongo = true;
                }
            } catch (err) {
                // On transient database disconnection, fail-safe fallback to memoryStore
                usedMongo = false;
            }
        }

        if (!usedMongo) {
            let record = memoryStore.get(fullKey);
            if (!record || now >= record.resetTime) {
                record = { count: 0, resetTime: now + windowMs };
                memoryStore.set(fullKey, record);
            }
            record.count++;
            count = record.count;
            resetSeconds = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
        }

        const remaining = Math.max(0, max - count);

        // Standard rate limit headers
        res.setHeader("RateLimit-Limit", max);
        res.setHeader("RateLimit-Remaining", remaining);
        res.setHeader("RateLimit-Reset", resetSeconds);

        if (count > max) {
            res.setHeader("Retry-After", resetSeconds);
            if (req.accepts && req.accepts("html") && !req.xhr && !req.path.startsWith("/api")) {
                return res.status(429).render("error", {
                    title: "429 Too Many Requests",
                    message
                });
            }
            return res.status(429).json({
                error: message,
                retryAfter: resetSeconds
            });
        }

        next();
    };
}

// Stricter limiter for authentication attempts: 20 attempts per 15 minutes per IP
const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many authentication attempts from this IP address. Please try again after 15 minutes.",
    prefix: "auth"
});

// Execution limiter: 30 code executions per minute per IP
const executionLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: "Code execution rate limit exceeded. Please wait a moment before running more code.",
    prefix: "exec"
});

module.exports = {
    createRateLimiter,
    authLimiter,
    executionLimiter
};
