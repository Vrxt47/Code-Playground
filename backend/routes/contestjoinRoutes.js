const express = require('express');
const router = express.Router();
const Contest = require('../models/Contest');
const { requireAuth } = require('../middleware/auth');
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

router.post('/:contestId', requireAuth, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { contestId } = req.params;
        const { contestCode } = req.body;

        // Validate IDs
        if (!ObjectId.isValid(userId) || !ObjectId.isValid(contestId)) {
            return res.status(400).json({ 
                success: false,
                message: 'Invalid ID format' 
            });
        }

        const contest = await Contest.findById(contestId);
        
        if (!contest) {
            return res.status(404).json({ 
                success: false,
                message: 'Contest not found' 
            });
        }

        await contest.updateStatus();

        if (contest.status === 'Completed' || contest.ratingsFinalized) {
            return res.status(400).json({
                success: false,
                message: 'Contest has already ended. Registration is closed.'
            });
        }

        // Check if user already joined
        const isParticipant = contest.participants.some(p => 
            p.user && p.user.toString() === userId.toString()
        );
        
        if (isParticipant) {
            return res.status(200).json({ 
                success: true, 
                message: 'Already registered', 
                contestId: contest._id 
            });
        }

        // For Private contests, verify contest code
        const isCreator = contest.createdBy && contest.createdBy.toString() === userId.toString();
        const isAdmin = req.user && req.user.role === 'admin';
        if (contest.visibility === 'Private' && !isCreator && !isAdmin) {
            if (!contestCode || contestCode.trim().toUpperCase() !== contest.contestCode.toUpperCase()) {
                return res.status(403).json({
                    success: false,
                    message: 'Invalid or missing contest code for this private contest.'
                });
            }
        }

        // Concurrency-safe atomic registration:
        // Pushes to BOTH participants and leaderboard in a single atomic database operation
        const userObjId = new ObjectId(userId);
        const currentCount = contest.participants ? contest.participants.length : 0;
        const updated = await Contest.findOneAndUpdate(
            { _id: contestId, "participants.user": { $ne: userObjId } },
            { 
                $push: { 
                    participants: { user: userObjId, registeredAt: new Date() },
                    leaderboard: {
                        user: userObjId,
                        totalScore: 0,
                        submissions: [],
                        rank: currentCount + 1,
                        ratingProcessed: false
                    }
                } 
            },
            { new: true }
        );

        if (!updated) {
            // Already joined (e.g. concurrent request); ensure leaderboard entry exists if missing
            await Contest.updateOne(
                { _id: contestId, "leaderboard.user": { $ne: userObjId } },
                {
                    $push: {
                        leaderboard: {
                            user: userObjId,
                            totalScore: 0,
                            submissions: [],
                            rank: currentCount + 1,
                            ratingProcessed: false
                        }
                    }
                }
            );
        }

        res.json({ 
            success: true,
            message: 'Successfully joined contest',
            contestId: contest._id
        });
    } catch (error) {
        console.error('Error joining contest:', error);
        res.status(500).json({ 
            success: false,
            message: 'Server error',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;