const express = require("express");
const Problem = require("../models/Problem");
const User = require("../models/User");
const Contest = require("../models/Contest");
const executeCode = require("../utils/executeCode");
const { compareOutputs, sanitizeProblemForClient } = require("../utils/judgeComparison");
const { updateContestLeaderboard, endContest } = require("../utils/contestService");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

const router = express.Router();

// @route POST /api/problems/add
// Protected: Administrator access required to create problems
router.post("/add", requireAdmin, async (req, res) => {
    try {
        const { 
            title, 
            description, 
            difficulty, 
            topic,
            tags,
            inputFormat, 
            outputFormat, 
            constraints, 
            sampleInput,
            sampleOutput,
            testCases 
        } = req.body;
        
        if (!title || !description) {
            return res.status(400).json({ message: "Title and description are required" });
        }

        const problem = new Problem({ 
            title, 
            description, 
            difficulty: difficulty || "Medium", 
            topic: topic || "Algorithms",
            tags: tags || [],
            inputFormat: inputFormat || "", 
            outputFormat: outputFormat || "", 
            constraints: constraints || {},
            sampleInput: sampleInput || "",
            sampleOutput: sampleOutput || "",
            testCases: testCases || [] 
        });
        
        await problem.save();
        res.status(201).json(problem);
    } catch (error) {
        console.error("Error creating problem:", error);
        res.status(500).json({ message: "Error creating problem: " + error.message });
    }
});

// @route GET /api/problems/search
router.get('/search', async (req, res) => {
    try {
        const searchTerm = (req.query.q || "").trim();
        
        if (!searchTerm || searchTerm.length < 2) {
            return res.json([]);
        }

        const problems = await Problem.find({
            $or: [
                { title: { $regex: searchTerm, $options: 'i' } },
                { description: { $regex: searchTerm, $options: 'i' } },
                { difficulty: { $regex: searchTerm, $options: 'i' } },
                { topic: { $regex: searchTerm, $options: 'i' } }
            ]
        })
        .select('_id title description difficulty topic acceptance submissionsCount acceptedCount')
        .limit(10)
        .lean({ virtuals: true });

        res.json(problems);
    } catch (error) {
        console.error('Problem search error:', error);
        res.status(500).json([]);
    }
});

// @route GET /api/problems
router.get("/", async (req, res) => {
    try {
        const { difficulty, topic, sort, search, limit, page } = req.query;
        let query = {};
        
        if (difficulty && difficulty !== 'all') {
            query.difficulty = difficulty;
        }
        
        if (topic && topic !== 'all') {
            query.topic = { $regex: topic, $options: 'i' };
        }

        if (search && search.trim()) {
            query.$or = [
                { title: { $regex: search.trim(), $options: 'i' } },
                { description: { $regex: search.trim(), $options: 'i' } }
            ];
        }
        
        let sortConfig = { createdAt: -1 };
        if (sort === 'difficulty') {
            sortConfig = { difficulty: 1 };
        } else if (sort === 'most-solved') {
            sortConfig = { acceptedCount: -1 };
        } else if (sort === 'newest') {
            sortConfig = { createdAt: -1 };
        }
        
        let queryBuilder = Problem.find(query)
            .select("-testCases -referenceSolution -solution")
            .sort(sortConfig);
        
        if (limit) {
            const parsedLimit = parseInt(limit);
            if (!isNaN(parsedLimit) && parsedLimit > 0) {
                if (page) {
                    const parsedPage = Math.max(1, parseInt(page) || 1);
                    queryBuilder = queryBuilder.skip((parsedPage - 1) * parsedLimit);
                }
                queryBuilder = queryBuilder.limit(parsedLimit);
            }
        }
        
        const problems = await queryBuilder.lean({ virtuals: true });
        res.set("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
        res.json(problems);
    } catch (error) {
        console.error("Error fetching problems:", error);
        res.status(500).json({ message: "Error fetching problems" });
    }
});

// @route GET /api/problems/:id
// Returns problem metadata and sample test cases only (BUG-012: Hidden test cases are sanitized)
router.get("/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid problem ID" });
        }

        const problem = await Problem.findById(req.params.id);
        if (!problem) {
            return res.status(404).json({ message: "Problem not found" });
        }
        res.set("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
        res.json(sanitizeProblemForClient(problem));
    } catch (error) {
        console.error("Error fetching problem:", error);
        res.status(500).json({ message: "Error fetching problem" });
    }
});

// In-flight active submissions lock to prevent accidental duplicate submissions from rapid clicks (BUG-011)
const activeSubmissions = new Set();

