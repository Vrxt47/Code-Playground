const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const Contest = require('../models/Contest');
const User = require('../models/User');
const Problem = require('../models/Problem');
const { requireAuth } = require('../middleware/auth');
const { endContest } = require('../utils/contestService');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// @route GET /api/contests
// @desc Get all public and user contests
router.get('/', async (req, res) => {
    try {
        const contests = await Contest.find()
            .populate({
                path: 'participants.user',
                select: 'username'
            })
            .populate({
                path: 'leaderboard.user',
                select: 'username'
            })
            .populate({
                path: 'createdBy',
                select: 'username'
            })
            .sort({ startTime: -1 });

        // Update contest statuses in real-time in parallel
        await Promise.all(contests.map(c => c.updateStatus()));

        const currentContests = contests.filter(c => c.status !== 'Completed');
        const pastContests = contests.filter(c => c.status === 'Completed');

        res.set("Cache-Control", "public, s-maxage=20, stale-while-revalidate=40");
        res.json({
            currentContests: currentContests.map(c => ({
                _id: c._id,
                name: c.name,
                description: c.description,
                startTime: c.startTime,
                endTime: c.endTime,
                difficulty: c.difficulty,
                participants: c.participants || [],
                status: c.status,
                visibility: c.visibility,
                contestCode: c.contestCode
            })),
            pastContests: pastContests.map(c => ({
                _id: c._id,
                name: c.name,
                description: c.description,
                startTime: c.startTime,
                endTime: c.endTime,
                difficulty: c.difficulty,
                leaderboard: c.leaderboard ? c.leaderboard.map(entry => ({
                    username: entry.user ? entry.user.username : 'Anonymous',
                    score: entry.totalScore || 0,
                    rank: entry.rank || 1
                })) : [],
                status: c.status,
                visibility: c.visibility
            }))
        });
    } catch (error) {
        console.error('Error fetching contests:', error);
        res.status(500).json({ error: 'Failed to fetch contests' });
    }
});

// @route POST /api/contests
// @desc Create a new contest
router.post('/', requireAuth, [
    check('name', 'Contest name is required').not().trim().isEmpty(),
    check('contestCode', 'Contest code is required').not().trim().isEmpty(),
    check('startTime', 'Start time is required').not().isEmpty(),
    check('endTime', 'End time is required').not().isEmpty(),
    check('problems', 'At least one problem is required').isArray({ min: 1 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        const {
            name,
            contestCode,
            description,
            startTime,
            endTime,
            difficulty,
            problems,
            visibility = "Private"
        } = req.body;

        const userId = req.user.userId;

        // Validate date formatting and chronology
        const start = new Date(startTime);
        const end = new Date(endTime);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            return res.status(400).json({ msg: 'Start time and end time must be valid dates.' });
        }

        if (end.getTime() <= start.getTime()) {
            return res.status(400).json({ msg: 'End time must be strictly after start time.' });
        }

        const normalizedCode = contestCode.trim().toUpperCase();
        const existingContest = await Contest.findOne({ 
            contestCode: { $regex: new RegExp(`^${normalizedCode}$`, 'i') } 
        });
        if (existingContest) {
            return res.status(400).json({ msg: 'Contest code already exists. Please choose a unique code.' });
        }

        // Validate that problem IDs exist in DB
        const validProblemIds = problems
            .filter(id => mongoose.Types.ObjectId.isValid(id))
            .map(id => new mongoose.Types.ObjectId(id));

        if (validProblemIds.length === 0) {
            return res.status(400).json({ msg: 'At least one valid problem must be selected.' });
        }

        const foundProblemsCount = await Problem.countDocuments({ _id: { $in: validProblemIds } });
        if (foundProblemsCount !== validProblemIds.length) {
            return res.status(400).json({ msg: 'One or more selected problems do not exist.' });
        }

        const user = await User.findById(userId);
        const isAdmin = user && user.role === 'admin';

        // Only admins can make contests Public
        const finalVisibility = isAdmin && visibility === 'Public' ? 'Public' : 'Private';

        const newContest = new Contest({
            _id: new mongoose.Types.ObjectId(),
            name: name.trim(),
            contestCode: normalizedCode,
            description: description ? description.trim() : 'No description provided',
            startTime: start,
            endTime: end,
            difficulty: difficulty || 'Medium',
            problems: validProblemIds,
            participants: [{ user: new mongoose.Types.ObjectId(userId), registeredAt: new Date() }],
            status: 'Upcoming',
            visibility: finalVisibility,
            leaderboard: [{
                user: new mongoose.Types.ObjectId(userId),
                totalScore: 0,
                submissions: [],
                rank: 1,
                ratingProcessed: false
            }],
            createdBy: new mongoose.Types.ObjectId(userId)
        });

        await newContest.updateStatus();
        const contest = await newContest.save();
        
        res.status(201).json({
            success: true,
            contest: {
                _id: contest._id,
                name: contest.name,
                contestCode: contest.contestCode,
                startTime: contest.startTime,
                endTime: contest.endTime,
                status: contest.status,
                visibility: contest.visibility,
                isAdmin
            }
        });
    } catch (error) {
        console.error('Error creating contest:', error);
        res.status(500).json({ 
            success: false, 
            msg: 'Server error creating contest',
            error: error.message 
        });
    }
});

