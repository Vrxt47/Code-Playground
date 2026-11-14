const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("./config/db");
const Problem = require("./models/Problem");
const Contest = require("./models/Contest");
const User = require("./models/User");
const { sanitizeProblemForClient } = require("./utils/judgeComparison");

// Load environment variables
dotenv.config();

const app = express();

// Trust proxy for secure cookies and rate limiting behind reverse proxies (BUG-039)
app.set("trust proxy", 1);

// Connect to Database
connectDB();

// Resolve directories safely for both Local and Vercel serverless runtime
const fs = require("fs");
const frontendDir = fs.existsSync(path.join(process.cwd(), "frontend"))
    ? path.join(process.cwd(), "frontend")
    : path.join(__dirname, "../frontend");

const publicDir = fs.existsSync(path.join(process.cwd(), "public"))
    ? path.join(process.cwd(), "public")
    : null;

// View engine setup
app.set("view engine", "ejs");
app.set("views", path.join(frontendDir, "views"));

// BUG-043: Restrict CORS origins strictly based on environment
const isProduction = process.env.NODE_ENV === "production";

const devAllowedOrigins = [
    "http://localhost:3000",
    "http://localhost:4000",
    "http://localhost:5000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:4000",
    "http://127.0.0.1:5000"
];

const envAllowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean)
    : [];

// In production, allow ONLY explicitly configured ALLOWED_ORIGINS.
// Localhost origins are permitted ONLY in development/testing.
const allowedOrigins = isProduction
    ? [...new Set(envAllowedOrigins)]
    : [...new Set([...devAllowedOrigins, ...envAllowedOrigins])];

const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, same-origin browser navigation)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS policy error: Origin ${origin} is not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "X-CSRF-Token", "X-XSRF-Token"]
};

// Body parsing and security middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// CSRF Protection Middleware (BUG-044)
const { csrfProtection } = require("./middleware/csrf");
app.use(csrfProtection);

// @route GET /api/csrf-token
// Exposes the current CSRF token for single-page applications and client scripts (BUG-049)
app.get("/api/csrf-token", (req, res) => {
    res.json({ csrfToken: res.locals.csrfToken });
});

// Serverless Database Connection Middleware: Ensure MongoDB is connected before handling data requests
app.use(async (req, res, next) => {
    // Skip db connection for static assets
    if (req.path.startsWith('/css') || req.path.startsWith('/uploads') || req.path.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf)$/i)) {
        return next();
    }
    try {
        await connectDB();
        next();
    } catch (err) {
        console.error("[Database Middleware Connection Error]:", err.message);
        next();
    }
});

// Static files configuration (for local and container environments)
if (publicDir) {
    app.use("/css", express.static(path.join(publicDir, "css")));
    app.use(express.static(publicDir));
}
app.use("/css", express.static(path.join(frontendDir, "css")));
app.use("/uploads", (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
}, express.static(path.join(frontendDir, "imgg/uploads")));
app.use(express.static(path.join(frontendDir, "imgg")));
// NOTE: app.use(express.static(frontendDir)) removed to fix BUG-028 / SEC-007 (raw template source disclosure)

// Import Rate Limiters (BUG-039)
const { authLimiter, executionLimiter } = require("./middleware/rateLimiter");

// Import API Routes
const authRoutes = require("./routes/authRoutes");
const problemRoutes = require("./routes/problemRoutes");
const executeRoutes = require("./routes/executeRoutes");
const discussRoutes = require("./routes/discussRoutes");
const contestRoutes = require("./routes/contestRoutes");
const contestjoinRoutes = require("./routes/contestjoinRoutes");
const contactRoutes = require("./routes/contactRoutes");
const adminRoutes = require("./routes/adminRoutes");

// Mount API Endpoints with Rate Limiting
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/problems", problemRoutes);
app.use("/api/execute", executionLimiter, executeRoutes);
app.use("/api/discuss", discussRoutes);
app.use("/api/contests/join", contestjoinRoutes);
app.use("/api/contests", contestRoutes);
app.use("/api/contact", contactRoutes);
app.use("/admin", adminRoutes);
app.use("/api/admin", adminRoutes);

