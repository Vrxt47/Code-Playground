const express = require("express");
const router = express.Router();
const Discussion = require("../models/Discussion");
const Comment = require("../models/Comment");
const User = require("../models/User");
const { optionalAuth, requireAuth } = require("../middleware/auth");

// Get all discussions with pagination
router.get("/", async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        
        // Apply filters if provided
        let query = {};
        if (req.query.tag) {
            query.tags = req.query.tag;
        }
        
        // Apply search if provided
        if (req.query.search) {
            query.$or = [
                { title: { $regex: req.query.search, $options: 'i' } },
                { content: { $regex: req.query.search, $options: 'i' } }
            ];
        }
        
        // Get discussions with pagination
        const discussions = await Discussion.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate("author", "username");
        
        // Get total count for pagination
        const totalDiscussions = await Discussion.countDocuments(query);
        
        res.json({
            discussions,
            totalPages: Math.ceil(totalDiscussions / limit),
            currentPage: page
        });
    } catch (error) {
        console.error("Error fetching discussions:", error);
        res.status(500).json({ message: "Error fetching discussions" });
    }
});

// Create a new discussion
router.post("/", optionalAuth, async (req, res) => {
    try {
        const { title, content, tags } = req.body;
        const authorId = req.user ? req.user.userId : req.body.userId;
        
        if (!title || typeof title !== "string" || !title.trim()) {
            return res.status(400).json({ message: "Discussion title is required." });
        }

        if (title.trim().length > 200) {
            return res.status(400).json({ message: "Discussion title cannot exceed 200 characters." });
        }

        if (!content || typeof content !== "string" || !content.trim()) {
            return res.status(400).json({ message: "Discussion content is required." });
        }

        if (content.length > 20000) {
            return res.status(400).json({ message: "Discussion content cannot exceed 20,000 characters." });
        }

        if (!authorId) {
            return res.status(401).json({ message: "User identification or authentication required." });
        }
        
        // Get user information
        const user = await User.findById(authorId);
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        
        // Sanitize tags: keep only alphanumeric and hyphens/underscores/spaces, max 10 tags
        const sanitizedTags = Array.isArray(tags) 
            ? tags.map(t => String(t).trim().replace(/[^\w\s-]/g, '').slice(0, 30)).filter(Boolean).slice(0, 10)
            : [];

        // Create discussion
        const discussion = new Discussion({
            title: title.trim(),
            content: content.trim(),
            author: authorId,
            authorName: user.username,
            tags: sanitizedTags
        });
        
        await discussion.save();
        
        res.status(201).json(discussion);
    } catch (error) {
        console.error("Error creating discussion:", error);
        res.status(500).json({ message: "Error creating discussion: " + error.message });
    }
});

// Get single discussion with comments
router.get("/:id", async (req, res) => {
    try {
        const discussion = await Discussion.findById(req.params.id)
            .populate({
                path: "comments",
                options: { sort: { createdAt: 1 } }
            });
        
        if (!discussion) {
            return res.status(404).json({ message: "Discussion not found" });
        }
        
        res.json(discussion);
    } catch (error) {
        console.error("Error fetching discussion:", error);
        res.status(500).json({ message: "Error fetching discussion" });
    }
});

// Add comment to a discussion
router.post("/:id/comments", optionalAuth, async (req, res) => {
    try {
        const { content } = req.body;
        const authorId = req.user ? req.user.userId : req.body.userId;
        const discussionId = req.params.id;
        
        if (!content || typeof content !== "string" || !content.trim()) {
            return res.status(400).json({ message: "Comment content cannot be empty." });
        }

        if (content.length > 5000) {
            return res.status(400).json({ message: "Comment cannot exceed 5,000 characters." });
        }

        if (!authorId) {
            return res.status(401).json({ message: "User identification or authentication required." });
        }
        
        // Check if discussion exists
        const discussion = await Discussion.findById(discussionId);
        if (!discussion) {
            return res.status(404).json({ message: "Discussion not found." });
        }
        
        // Get user information
        const user = await User.findById(authorId);
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        
        // Create comment
        const comment = new Comment({
            content: content.trim(),
            author: authorId,
            authorName: user.username,
            discussion: discussionId
        });
        
        // Save comment
        await comment.save();
        
        // Add comment to discussion
        discussion.comments.push(comment._id);
        await discussion.save();
        
        res.status(201).json(comment);
    } catch (error) {
        console.error("Error adding comment:", error);
        res.status(500).json({ message: "Error adding comment: " + error.message });
    }
});

// Update discussion upvotes/downvotes
router.put("/:id/vote", async (req, res) => {
    try {
        const { vote, userId } = req.body;
        const discussionId = req.params.id;
        
        if (!userId) {
            return res.status(400).json({ message: "User ID is required" });
        }
        
        if (vote !== "up" && vote !== "down") {
            return res.status(400).json({ message: "Vote must be 'up' or 'down'" });
        }
        
        // Find discussion
        const discussion = await Discussion.findById(discussionId);
        if (!discussion) {
            return res.status(404).json({ message: "Discussion not found" });
        }

        // Check if user has already voted
        const hasUpvoted = discussion.upvotedBy.includes(userId);
        const hasDownvoted = discussion.downvotedBy.includes(userId);

        if (vote === "up") {
            if (hasUpvoted) {
                // Remove upvote
                discussion.upvotes -= 1;
                discussion.upvotedBy = discussion.upvotedBy.filter(id => id.toString() !== userId);
            } else {
                // Add upvote
                discussion.upvotes += 1;
                discussion.upvotedBy.push(userId);
                
                // Remove downvote if exists
                if (hasDownvoted) {
                    discussion.downvotes -= 1;
                    discussion.downvotedBy = discussion.downvotedBy.filter(id => id.toString() !== userId);
                }
            }
        } else {
            if (hasDownvoted) {
                // Remove downvote
                discussion.downvotes -= 1;
                discussion.downvotedBy = discussion.downvotedBy.filter(id => id.toString() !== userId);
            } else {
                // Add downvote
                discussion.downvotes += 1;
                discussion.downvotedBy.push(userId);
                
                // Remove upvote if exists
                if (hasUpvoted) {
                    discussion.upvotes -= 1;
                    discussion.upvotedBy = discussion.upvotedBy.filter(id => id.toString() !== userId);
                }
            }
        }
        
        await discussion.save();
        
        res.json({
            upvotes: discussion.upvotes,
            downvotes: discussion.downvotes,
            upvotedBy: discussion.upvotedBy,
            downvotedBy: discussion.downvotedBy
        });
    } catch (error) {
        console.error("Error voting:", error);
        res.status(500).json({ message: "Error voting" });
    }
});

// Get popular tags
router.get("/tags/popular", async (req, res) => {
    try {
        const tags = await Discussion.aggregate([
            { $unwind: "$tags" },
            { $group: { _id: "$tags", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]);
        
        res.json(tags);
    } catch (error) {
        console.error("Error fetching popular tags:", error);
        res.status(500).json({ message: "Error fetching popular tags" });
    }
});

module.exports = router; 