// @route POST /api/contests/join-by-code
router.post('/join-by-code', requireAuth, [
    check('contestCode', 'Contest code is required').not().trim().isEmpty()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        const { contestCode } = req.body;
        const userId = req.user.userId;
        const normalizedCode = contestCode.trim().toUpperCase();

        const contest = await Contest.findOne({ 
            contestCode: { $regex: new RegExp(`^${normalizedCode}$`, 'i') } 
        });

        if (!contest) {
            return res.status(404).json({ 
                success: false, 
                msg: 'Contest not found with code: ' + contestCode 
            });
        }

        await contest.updateStatus();

        if (contest.status === 'Completed' || contest.ratingsFinalized) {
            return res.status(400).json({
                success: false,
                msg: 'Contest has already ended. Registration is closed.'
            });
        }

        const isParticipant = contest.participants.some(p => p.user && p.user.toString() === userId.toString());
        if (isParticipant) {
            return res.json({
                success: true,
                message: 'Already registered',
                contestId: contest._id
            });
        }

        const userObjId = new mongoose.Types.ObjectId(userId);
        const currentCount = contest.participants ? contest.participants.length : 0;
        const updated = await Contest.findOneAndUpdate(
            { _id: contest._id, "participants.user": { $ne: userObjId } },
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
            await Contest.updateOne(
                { _id: contest._id, "leaderboard.user": { $ne: userObjId } },
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
            contestId: contest._id
        });
    } catch (error) {
        console.error('Error joining contest by code:', error);
        res.status(500).json({ success: false, msg: 'Server error joining contest' });
    }
});