// Compatibility authentication routes & session helpers
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, setAuthCookie, clearAuthCookie, extractToken } = require("./middleware/auth");

app.post("/signup", authLimiter, async (req, res) => {
    try {
        const { username, name, email, password, confirm_password } = req.body;
        const finalUsername = (username || name || "").trim();
        const finalEmail = (email || "").trim().toLowerCase();

        if (!finalUsername || !finalEmail || !password) {
            return res.status(400).json({ message: "Username, email, and password are required." });
        }

        if (confirm_password && password !== confirm_password) {
            return res.status(400).json({ message: "Passwords do not match." });
        }

        const existing = await User.findOne({ 
            $or: [{ email: finalEmail }, { username: finalUsername }] 
        });

        if (existing) {
            return res.status(400).json({ 
                message: existing.email === finalEmail ? "Email already exists" : "Username is already taken" 
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({
            username: finalUsername,
            email: finalEmail,
            password: hashedPassword,
            role: "user",
            tokenVersion: 0
        });

        const token = jwt.sign(
            { 
                userId: user._id.toString(), 
                email: user.email, 
                role: user.role,
                tokenVersion: user.tokenVersion || 0 
            },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        setAuthCookie(res, token);

        res.status(201).json({
            message: "Signup successful",
            token,
            userId: user._id,
            username: user.username,
            email: user.email,
            role: user.role
        });
    } catch (err) {
        console.error("Signup error:", err);
        res.status(500).json({ message: "Error during sign up: " + err.message });
    }
});

app.post("/signin", authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        const finalEmail = (email || "").trim().toLowerCase();

        if (!finalEmail || !password) {
            return res.status(400).json({ message: "Email and password are required." });
        }

        const user = await User.findOne({
            $or: [{ email: finalEmail }, { username: finalEmail }]
        });

        if (!user) {
            return res.status(400).json({ message: "User not found with provided credentials." });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Incorrect password." });
        }

        const token = jwt.sign(
            { 
                userId: user._id.toString(), 
                email: user.email, 
                role: user.role || "user",
                tokenVersion: user.tokenVersion || 0 
            },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        setAuthCookie(res, token);

        res.json({
            message: "Signin successful",
            token,
            userId: user._id,
            username: user.username,
            email: user.email,
            role: user.role || "user",
            profilePicture: user.profilePicture || "/profile.png"
        });
    } catch (err) {
        console.error("Signin error:", err);
        res.status(500).json({ message: "Error signing in: " + err.message });
    }
});

// App-level logout endpoints (BUG-036 & BUG-037)
app.post("/logout", async (req, res) => {
    try {
        const token = extractToken(req);
        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                if (decoded && decoded.userId) {
                    await User.findByIdAndUpdate(decoded.userId, { $inc: { tokenVersion: 1 } });
                }
            } catch (ignore) {}
        }
        clearAuthCookie(res);
        res.json({ success: true, message: "Logged out successfully." });
    } catch (err) {
        clearAuthCookie(res);
        res.status(500).json({ message: "Error during logout: " + err.message });
    }
});

// BUG-044: Safe non-state-changing GET /logout (Strictly forbids state mutation to prevent CSRF)
app.get("/logout", (req, res) => {
    if (req.accepts && req.accepts("html") && !req.xhr) {
        return res.redirect("/signin");
    }
    return res.status(405).json({
        error: "Method Not Allowed. State-changing logout requires POST request to /logout or /api/auth/logout.",
        code: "METHOD_NOT_ALLOWED"
    });
});

// ==========================================
// PAGE VIEW ROUTES
// ==========================================

// Landing page
app.get("/", (req, res) => {
    res.render("home", { activePage: "home" });
});

// Explore
app.get("/explore", (req, res) => {
    res.render("explore", { activePage: "explore" });
});

// Problems list
app.get("/problems", (req, res) => {
    res.render("problems", { activePage: "problems" });
});

// Code Editor for Problem
app.get("/editcode/:problemId", async (req, res) => {
    try {
        const problemId = req.params.problemId;
        if (!mongoose.Types.ObjectId.isValid(problemId)) {
            return res.status(404).render("error", { 
                title: "Problem Not Found", 
                message: "The requested problem ID is invalid." 
            });
        }

        const problem = await Problem.findById(problemId);
        if (!problem) {
            return res.status(404).render("error", { 
                title: "Problem Not Found", 
                message: "Could not find a problem with the requested ID." 
            });
        }

        res.render("editcode", { problem: sanitizeProblemForClient(problem), activePage: "problems" });
    } catch (error) {
        console.error("Error fetching problem:", error);
        res.status(500).render("error", { 
            title: "Internal Error", 
            message: "Failed to load the code editor for this problem." 
        });
    }
});

// Contests directory
app.get("/contests", (req, res) => {
    res.render("contests", { activePage: "contests" });
});

// Create Contest
app.get("/create_contest", (req, res) => {
    res.render("create_contest", { activePage: "contests" });
});

// Single Contest Workspace
app.get("/contestpage/:id", async (req, res) => {
    try {
        const contestId = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(contestId)) {
            return res.status(400).render("error", { 
                title: "Invalid Contest ID", 
                message: "The contest ID format is invalid." 
            });
        }

        const contest = await Contest.findById(contestId)
            .populate("problems", "title difficulty")
            .populate("participants.user", "username")
            .lean();

        if (!contest) {
            return res.status(404).render("error", { 
                title: "Contest Not Found", 
                message: "The contest you requested could not be found." 
            });
        }

        res.render("contestpage", { contestId: contest._id, contest, activePage: "contests" });
    } catch (error) {
        console.error("Error loading contestpage:", error);
        res.status(500).render("error", { 
            title: "Error Loading Contest", 
            message: "Failed to load contest details. Please try again." 
        });
    }
});

