const express = require("express");
const router = express.Router();
const executeCode = require("../utils/executeCode");
const { compareOutputs } = require("../utils/judgeComparison");
const User = require("../models/User");
const Problem = require("../models/Problem");
const { updateContestLeaderboard, endContest } = require("../utils/contestService");
const { requireAdmin } = require("../middleware/auth");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

// @route POST /api/execute
// Execute single code snippet with custom input (Never creates submissions or updates ratings)
router.post("/", async (req, res) => {
    try {
        const { code, language, input = "" } = req.body;
        
        if (!code || !language) {
            return res.status(400).json({ status: "error", error: "Code and language are required." });
        }

        const result = await executeCode(code, language, input);
        res.json(result);
    } catch (error) {
        console.error("Error executing code:", error);
        res.status(500).json({ 
            status: "error", 
            error: error.message || "Execution failed on the server." 
        });
    }
});

// @route POST /api/execute/test
// BUG-010 & BUG-011: Run code ONLY against server-retrieved sample test cases for verification.
// Never accepts client-supplied expected outputs.
// Never creates official submissions or updates contest leaderboards/ratings.
router.post("/test", async (req, res) => {
    try {
        const { code, language, problemId } = req.body;
        
        if (!code || !language) {
            return res.status(400).json({ error: "Code and language are required." });
        }

        if (!problemId || !ObjectId.isValid(problemId)) {
            return res.status(400).json({ error: "Valid problemId is required to evaluate against test cases." });
        }

        const problem = await Problem.findById(problemId);
        if (!problem) {
            return res.status(404).json({ error: "Problem not found." });
        }

        // Authoritative server-side sample test cases ONLY
        const sampleCases = [];
        if (problem.sampleInput || problem.sampleOutput) {
            sampleCases.push({ input: problem.sampleInput || "", output: problem.sampleOutput || "" });
        }
        if (Array.isArray(problem.testCases)) {
            const publicCases = problem.testCases.filter(tc => !tc.isHidden);
            for (const tc of publicCases) {
                if (!sampleCases.some(s => s.input === tc.input && s.output === tc.output)) {
                    sampleCases.push({ input: tc.input || "", output: tc.output || "" });
                }
            }
        }
        if (sampleCases.length === 0 && problem.testCases && problem.testCases.length > 0) {
            sampleCases.push({ input: problem.testCases[0].input || "", output: problem.testCases[0].output || "" });
        }

        const results = [];
        let allPassed = true;
        
        for (let i = 0; i < sampleCases.length; i++) {
            if (i > 0) {
                // Brief pause between sequential remote executions to avoid remote sandbox burst rate limits
                await new Promise(r => setTimeout(r, 250));
            }
            const tc = sampleCases[i];
            try {
                const response = await executeCode(code, language, tc.input || "");
                const isSuccess = response.status === "success";
                const outputMatches = isSuccess && compareOutputs(response.output, tc.output);
                
                results.push({
                    testCase: i + 1,
                    input: tc.input,
                    expectedOutput: tc.output,
                    actualOutput: response.output,
                    passed: outputMatches,
                    error: response.error
                });
                
                if (!outputMatches) {
                    allPassed = false;
                }
            } catch (error) {
                results.push({
                    testCase: i + 1,
                    input: tc.input,
                    expectedOutput: tc.output,
                    actualOutput: "",
                    passed: false,
                    error: error.message
                });
                allPassed = false;
            }
        }
        
        const status = allPassed ? "Accepted" : "Wrong Answer";
        
        // Return pure evaluation results without mutating database or submission records
        res.json({
            status,
            results
        });
    } catch (error) {
        console.error("Error testing code:", error);
        res.status(500).json({ 
            status: "error", 
            error: error.message || "Failed to run test cases." 
        });
    }
});

// @route POST /api/execute/contest-end/:contestId
// Protected: Administrator access required to force end contests
router.post("/contest-end/:contestId", requireAdmin, async (req, res) => {
    try {
        const { contestId } = req.params;
        const contest = await endContest(contestId);
        res.json({
            success: true,
            message: 'Contest ended and ratings updated successfully',
            status: contest.status
        });
    } catch (error) {
        console.error("Error ending contest:", error);
        res.status(500).json({ error: error.message || "Failed to end contest" });
    }
});

module.exports = router;