// @route GET /api/contests/:id
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let requestingUserId = req.query.userId;
        let isRequesterAdmin = false;

        // Try extracting user identity from auth token if present
        const token = req.cookies && req.cookies.token
            ? req.cookies.token
            : (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
                ? req.headers.authorization.split(' ')[1]
                : null);

        if (token && process.env.JWT_SECRET) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                requestingUserId = decoded.userId || decoded.id;
                isRequesterAdmin = decoded.role === 'admin';
            } catch (e) {
                // Ignore token verification errors for public GET endpoint
            }
        }
        
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid contest ID' });
        }
        
        const contest = await Contest.findById(id)
            .populate({
                path: 'participants.user',
                select: 'username'
            })
            .populate({
                path: 'leaderboard.user',
                select: 'username'
            })
            .populate({
                path: 'createdBy',
                select: 'username _id'
            })
            .populate({
                path: 'problems',
                select: 'title difficulty'
            });
            
        if (!contest) {
            return res.status(404).json({ error: 'Contest not found' });
        }
        
        await contest.updateStatus();
        
        let userSolvedProblems = [];
        let userLeaderboardEntry = null;
        
        if (requestingUserId && mongoose.Types.ObjectId.isValid(requestingUserId)) {
            const leaderboardEntry = contest.leaderboard.find(
                entry => entry.user && entry.user._id && entry.user._id.toString() === requestingUserId.toString()
            );
            
            if (leaderboardEntry) {
                userLeaderboardEntry = {
                    totalScore: leaderboardEntry.totalScore,
                    rank: leaderboardEntry.rank || 0,
                    problemsCount: leaderboardEntry.submissions ? leaderboardEntry.submissions.filter(s => s.score > 0).length : 0
                };
                
                userSolvedProblems = (leaderboardEntry.submissions || [])
                    .filter(sub => sub.score > 0)
                    .map(sub => sub.problem ? sub.problem.toString() : "");
            }
        }

        // Deterministic leaderboard sorting: score desc, timeTaken asc, user id asc
        const sortedLeaderboard = (contest.leaderboard || []).slice().sort((a, b) => {
            const scoreDiff = (b.totalScore || 0) - (a.totalScore || 0);
            if (scoreDiff !== 0) return scoreDiff;
            const timeA = (a.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
            const timeB = (b.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
            if (timeA !== timeB) return timeA - timeB;
            const idA = a.user ? (a.user._id || a.user).toString() : "";
            const idB = b.user ? (b.user._id || b.user).toString() : "";
            return idA.localeCompare(idB);
        });

        if (userLeaderboardEntry && requestingUserId) {
            const userIdx = sortedLeaderboard.findIndex(e => e.user && (e.user._id || e.user).toString() === requestingUserId.toString());
            if (userIdx !== -1) {
                userLeaderboardEntry.rank = userIdx + 1;
            }
        }

        // Determine authorization for private contest code disclosure
        const isCreator = requestingUserId && contest.createdBy && contest.createdBy._id &&
            contest.createdBy._id.toString() === requestingUserId.toString();
        const canViewContestCode = contest.visibility === 'Public' || isRequesterAdmin || isCreator;
        
        res.json({
            _id: contest._id,
            name: contest.name,
            description: contest.description,
            startTime: contest.startTime,
            endTime: contest.endTime,
            difficulty: contest.difficulty,
            status: contest.status,
            visibility: contest.visibility,
            ratingsFinalized: contest.ratingsFinalized,
            ratingsFinalizationStatus: contest.ratingsFinalizationStatus || (contest.ratingsFinalized ? 'Completed' : 'Pending'),
            participants: contest.participants || [],
            contestCode: canViewContestCode ? contest.contestCode : undefined,
            createdBy: contest.createdBy ? contest.createdBy._id : null,
            createdByName: contest.createdBy ? contest.createdBy.username : "Admin",
            createdAt: contest.createdAt,
            problems: (contest.problems || []).map(p => ({
                _id: p._id,
                title: p.title,
                difficulty: p.difficulty,
                solved: userSolvedProblems.includes(p._id.toString())
            })),
            leaderboard: sortedLeaderboard.map((entry, idx) => ({
                userId: entry.user ? entry.user._id : null,
                username: entry.user ? entry.user.username : 'Unknown',
                totalScore: entry.totalScore || 0,
                rank: idx + 1,
                problemsCount: entry.submissions ? entry.submissions.filter(s => s.score > 0).length : 0
            })),
            userStats: userLeaderboardEntry
        });
    } catch (error) {
        console.error('Error fetching contest:', error);
        res.status(500).json({ error: 'Failed to fetch contest details' });
    }
});

// @route POST /api/contests/:id/end and /api/contests/contest/:id/end
// @desc End contest and finalize ratings (Creator or Admin only)
router.post(['/:id/end', '/contest/:id/end'], requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid contest ID' });
        }

        const contest = await Contest.findById(id);
        if (!contest) {
            return res.status(404).json({ success: false, message: 'Contest not found' });
        }

        const isCreator = contest.createdBy && contest.createdBy.toString() === req.user.userId.toString();
        const isAdmin = req.user && req.user.role === 'admin';

        if (!isCreator && !isAdmin) {
            return res.status(403).json({ success: false, message: 'Only the contest creator or an administrator can end this contest.' });
        }

        const finalizedContest = await endContest(id);
        res.json({
            success: true,
            message: `Contest '${finalizedContest.name}' has been ended and user ratings recalculated.`,
            status: finalizedContest.status,
            ratingsFinalized: finalizedContest.ratingsFinalized
        });
    } catch (error) {
        console.error('Error ending contest:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to end contest' });
    }
});

module.exports = router;