// Contest Leaderboard
app.get("/contest/:id/leaderboard", async (req, res) => {
    try {
        const contestId = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(contestId)) {
            return res.status(400).render("error", { 
                title: "Invalid Contest ID", 
                message: "Invalid contest ID format." 
            });
        }

        const contest = await Contest.findById(contestId)
            .populate({
                path: "leaderboard.user",
                select: "username"
            })
            .lean();

        if (!contest) {
            return res.status(404).render("error", { 
                title: "Contest Not Found", 
                message: "Contest does not exist." 
            });
        }

        if (contest.status !== "Completed") {
            return res.render("contest_not_ended", { 
                contestId: contest._id,
                contestName: contest.name,
                endTime: contest.endTime,
                activePage: "contests"
            });
        }

        const leaderboard = (contest.leaderboard || [])
            .filter(entry => entry.user)
            .slice()
            .sort((a, b) => {
                const scoreDiff = (b.totalScore || 0) - (a.totalScore || 0);
                if (scoreDiff !== 0) return scoreDiff;
                const timeA = (a.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
                const timeB = (b.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
                if (timeA !== timeB) return timeA - timeB;
                const idA = a.user ? (a.user._id || a.user).toString() : "";
                const idB = b.user ? (b.user._id || b.user).toString() : "";
                return idA.localeCompare(idB);
            })
            .map((entry, index) => ({
                rank: index + 1,
                username: entry.user.username || "Unknown",
                score: entry.totalScore || 0,
                problemsSolved: entry.submissions ? entry.submissions.filter(s => s.score > 0).length : 0
            }));

        res.render("leaderboard", {
            contestId: contest._id,
            contestName: contest.name,
            leaderboard,
            activePage: "contests"
        });
    } catch (error) {
        console.error("Error fetching leaderboard:", error);
        res.status(500).render("error", { 
            title: "Error", 
            message: "Failed to fetch leaderboard standings." 
        });
    }
});

// Global Platform Leaderboard
app.get("/leaderboard", async (req, res) => {
    try {
        const users = await User.find({ role: "user" })
            .select("username contestRating problemsSolved createdAt")
            .lean();

        const sortedUsers = users.slice().sort((a, b) => {
            const ratingA = (a.contestRating && a.contestRating.current) ? a.contestRating.current : 1500;
            const ratingB = (b.contestRating && b.contestRating.current) ? b.contestRating.current : 1500;
            if (ratingB !== ratingA) return ratingB - ratingA;
            const solvedA = a.problemsSolved ? a.problemsSolved.length : 0;
            const solvedB = b.problemsSolved ? b.problemsSolved.length : 0;
            if (solvedB !== solvedA) return solvedB - solvedA;
            return (a.username || "").localeCompare(b.username || "");
        }).map((u, index) => ({
            rank: index + 1,
            username: u.username || "Anonymous",
            score: (u.contestRating && u.contestRating.current) ? u.contestRating.current : 1500,
            problemsSolved: u.problemsSolved ? u.problemsSolved.length : 0
        }));

        res.render("leaderboard", {
            contestId: "global",
            contestName: "Global Platform Leaderboard",
            subtitle: "Overall Platform Standings & Contest Elo Ratings",
            leaderboard: sortedUsers,
            activePage: "leaderboard",
            backUrl: "/explore",
            backText: "Back to Explore",
            scoreColumnTitle: "Contest Rating"
        });
    } catch (error) {
        console.error("Error fetching global leaderboard:", error);
        res.status(500).render("error", {
            title: "Leaderboard Error",
            message: "Failed to load global platform standings."
        });
    }
});

// API endpoint for Global Leaderboard
app.get("/api/leaderboard", async (req, res) => {
    try {
        const users = await User.find({ role: "user" })
            .select("username contestRating problemsSolved createdAt")
            .lean();

        const sortedUsers = users.slice().sort((a, b) => {
            const ratingA = (a.contestRating && a.contestRating.current) ? a.contestRating.current : 1500;
            const ratingB = (b.contestRating && b.contestRating.current) ? b.contestRating.current : 1500;
            if (ratingB !== ratingA) return ratingB - ratingA;
            const solvedA = a.problemsSolved ? a.problemsSolved.length : 0;
            const solvedB = b.problemsSolved ? b.problemsSolved.length : 0;
            if (solvedB !== solvedA) return solvedB - solvedA;
            return (a.username || "").localeCompare(b.username || "");
        }).map((u, index) => ({
            rank: index + 1,
            username: u.username || "Anonymous",
            rating: (u.contestRating && u.contestRating.current) ? u.contestRating.current : 1500,
            problemsSolved: u.problemsSolved ? u.problemsSolved.length : 0
        }));

        res.json({ success: true, count: sortedUsers.length, leaderboard: sortedUsers });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch leaderboard data" });
    }
});

// Community Discussion
app.get("/discuss", (req, res) => {
    res.render("discuss", { activePage: "discuss" });
});

// About Us
app.get("/about", (req, res) => {
    res.render("about", { activePage: "about" });
});

// Contact Us
app.get("/contact", (req, res) => {
    res.render("contact", { activePage: "contact" });
});

// User Profile
app.get("/profile", (req, res) => {
    res.render("profile", { activePage: "profile" });
});

// Sign In
app.get("/signin", (req, res) => {
    res.render("signin", { activePage: "signin" });
});

// Sign Up
app.get("/signup", (req, res) => {
    res.render("signup", { activePage: "signup" });
});

// 404 Catch-All
app.use((req, res) => {
    res.status(404).render("error", {
        title: "404 - Page Not Found",
        message: `The page '${req.originalUrl}' does not exist on Code Playground.`
    });
});

// Global Error Handler
app.use((err, req, res, next) => {
    if (err && err.message && err.message.includes("CORS")) {
        return res.status(403).json({ error: err.message });
    }
    console.error("Unhandled Application Error:", err);
    res.status(500).render("error", {
        title: "Internal Server Error",
        message: "An unexpected error occurred. Our team has been notified.",
        error: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
});

const PORT = process.env.PORT || 4000;

if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`[Server] Code Playground running at http://localhost:${PORT}`);
    });
}

module.exports = app;