// @route POST /api/problems/:id/submit
// Official submission endpoint: strictly authenticated, evaluates all authoritative server-side test cases,
// enforces contest timing and eligibility, and preserves hidden test case confidentiality.
router.post("/:id/submit", requireAuth, async (req, res) => {
    const userId = req.user.userId;
    const problemId = req.params.id;
    const { code, language, contestId } = req.body;

    if (!code || typeof code !== "string" || !code.trim()) {
        return res.status(400).json({ message: "Source code is required." });
    }

    if (!language || typeof language !== "string") {
        return res.status(400).json({ message: "Programming language is required." });
    }

    if (!ObjectId.isValid(problemId)) {
        return res.status(400).json({ message: "Invalid problem ID." });
    }

    // In-flight submission lock per user + problem to eliminate duplicate submissions
    const lockKey = `${userId}:${problemId}`;
    if (activeSubmissions.has(lockKey)) {
        return res.status(429).json({ message: "A submission for this problem is already being evaluated. Please wait a moment." });
    }

    activeSubmissions.add(lockKey);

    try {
        const problem = await Problem.findById(problemId);
        if (!problem) {
            return res.status(404).json({ message: "Problem not found." });
        }

        // Contest verification (Phase F)
        let activeContest = null;
        if (contestId) {
            if (!ObjectId.isValid(contestId)) {
                return res.status(400).json({ message: "Invalid contest ID." });
            }
            activeContest = await Contest.findById(contestId);
            if (!activeContest) {
                return res.status(404).json({ message: "Contest not found." });
            }

            const now = new Date();
            if (now < activeContest.startTime || activeContest.status === "Upcoming") {
                return res.status(400).json({ message: "Contest has not started yet. Submissions are not permitted." });
            }
            if (now > activeContest.endTime || activeContest.status === "Completed" || activeContest.ratingsFinalized || activeContest.ratingsFinalizationStatus === "Completed") {
                return res.status(400).json({ message: "Contest has ended. Submissions are no longer accepted for this contest." });
            }

            const isProblemInContest = activeContest.problems.some(p => p.toString() === problemId.toString());
            if (!isProblemInContest) {
                return res.status(400).json({ message: "Problem is not part of this contest." });
            }

            const isParticipant = activeContest.participants.some(p => p.user && p.user.toString() === userId.toString());
            const isCreator = activeContest.createdBy && activeContest.createdBy.toString() === userId.toString();
            const isAdmin = req.user && req.user.role === "admin";

            if (activeContest.visibility === "Private") {
                if (!isParticipant && !isCreator && !isAdmin) {
                    return res.status(403).json({ message: "You are not registered for this private contest." });
                }
            } else {
                if (!isParticipant && !isCreator && !isAdmin) {
                    return res.status(403).json({ message: "You must register for this contest before submitting solutions." });
                }
            }
        }

        // Retrieve authoritative test cases from DB (BUG-010)
        const testCasesToRun = (problem.testCases && problem.testCases.length > 0)
            ? problem.testCases
            : [{ input: problem.sampleInput || "", output: problem.sampleOutput || "", isHidden: false }];

        let allTestsPassed = true;
        let finalStatus = "Accepted";
        const results = [];

        for (let i = 0; i < testCasesToRun.length; i++) {
            if (i > 0) {
                // Brief pause between sequential remote executions to avoid remote sandbox burst rate limits
                await new Promise(r => setTimeout(r, 250));
            }
            const tc = testCasesToRun[i];
            const isHidden = !!tc.isHidden;
            try {
                const execResult = await executeCode(code, language, tc.input || "");
                const isSuccess = execResult.status === "success";
                const passed = isSuccess && compareOutputs(execResult.output, tc.output);

                if (!passed) {
                    allTestsPassed = false;
                    if (finalStatus === "Accepted") {
                        if (/time limit exceeded/i.test(execResult.error || "")) {
                            finalStatus = "Time Limit Exceeded";
                        } else if (/compilation|syntax error/i.test(execResult.error || "")) {
                            finalStatus = "Compilation Error";
                        } else if (execResult.error) {
                            finalStatus = "Runtime Error";
                        } else {
                            finalStatus = "Wrong Answer";
                        }
                    }
                }

                if (isHidden) {
                    // BUG-012: Never expose hidden inputs or expected outputs to clients!
                    results.push({
                        testCase: i + 1,
                        isHidden: true,
                        passed,
                        error: passed ? "" : (execResult.error ? "Execution failed on hidden test case" : "Output mismatch on hidden test case")
                    });
                } else {
                    // Public sample test cases can include sanitized details
                    results.push({
                        testCase: i + 1,
                        isHidden: false,
                        input: tc.input,
                        expectedOutput: tc.output,
                        actualOutput: execResult.output,
                        passed,
                        error: execResult.error
                    });
                }
            } catch (tcErr) {
                allTestsPassed = false;
                if (finalStatus === "Accepted") {
                    finalStatus = "Runtime Error";
                }
                results.push({
                    testCase: i + 1,
                    isHidden,
                    passed: false,
                    error: isHidden ? "Internal error on hidden test case" : tcErr.message
                });
            }
        }

        if (!allTestsPassed && finalStatus === "Accepted") {
            finalStatus = "Wrong Answer";
        }

        // Exactly ONE official submission record created (BUG-011)
        problem.submissionsCount = (problem.submissionsCount || 0) + 1;
        if (finalStatus === "Accepted") {
            problem.acceptedCount = (problem.acceptedCount || 0) + 1;
        }
        await problem.save();

        const user = await User.findById(userId);
        if (user) {
            user.submissions.push({
                problem: problem._id,
                language,
                code,
                status: finalStatus,
                timestamp: new Date()
            });

            if (finalStatus === "Accepted" && !user.problemsSolved.some(id => id.toString() === problem._id.toString())) {
                user.problemsSolved.push(problem._id);
            }
            await user.save();
        }

        let contestUpdateResult = null;
        if (activeContest) {
            try {
                contestUpdateResult = await updateContestLeaderboard(
                    userId, problemId, finalStatus, contestId, problem.difficulty
                );
            } catch (contestError) {
                console.error("Contest leaderboard update notice:", contestError.message);
            }
        }

        res.json({
            status: finalStatus,
            totalTestCases: testCasesToRun.length,
            passedTestCases: results.filter(r => r.passed).length,
            results,
            message: finalStatus === "Accepted"
                ? "Solution accepted! All test cases passed."
                : `Solution failed (${results.filter(r => r.passed).length}/${testCasesToRun.length} passed).`,
            contestUpdate: contestUpdateResult
        });
    } catch (error) {
        console.error("Error submitting solution:", error);
        res.status(500).json({ message: "Error submitting solution: " + error.message });
    } finally {
        activeSubmissions.delete(lockKey);
    }
});

