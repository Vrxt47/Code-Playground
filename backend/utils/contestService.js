const mongoose = require("mongoose");
const Contest = require("../models/Contest");
const User = require("../models/User");
const Problem = require("../models/Problem");

/**
 * Updates contest leaderboard when a participant submits a solution
 */
async function updateContestLeaderboard(userId, problemId, status, contestId, problemDifficulty, retries = 5, submissionTime = null) {
    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(problemId) || !mongoose.Types.ObjectId.isValid(contestId)) {
        throw new Error("Invalid userId, problemId, or contestId");
    }

    const contest = await Contest.findById(contestId);
    if (!contest) throw new Error("Contest not found");

    const now = submissionTime || new Date();
    if (now < contest.startTime || now > contest.endTime || contest.status === 'Completed' || contest.ratingsFinalized || contest.ratingsFinalizationStatus === 'Completed') {
        throw new Error("Contest is not active");
    }

    const isProblemInContest = contest.problems.some(p => p.toString() === problemId.toString());
    if (!isProblemInContest) {
        throw new Error("Problem is not part of this contest");
    }

    const isParticipant = contest.participants.some(p => 
        p.user && p.user.toString() === userId.toString()
    );
    const isCreator = contest.createdBy && contest.createdBy.toString() === userId.toString();

    // Verify participation authorization
    if (!isParticipant && !isCreator) {
        if (contest.visibility === 'Private') {
            throw new Error("User is not registered for this private contest");
        } else {
            contest.participants.push({ 
                user: new mongoose.Types.ObjectId(userId),
                registeredAt: new Date()
            });
        }
    }

    let leaderboardEntry = contest.leaderboard.find(
        entry => entry.user && entry.user.toString() === userId.toString()
    );

    if (!leaderboardEntry) {
        contest.leaderboard.push({
            user: new mongoose.Types.ObjectId(userId),
            totalScore: 0,
            submissions: []
        });
        leaderboardEntry = contest.leaderboard[contest.leaderboard.length - 1];
    }

    const existingSubmission = leaderboardEntry.submissions.find(
        sub => sub.problem.toString() === problemId.toString()
    );

    if (status === "Accepted") {
        if (existingSubmission && existingSubmission.score > 0) {
            return {
                updated: false,
                message: "Problem already solved",
                totalScore: leaderboardEntry.totalScore,
                problemsCount: leaderboardEntry.submissions.filter(s => s.score > 0).length
            };
        }

        let score = 100;
        switch (problemDifficulty) {
            case "Easy": score = 100; break;
            case "Medium": score = 200; break;
            case "Hard": score = 300; break;
            default: score = 100;
        }

        const elapsedMs = Math.max(0, now.getTime() - new Date(contest.startTime).getTime());

        if (existingSubmission) {
            existingSubmission.score = score;
            if (!existingSubmission.timeTaken) {
                existingSubmission.timeTaken = elapsedMs;
            }
        } else {
            leaderboardEntry.submissions.push({
                problem: new mongoose.Types.ObjectId(problemId),
                score: score,
                timeTaken: elapsedMs
            });
        }

        leaderboardEntry.totalScore = leaderboardEntry.submissions.reduce(
            (total, sub) => total + (sub.score || 0), 0
        );

        // Sort leaderboard deterministically: totalScore desc, total timeTaken asc, user ID asc
        contest.leaderboard.sort((a, b) => {
            const scoreDiff = (b.totalScore || 0) - (a.totalScore || 0);
            if (scoreDiff !== 0) return scoreDiff;

            const timeA = (a.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
            const timeB = (b.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
            if (timeA !== timeB) return timeA - timeB;

            const idA = a.user ? a.user.toString() : "";
            const idB = b.user ? b.user.toString() : "";
            return idA.localeCompare(idB);
        });

        contest.leaderboard.forEach((entry, index) => {
            entry.rank = index + 1;
        });

        try {
            await contest.save();
        } catch (saveError) {
            if (saveError.name === "VersionError" && retries > 0) {
                const backoffMs = Math.floor(Math.random() * 50) + (6 - retries) * 40;
                await new Promise(r => setTimeout(r, backoffMs));
                return updateContestLeaderboard(userId, problemId, status, contestId, problemDifficulty, retries - 1, now);
            }
            throw saveError;
        }

        return {
            updated: true,
            message: "Leaderboard updated successfully",
            totalScore: leaderboardEntry.totalScore,
            problemsCount: leaderboardEntry.submissions.filter(s => s.score > 0).length
        };
    }

    return { 
        updated: false,
        message: "Submission was not accepted",
        totalScore: leaderboardEntry.totalScore,
        problemsCount: leaderboardEntry.submissions.filter(sub => sub.score > 0).length
    };
}

/**
 * Updates user contest rating based on contest performance
 * Uses Compare-And-Swap (CAS) with bounded retries to prevent concurrent contest finalizations
 * from overwriting each other's rating updates.
 */
async function updateUserRating(user, contest, performance, retries = 5) {
    if (!user) return null;
    const userId = user._id ? user._id : user;
    if (!mongoose.Types.ObjectId.isValid(userId)) return null;

    // Determine problem difficulties for performance
    const problemsBySolved = { Easy: 0, Medium: 0, Hard: 0 };
    for (const submission of (performance.submissions || [])) {
        if (submission.score > 0) {
            const problem = (contest.problems || []).find(p => 
                (p._id ? p._id.toString() : p.toString()) === submission.problem.toString()
            );
            
            let problemDifficulty = (problem && problem.difficulty) ? problem.difficulty : null;
            if (!problemDifficulty && submission.problem) {
                try {
                    const probDoc = await Problem.findById(submission.problem).select("difficulty");
                    if (probDoc && probDoc.difficulty) {
                        problemDifficulty = probDoc.difficulty;
                    }
                } catch (e) {
                    // ignore and fallback
                }
            }

            if (problemDifficulty && problemsBySolved[problemDifficulty] !== undefined) {
                problemsBySolved[problemDifficulty]++;
            } else {
                problemsBySolved.Medium++;
            }
        }
    }

    const totalSolved = Object.values(problemsBySolved).reduce((a, b) => a + b, 0);
    const contestEntry = {
        contest: contest._id,
        rank: performance.rank || 0,
        score: performance.totalScore || 0,
        problemsSolved: totalSolved,
        timestamp: new Date()
    };

    // Retry loop for Compare-And-Swap (CAS) optimistic concurrency
    for (let attempt = 0; attempt <= retries; attempt++) {
        // Reload fresh user document from MongoDB on every attempt
        const freshUser = await User.findById(userId);
        if (!freshUser) return null;

        if (!freshUser.contestRating) {
            freshUser.contestRating = { current: 1500, highest: 1500, history: [] };
        }

        // Idempotency guard: prevent duplicate rating updates for the same contest
        const alreadyApplied = (freshUser.contestRating.history || []).some(
            h => h.contestId && h.contestId.toString() === contest._id.toString()
        );
        if (alreadyApplied) {
            return freshUser;
        }

        const expectedCurrent = (freshUser.contestRating.current !== undefined && freshUser.contestRating.current !== null)
            ? freshUser.contestRating.current
            : 1500;

        let ratingChange = 0;
        if (expectedCurrent < 1000) {
            ratingChange += problemsBySolved.Easy * 100;
            ratingChange += problemsBySolved.Medium * 150;
            ratingChange += problemsBySolved.Hard * 200;
        } else if (expectedCurrent < 1600) {
            ratingChange += problemsBySolved.Easy * 50;
            ratingChange += problemsBySolved.Medium * 100;
            ratingChange += problemsBySolved.Hard * 150;
        } else {
            ratingChange += problemsBySolved.Easy * 25;
            ratingChange += problemsBySolved.Medium * 50;
            ratingChange += problemsBySolved.Hard * 100;
        }

        const newRating = Math.max(0, expectedCurrent + ratingChange);
        const newHighest = Math.max(
            (freshUser.contestRating && freshUser.contestRating.highest != null) 
                ? freshUser.contestRating.highest 
                : 1500, 
            newRating
        );

        const historyEntry = {
            contestId: contest._id,
            contestName: contest.name,
            rating: newRating,
            change: ratingChange,
            timestamp: new Date()
        };

        // If expectedCurrent is default 1500, match both explicit 1500 and missing/null fields
        const currentQuery = expectedCurrent === 1500
            ? { $in: [1500, null] }
            : expectedCurrent;

        // Atomic Compare-And-Swap:
        // Updates ONLY if "contestRating.current" matches expectedCurrent
        // (handling default 1500, null, or missing fields)
        // AND this contestId is NOT in history
        const updatedUser = await User.findOneAndUpdate(
            {
                _id: userId,
                "contestRating.current": currentQuery,
                "contestRating.history.contestId": { $ne: contest._id }
            },
            {
                $set: {
                    "contestRating.current": newRating,
                    "contestRating.highest": newHighest
                },
                $push: {
                    "contestRating.history": historyEntry
                }
            },
            { new: true }
        );

        if (updatedUser) {
            // Also update contestsParticipated idempotently
            const existingIndex = (updatedUser.contestsParticipated || []).findIndex(
                cp => cp.contest && cp.contest.toString() === contest._id.toString()
            );
            if (existingIndex >= 0) {
                await User.updateOne(
                    { _id: userId, "contestsParticipated.contest": contest._id },
                    { $set: { "contestsParticipated.$": contestEntry } }
                );
            } else {
                await User.updateOne(
                    { _id: userId, "contestsParticipated.contest": { $ne: contest._id } },
                    { $push: { contestsParticipated: contestEntry } }
                );
            }
            return updatedUser;
        }

        // If updatedUser is null: either contest was applied in parallel, or expectedCurrent changed.
        // If not the last attempt, backoff with random jitter and retry on fresh state.
        if (attempt < retries) {
            const backoffMs = Math.floor(Math.random() * 40) + (attempt + 1) * 20;
            await new Promise(r => setTimeout(r, backoffMs));
        }
    }

    return await User.findById(userId);
}

/**
 * Ends a contest, assigns final ranks, and recalculates all user ratings
 * Resumable and idempotent: only marks contest Completed after all participants are processed.
 * Supports owner-specific lock token, lock renewal / heartbeat, and safe release.
 */
async function endContest(contestId, options = {}) {
    if (!mongoose.Types.ObjectId.isValid(contestId)) {
        throw new Error("Invalid contest ID");
    }
    
    const contest = await Contest.findById(contestId)
        .populate('problems')
        .populate('leaderboard.user');
        
    if (!contest) throw new Error("Contest not found");

    // Idempotency: If contest is already fully finalized, return immediately without recalculating
    if (contest.ratingsFinalized || contest.ratingsFinalizationStatus === 'Completed') {
        return contest;
    }

    const runLockId = options.lockToken || new mongoose.Types.ObjectId().toString();
    const staleTimeoutMs = options.staleTimeoutMs || 30000; // 30 seconds default
    const staleThreshold = new Date(Date.now() - staleTimeoutMs);

    // Atomic lock acquisition: only one process acquires the lock
    const lockAcquired = await Contest.findOneAndUpdate(
        {
            _id: contestId,
            ratingsFinalizationStatus: { $ne: 'Completed' },
            ratingsFinalized: { $ne: true },
            $or: [
                { finalizationLock: runLockId },
                { finalizationLock: null },
                { finalizationLock: { $exists: false } },
                { finalizationStartedAt: { $lt: staleThreshold } },
                { finalizationStartedAt: null },
                { finalizationStartedAt: { $exists: false } }
            ]
        },
        {
            $set: {
                status: 'Completed',
                ratingsFinalizationStatus: 'Processing',
                finalizationLock: runLockId,
                finalizationStartedAt: new Date()
            }
        },
        { new: true }
    );

    if (!lockAcquired) {
        // Another process is actively finalizing. Wait for it to finish.
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 100));
            const check = await Contest.findById(contestId).populate('problems').populate('leaderboard.user');
            if (check && (check.ratingsFinalized || check.ratingsFinalizationStatus === 'Completed')) {
                return check;
            }
        }
        return await Contest.findById(contestId).populate('problems').populate('leaderboard.user');
    }

    // Helper: renew lock ownership during processing (heartbeat)
    const renewLock = async () => {
        const renewed = await Contest.findOneAndUpdate(
            { _id: contestId, finalizationLock: runLockId },
            { $set: { finalizationStartedAt: new Date() } },
            { new: true }
        );
        return !!renewed;
    };

    try {
        await contest.calculateFinalLeaderboard();
        await contest.populate('leaderboard.user');
        await contest.populate('problems');
        
        let allProcessed = true;
        for (const entry of contest.leaderboard) {
            if (!entry.user) continue;
            if (entry.ratingProcessed) continue;

            // Heartbeat: verify we still own the lock before processing next user
            const ownsLock = await renewLock();
            if (!ownsLock) {
                // Lock was lost or preempted by another worker. Abort to prevent state collision.
                return await Contest.findById(contestId).populate('problems').populate('leaderboard.user');
            }

            try {
                await updateUserRating(entry.user, contest, entry);
                const userId = entry.user._id ? entry.user._id : entry.user;
                
                // Update leaderboard entry only if we still own the lock
                const updateRes = await Contest.updateOne(
                    { _id: contestId, finalizationLock: runLockId, "leaderboard.user": userId },
                    { $set: { "leaderboard.$.ratingProcessed": true } }
                );

                if (updateRes.matchedCount === 0) {
                    // Lock was lost during updateUserRating. Abort immediately.
                    return await Contest.findById(contestId).populate('problems').populate('leaderboard.user');
                }
                entry.ratingProcessed = true;
            } catch (userRatingError) {
                console.error(`Failed to update rating for user ${entry.user._id || entry.user}:`, userRatingError);
                allProcessed = false;
            }
        }

        // Verify lock ownership before marking completed
        if (allProcessed) {
            const finalizedDoc = await Contest.findOneAndUpdate(
                {
                    _id: contestId,
                    finalizationLock: runLockId
                },
                {
                    $set: {
                        status: 'Completed',
                        ratingsFinalized: true,
                        ratingsFinalizationStatus: 'Completed',
                        finalizationLock: null,
                        finalizedAt: new Date()
                    }
                },
                { new: true }
            ).populate('problems').populate('leaderboard.user');

            if (finalizedDoc) {
                return finalizedDoc;
            } else {
                return await Contest.findById(contestId).populate('problems').populate('leaderboard.user');
            }
        } else {
            // Partial failure: release lock ONLY if we still own it
            await Contest.updateOne(
                { _id: contestId, finalizationLock: runLockId },
                { $set: { finalizationLock: null } }
            );
            return await Contest.findById(contestId).populate('problems').populate('leaderboard.user');
        }
    } catch (err) {
        // On error: release lock ONLY if we still own it
        await Contest.updateOne(
            { _id: contestId, finalizationLock: runLockId },
            { $set: { finalizationLock: null } }
        );
        throw err;
    }
}

/**
 * Explicit helper to renew a finalization lock (for external heartbeat or test verification)
 */
async function renewFinalizationLock(contestId, lockToken) {
    if (!mongoose.Types.ObjectId.isValid(contestId) || !lockToken) return false;
    const res = await Contest.findOneAndUpdate(
        { _id: contestId, finalizationLock: lockToken },
        { $set: { finalizationStartedAt: new Date() } },
        { new: true }
    );
    return !!res;
}

module.exports = {
    updateContestLeaderboard,
    updateUserRating,
    endContest,
    renewFinalizationLock
};
