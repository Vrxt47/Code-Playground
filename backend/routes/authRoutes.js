const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sharp = require("sharp");
const { requireAuth, optionalAuth, setAuthCookie, clearAuthCookie, JWT_SECRET } = require("../middleware/auth");

const router = express.Router();

// Allowed image formats
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

/**
 * Validate actual file magic bytes to prevent forged MIME/extension attacks (BUG-041)
 */
function isValidImageBuffer(buffer) {
    if (!buffer || buffer.length < 12) return false;

    // JPEG signature: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
        buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) return true;

    // GIF signature: GIF87a or GIF89a
    const gifHeader = buffer.slice(0, 6).toString("ascii");
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return true;

    // WebP signature: RIFF....WEBP
    if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return true;

    return false;
}

// Set up secure multer for file uploads (fixes BUG-004)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../../frontend/imgg/uploads/profile');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Enforce server-generated random filename and strictly validated extension
        const rawExt = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
        const fileExt = ALLOWED_EXTENSIONS.includes(rawExt) ? rawExt : '.png';
        const uniqueName = `avatar_${crypto.randomBytes(16).toString('hex')}_${Date.now()}${fileExt}`;
        cb(null, uniqueName);
    }
});

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error("Only valid image files (JPEG, PNG, GIF, WEBP) are permitted."), false);
    }
};

const upload = multer({ 
    storage: storage, 
    fileFilter: fileFilter,
    limits: { fileSize: 3 * 1024 * 1024 } // 3MB limit
});

// Helper to generate JWT token
function generateToken(user) {
    return jwt.sign(
        { 
            userId: user._id.toString(), 
            email: user.email, 
            role: user.role || "user",
            tokenVersion: user.tokenVersion || 0
        }, 
        JWT_SECRET, 
        { expiresIn: "7d" }
    );
}

// @route POST /api/auth/register
router.post("/register", async (req, res) => {
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

        const existingUser = await User.findOne({ 
            $or: [{ email: finalEmail }, { username: finalUsername }] 
        });

        if (existingUser) {
            return res.status(400).json({ 
                message: existingUser.email === finalEmail ? "Email is already registered" : "Username is already taken" 
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({
            username: finalUsername,
            email: finalEmail,
            password: hashedPassword,
            role: "user",
            tokenVersion: 0
        });

        await user.save();

        const token = generateToken(user);
        setAuthCookie(res, token);
        res.status(201).json({
            message: "User registered successfully",
            token,
            userId: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            profilePicture: user.profilePicture
        });
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ message: "Error registering user: " + error.message });
    }
});

// @route POST /api/auth/login
router.post("/login", async (req, res) => {
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
            return res.status(400).json({ message: "Invalid email or username." });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Incorrect password." });
        }

        const token = generateToken(user);
        setAuthCookie(res, token);
        res.json({
            message: "Sign in successful",
            token,
            userId: user._id,
            username: user.username,
            email: user.email,
            role: user.role || "user",
            profilePicture: user.profilePicture || "/profile.png"
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "Error signing in: " + error.message });
    }
});

// @route POST /api/auth/logout
// Fixes BUG-036 & BUG-037: Clears HttpOnly cookie and invalidates session tokenVersion
router.post("/logout", optionalAuth, async (req, res) => {
    try {
        if (req.user && req.user.userId) {
            await User.findByIdAndUpdate(req.user.userId, { $inc: { tokenVersion: 1 } });
        }
        clearAuthCookie(res);
        res.json({ success: true, message: "Logged out successfully." });
    } catch (err) {
        console.error("Logout error:", err);
        clearAuthCookie(res);
        res.json({ success: true, message: "Logged out." });
    }
});

// @route GET /api/auth/verify
router.get("/verify", requireAuth, async (req, res) => {
    res.json({
        valid: true,
        user: req.user
    });
});

// @route GET /api/auth/check-admin
// Fixes BUG-003: Derive identity exclusively from verified session token; untrusted query params removed
router.get("/check-admin", requireAuth, async (req, res) => {
    try {
        const isAdmin = req.user && req.user.role === "admin";
        res.json({ isAdmin });
    } catch (error) {
        console.error("Check admin error:", error);
        res.status(500).json({ isAdmin: false, message: "Error checking admin privilege" });
    }
});