// @route PUT /api/problems/:id
// @desc Update an existing problem (Protected: Admin only)
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid problem ID" });
        }

        const {
            title,
            description,
            difficulty,
            topic,
            tags,
            inputFormat,
            outputFormat,
            constraints,
            sampleInput,
            sampleOutput,
            testCases
        } = req.body;

        const updateData = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (difficulty !== undefined) updateData.difficulty = difficulty;
        if (topic !== undefined) updateData.topic = topic;
        if (tags !== undefined) updateData.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim()).filter(Boolean);
        if (inputFormat !== undefined) updateData.inputFormat = inputFormat;
        if (outputFormat !== undefined) updateData.outputFormat = outputFormat;
        if (constraints !== undefined) updateData.constraints = constraints;
        if (sampleInput !== undefined) updateData.sampleInput = sampleInput;
        if (sampleOutput !== undefined) updateData.sampleOutput = sampleOutput;
        if (testCases !== undefined) updateData.testCases = testCases;

        const updatedProblem = await Problem.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true }
        );

        if (!updatedProblem) {
            return res.status(404).json({ message: "Problem not found" });
        }

        res.json({ success: true, problem: updatedProblem });
    } catch (error) {
        console.error("Error updating problem:", error);
        res.status(500).json({ message: "Error updating problem: " + error.message });
    }
});

// @route DELETE /api/problems/:id
// @desc Delete a problem (Protected: Admin only)
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid problem ID" });
        }

        const deleted = await Problem.findByIdAndDelete(id);
        if (!deleted) {
            return res.status(404).json({ message: "Problem not found" });
        }

        res.json({ success: true, message: `Problem '${deleted.title}' deleted successfully` });
    } catch (error) {
        console.error("Error deleting problem:", error);
        res.status(500).json({ message: "Error deleting problem: " + error.message });
    }
});

// @route POST /api/problems/contest/:contestId/end
// Protected: Administrator or Contest Creator access
router.post("/contest/:contestId/end", requireAuth, async (req, res) => {
    try {
        const { contestId } = req.params;
        if (!ObjectId.isValid(contestId)) {
            return res.status(400).json({ message: "Invalid contest ID." });
        }
        const contestDoc = await Contest.findById(contestId);
        if (!contestDoc) {
            return res.status(404).json({ message: "Contest not found." });
        }
        const isCreator = contestDoc.createdBy && contestDoc.createdBy.toString() === req.user.userId.toString();
        const isAdmin = req.user && req.user.role === "admin";
        if (!isCreator && !isAdmin) {
            return res.status(403).json({ message: "Only the contest creator or an administrator can end this contest." });
        }
        const contest = await endContest(contestId);
        res.json({
            success: true,
            message: 'Contest ended and ratings updated successfully',
            status: contest.status,
            ratingsFinalized: contest.ratingsFinalized
        });
    } catch (error) {
        console.error("Error ending contest:", error);
        res.status(500).json({ message: error.message || "Failed to end contest" });
    }
});

module.exports = router;