// @route POST /api/auth/upload-profile-picture
// Fixes BUG-004: Requires authentication; derives target userId strictly from verified JWT session
router.post("/upload-profile-picture", requireAuth, (req, res, next) => {
    upload.single("profilePicture")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ message: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ message: err.message || "Invalid file upload." });
        }
        next();
    });
}, async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({ message: "Authentication required." });
        }
        
        if (!req.file) {
            return res.status(400).json({ message: "No image file uploaded." });
        }

        // BUG-041: Deep magic-byte validation of actual uploaded file content
        const filePath = req.file.path;
        let headerBuffer = Buffer.alloc(16);
        let fd = null;
        try {
            fd = fs.openSync(filePath, "r");
            fs.readSync(fd, headerBuffer, 0, 16, 0);
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch (e) {}
            }
        }

        if (!isValidImageBuffer(headerBuffer)) {
            // Immediately purge fraudulent non-image payload from storage
            try { fs.unlinkSync(filePath); } catch (e) {}
            return res.status(400).json({ 
                message: "File content validation failed. Only genuine JPEG, PNG, GIF, and WebP images are allowed." 
            });
        }

        // BUG-045: Actual Avatar Image Validation, Metadata Stripping & Safe Re-encoding via sharp
        const uploadDir = path.dirname(filePath);
        const fileExt = path.extname(filePath).toLowerCase();
        const sanitizedFilename = `avatar_${crypto.randomBytes(16).toString('hex')}_${Date.now()}${fileExt === '.jpg' || fileExt === '.jpeg' ? '.jpg' : '.png'}`;
        const sanitizedFilePath = path.join(uploadDir, sanitizedFilename);

        try {
            // BUG-045: Restrict max input pixels to 16.7MP (4096x4096) to prevent decompression bombs
            const image = sharp(filePath, { limitInputPixels: 16777216 });
            const metadata = await image.metadata();

            // Validate that sharp successfully recognized a supported raster image format
            if (!metadata.format || !["jpeg", "png", "webp", "gif"].includes(metadata.format)) {
                try { fs.unlinkSync(filePath); } catch (e) {}
                return res.status(400).json({ 
                    message: "Unsupported or invalid image format. Only JPEG, PNG, GIF, and WebP are allowed." 
                });
            }

            // Validate dimensions and total pixel count
            const totalPixels = (metadata.width || 0) * (metadata.height || 0);
            if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 || totalPixels > 16777216) {
                try { fs.unlinkSync(filePath); } catch (e) {}
                return res.status(400).json({ 
                    message: "Image dimensions exceed maximum allowed size (4096x4096 pixels)." 
                });
            }

            // Re-encode and strip all EXIF/metadata
            if (metadata.format === "jpeg") {
                await image
                    .rotate() // auto-orient based on EXIF before stripping
                    .jpeg({ quality: 85, mozjpeg: true })
                    .toFile(sanitizedFilePath);
            } else {
                await image
                    .rotate()
                    .png({ compressionLevel: 8 })
                    .toFile(sanitizedFilePath);
            }

            // Safely remove the raw un-sanitized uploaded file
            try { fs.unlinkSync(filePath); } catch (e) {}

        } catch (sharpErr) {
            try { fs.unlinkSync(filePath); } catch (e) {}
            return res.status(400).json({ 
                message: "Image processing failed. File is corrupt, malformed, or contains invalid image data." 
            });
        } finally {
            // Absolute guarantee: raw temporary upload file is never retained
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) {}
            }
        }
        
        const relativePath = `/uploads/profile/${sanitizedFilename}`;
        const user = await User.findByIdAndUpdate(
            userId, 
            { profilePicture: relativePath },
            { new: true }
        );
        
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        
        res.json({ 
            message: "Profile picture updated successfully", 
            profilePicture: relativePath 
        });
    } catch (error) {
        console.error("Error uploading profile picture:", error);
        res.status(500).json({ message: "Error uploading profile picture." });
    }
});

// @route POST /api/auth/change-password
// Fixes BUG-047: Password change invalidates all existing JWT sessions by bumping tokenVersion
router.post("/change-password", requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        const userId = req.user.userId;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: "Current password and new password are required." });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: "New password must be at least 6 characters long." });
        }

        if (confirmPassword && newPassword !== confirmPassword) {
            return res.status(400).json({ message: "Passwords do not match." });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Incorrect current password." });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();

        const token = generateToken(user);
        setAuthCookie(res, token);

        res.json({
            success: true,
            message: "Password changed successfully. All previous sessions have been invalidated.",
            token
        });
    } catch (err) {
        console.error("Change password error:", err);
        res.status(500).json({ message: "Error changing password: " + err.message });
    }
});

// @route GET /api/auth/profile/:userId
router.get("/profile/:userId", async (req, res) => {
    try {
        const userId = req.params.userId;
        const user = await User.findById(userId)
            .select("-password")
            .populate("problemsSolved", "title difficulty topic");

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        const submissionCount = user.submissions ? user.submissions.length : 0;
        const acceptedCount = user.submissions
            ? user.submissions.filter(sub => sub.status === "Accepted").length
            : 0;

        const stats = {
            problemsSolved: user.problemsSolved ? user.problemsSolved.length : 0,
            totalSubmissions: submissionCount,
            acceptedSubmissions: acceptedCount,
            acceptanceRate: submissionCount > 0 ? Math.round((acceptedCount / submissionCount) * 100) : 0
        };

        res.json({
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                role: user.role || "user",
                profilePicture: user.profilePicture || "/profile.png",
                contestRating: user.contestRating || { current: 1500, highest: 1500, history: [] },
                contestsParticipated: user.contestsParticipated || [],
                createdAt: user.createdAt
            },
            stats,
            submissions: user.submissions ? user.submissions.slice(-10).reverse() : []
        });
    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).json({ message: "Error fetching user profile" });
    }
});

// @route GET /api/auth/user/:userId/submissions
router.get("/user/:userId/submissions", async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).populate("submissions.problem", "title difficulty");
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        res.json(user.submissions || []);
    } catch (error) {
        res.status(500).json({ message: "Error fetching submissions" });
    }
});

module.exports = router;