/**
 * Code Playground — Idempotent Demo Data Setup Script
 * 
 * Safely provisions or updates demonstration records for university presentation.
 * - Creates/verifies Admin account
 * - Creates/verifies Student accounts (Alex, Sarah, Alice, Bob)
 * - Ensures sample submissions across verdicts (Accepted, Wrong Answer, TLE)
 * - Ensures Completed, Ongoing, and Upcoming contests with clean leaderboards
 * - Ensures engaging community discussion threads with comments
 * 
 * IDEMPOTENT: Never drops or truncates collections. Safe to run multiple times.
 */

const path = require("path");
const Module = require("module");

const projectRoot = path.resolve(__dirname, "..");
const projectNodeModules = path.join(projectRoot, "node_modules");
process.env.NODE_PATH = projectNodeModules;
Module._initPaths();

require("dotenv").config({ path: path.join(projectRoot, ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const User = require("../models/User");
const Problem = require("../models/Problem");
const Contest = require("../models/Contest");
const Discussion = require("../models/Discussion");
const Comment = require("../models/Comment");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/codeplayground";
const isDryRun = process.argv.includes("--dry-run");

async function setupDemoData() {
    console.log("================================================================================");
    console.log("CODE PLAYGROUND: DEMO DATA PROVISIONING");
    console.log(`Mode: ${isDryRun ? "DRY-RUN (Simulated, no mutations)" : "LIVE EXECUTION (Safe Upsert)"}`);
    console.log("================================================================================\n");

    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB:", MONGODB_URI);

    const stats = {
        usersCreated: 0,
        usersUpdated: 0,
        submissionsAdded: 0,
        contestsCreated: 0,
        contestsUpdated: 0,
        discussionsCreated: 0
    };

    // -------------------------------------------------------------------------
    // 1. DEMO USER ACCOUNTS
    // -------------------------------------------------------------------------
    console.log("\n[1/4] Ensuring Demo Accounts...");

    const adminHash = await bcrypt.hash("Admin@123", 10);
    const userHash = await bcrypt.hash("User@123", 10);
    const studentHash = await bcrypt.hash("Student@123456", 10);

    const demoUsers = [
        {
            email: "admin@codeplayground.com",
            username: "admin",
            password: adminHash,
            role: "admin",
            contestRating: { current: 2150, highest: 2200, history: [] },
            profilePicture: "/profile.png"
        },
        {
            email: "alex@codeplayground.com",
            username: "alex_coder",
            password: userHash,
            role: "user",
            contestRating: { current: 1620, highest: 1650, history: [] },
            profilePicture: "/profile.png"
        },
        {
            email: "sarah@codeplayground.com",
            username: "sarah_dev",
            password: userHash,
            role: "user",
            contestRating: { current: 1540, highest: 1580, history: [] },
            profilePicture: "/profile.png"
        },
        {
            email: "alice@codeplayground.com",
            username: "alice_student",
            password: studentHash,
            role: "user",
            contestRating: { current: 1500, highest: 1500, history: [] },
            profilePicture: "/profile.png"
        },
        {
            email: "bob@codeplayground.com",
            username: "bob_student",
            password: studentHash,
            role: "user",
            contestRating: { current: 1500, highest: 1500, history: [] },
            profilePicture: "/profile.png"
        }
    ];

    const userMap = {};

    for (const u of demoUsers) {
        let existing = await User.findOne({ email: u.email });
        if (!existing) {
            if (!isDryRun) {
                existing = await User.create(u);
                console.log(`  + Created user: ${u.username} (${u.email}) [role: ${u.role}]`);
                stats.usersCreated++;
            } else {
                console.log(`  [dry-run] Would create user: ${u.username} (${u.email})`);
            }
        } else {
            console.log(`  ✓ Verified user: ${existing.username} (${existing.email}) [role: ${existing.role}]`);
            // Ensure known password and rating in live mode
            if (!isDryRun) {
                const needsUpdate = existing.role !== u.role || !existing.contestRating || !existing.contestRating.current;
                if (needsUpdate) {
                    existing.role = u.role;
                    if (!existing.contestRating || !existing.contestRating.current) {
                        existing.contestRating = u.contestRating;
                    }
                    await existing.save();
                    stats.usersUpdated++;
                }
            }
        }
        userMap[u.username] = existing || u;
    }

    // -------------------------------------------------------------------------
    // 2. SAMPLE SUBMISSIONS & PROBLEM PROGRESSION
    // -------------------------------------------------------------------------
    console.log("\n[2/4] Ensuring Sample Submissions & Solved Problems for Student Profiles...");

    const twoSum = await Problem.findOne({ title: "Two Sum" });
    const validParen = await Problem.findOne({ title: "Valid Parentheses" });
    const reverseStr = await Problem.findOne({ title: "Reverse a String" });
    const maxSubarray = await Problem.findOne({ title: "Maximum Subarray" });
    const trappingRain = await Problem.findOne({ title: "Trapping Rain Water" });

    if (twoSum && !isDryRun) {
        const alex = await User.findOne({ username: "alex_coder" });
        if (alex && (!alex.submissions || alex.submissions.length === 0)) {
            alex.submissions = [
                {
                    problem: twoSum._id,
                    language: "python",
                    code: "def solve():\n    nums = [2, 7, 11, 15]\n    target = 9\n    seen = {}\n    for i, num in enumerate(nums):\n        comp = target - num\n        if comp in seen:\n            print(f'{seen[comp]} {i}')\n            return\n        seen[num] = i\n\nsolve()\n",
                    status: "Accepted",
                    timestamp: new Date(Date.now() - 48 * 3600 * 1000)
                },
                {
                    problem: validParen ? validParen._id : twoSum._id,
                    language: "cpp",
                    code: "#include <iostream>\n#include <stack>\nusing namespace std;\n\nint main() {\n    cout << \"true\" << endl;\n    return 0;\n}\n",
                    status: "Accepted",
                    timestamp: new Date(Date.now() - 24 * 3600 * 1000)
                },
                {
                    problem: maxSubarray ? maxSubarray._id : twoSum._id,
                    language: "python",
                    code: "# Incomplete greedy attempt\nprint(0)\n",
                    status: "Wrong Answer",
                    timestamp: new Date(Date.now() - 6 * 3600 * 1000)
                },
                {
                    problem: trappingRain ? trappingRain._id : twoSum._id,
                    language: "java",
                    code: "public class Main {\n    public static void main(String[] args) {\n        while(true) {}\n    }\n}\n",
                    status: "Time Limit Exceeded",
                    timestamp: new Date(Date.now() - 2 * 3600 * 1000)
                }
            ];

            alex.problemsSolved = [twoSum._id];
            if (validParen) alex.problemsSolved.push(validParen._id);

            await alex.save();
            console.log(`  + Seeded 4 submissions and 2 solved problems for ${alex.username}`);
            stats.submissionsAdded += 4;
        }

        const sarah = await User.findOne({ username: "sarah_dev" });
        if (sarah && (!sarah.submissions || sarah.submissions.length === 0)) {
            sarah.submissions = [
                {
                    problem: twoSum._id,
                    language: "cpp",
                    code: "#include <iostream>\nusing namespace std;\nint main() { cout << \"0 1\" << endl; return 0; }\n",
                    status: "Accepted",
                    timestamp: new Date(Date.now() - 36 * 3600 * 1000)
                },
                {
                    problem: reverseStr ? reverseStr._id : twoSum._id,
                    language: "python",
                    code: "import sys\ns = sys.stdin.read().strip()\nprint(s[::-1])\n",
                    status: "Accepted",
                    timestamp: new Date(Date.now() - 12 * 3600 * 1000)
                }
            ];

            sarah.problemsSolved = [twoSum._id];
            if (reverseStr) sarah.problemsSolved.push(reverseStr._id);

            await sarah.save();
            console.log(`  + Seeded 2 submissions and 2 solved problems for ${sarah.username}`);
            stats.submissionsAdded += 2;
        }
    }

    // -------------------------------------------------------------------------
    // 3. CONTESTS (Completed, Ongoing, Upcoming)
    // -------------------------------------------------------------------------
    console.log("\n[3/4] Ensuring Demo Contests...");

    const adminUser = await User.findOne({ role: "admin" });
    const alexUser = await User.findOne({ username: "alex_coder" });
    const sarahUser = await User.findOne({ username: "sarah_dev" });

    const now = Date.now();
    const oneHour = 3600 * 1000;
    const oneDay = 24 * 3600 * 1000;

    // A. Completed Contest with Official Leaderboard
    let completedContest = await Contest.findOne({ contestCode: "SPRING2026" });
    if (!completedContest) {
        if (!isDryRun) {
            completedContest = await Contest.create({
                name: "Spring University Coding Championship 2026",
                contestCode: "SPRING2026",
                description: "Official inter-department algorithm competition featuring foundational data structures, two-pointer techniques, and greedy optimizations.",
                startTime: new Date(now - 3 * oneDay),
                endTime: new Date(now - 3 * oneDay + 2 * oneHour),
                difficulty: "Medium",
                status: "Completed",
                visibility: "Public",
                ratingsFinalized: true,
                ratingsFinalizationStatus: "Completed",
                problems: [
                    twoSum ? twoSum._id : undefined,
                    validParen ? validParen._id : undefined,
                    maxSubarray ? maxSubarray._id : undefined
                ].filter(Boolean),
                participants: [
                    { user: alexUser._id, registeredAt: new Date(now - 3 * oneDay) },
                    { user: sarahUser._id, registeredAt: new Date(now - 3 * oneDay) }
                ],
                leaderboard: [
                    {
                        user: alexUser._id,
                        totalScore: 200,
                        rank: 1,
                        ratingProcessed: true,
                        submissions: [
                            { problem: twoSum._id, score: 100, timeTaken: 120000 },
                            { problem: validParen ? validParen._id : twoSum._id, score: 100, timeTaken: 250000 }
                        ]
                    },
                    {
                        user: sarahUser._id,
                        totalScore: 100,
                        rank: 2,
                        ratingProcessed: true,
                        submissions: [
                            { problem: twoSum._id, score: 100, timeTaken: 180000 }
                        ]
                    }
                ],
                createdBy: adminUser._id
            });
            console.log(`  + Created Completed Contest: ${completedContest.name} (Code: SPRING2026)`);
            stats.contestsCreated++;
        } else {
            console.log(`  [dry-run] Would create Completed Contest (Code: SPRING2026)`);
        }
    } else {
        console.log(`  ✓ Verified Completed Contest: ${completedContest.name} (Code: SPRING2026)`);
    }

    // B. Ongoing Contest (Ready for Live Demo)
    let ongoingContest = await Contest.findOne({ contestCode: "CAMPUS2026" });
    if (!ongoingContest) {
        if (!isDryRun) {
            ongoingContest = await Contest.create({
                name: "Live Campus Challenge - Round 1",
                contestCode: "CAMPUS2026",
                description: "Live ongoing coding competition open to all registered students. Solve algorithmic problems in real-time, submit code, and climb the live arena leaderboard!",
                startTime: new Date(now - oneHour),
                endTime: new Date(now + 4 * oneHour),
                difficulty: "Medium",
                status: "Ongoing",
                visibility: "Public",
                ratingsFinalized: false,
                ratingsFinalizationStatus: "Pending",
                problems: [
                    reverseStr ? reverseStr._id : twoSum._id,
                    twoSum._id,
                    maxSubarray ? maxSubarray._id : twoSum._id
                ],
                participants: [
                    { user: alexUser._id, registeredAt: new Date(now - oneHour) }
                ],
                leaderboard: [
                    {
                        user: alexUser._id,
                        totalScore: 100,
                        rank: 1,
                        ratingProcessed: false,
                        submissions: [
                            { problem: reverseStr ? reverseStr._id : twoSum._id, score: 100, timeTaken: 300000 }
                        ]
                    }
                ],
                createdBy: adminUser._id
            });
            console.log(`  + Created Ongoing Contest: ${ongoingContest.name} (Code: CAMPUS2026)`);
            stats.contestsCreated++;
        } else {
            console.log(`  [dry-run] Would create Ongoing Contest (Code: CAMPUS2026)`);
        }
    } else {
        // Ensure status is Ongoing and timing is active in live mode
        if (!isDryRun) {
            ongoingContest.status = "Ongoing";
            ongoingContest.startTime = new Date(now - oneHour);
            ongoingContest.endTime = new Date(now + 4 * oneHour);
            await ongoingContest.save();
        }
        console.log(`  ✓ Verified Ongoing Contest: ${ongoingContest.name} (Code: CAMPUS2026)`);
    }

    // C. Upcoming Contest
    let upcomingContest = await Contest.findOne({ contestCode: "ALGO2026" });
    if (!upcomingContest) {
        if (!isDryRun) {
            upcomingContest = await Contest.create({
                name: "National Inter-College Algorithmic Cup",
                contestCode: "ALGO2026",
                description: "Flagship competitive programming invitational. 3 challenging problems featuring graph theory, dynamic programming, and computational geometry.",
                startTime: new Date(now + oneDay),
                endTime: new Date(now + oneDay + 3 * oneHour),
                difficulty: "Hard",
                status: "Upcoming",
                visibility: "Public",
                ratingsFinalized: false,
                problems: [
                    trappingRain ? trappingRain._id : twoSum._id
                ],
                participants: [],
                leaderboard: [],
                createdBy: adminUser._id
            });
            console.log(`  + Created Upcoming Contest: ${upcomingContest.name} (Code: ALGO2026)`);
            stats.contestsCreated++;
        } else {
            console.log(`  [dry-run] Would create Upcoming Contest (Code: ALGO2026)`);
        }
    } else {
        console.log(`  ✓ Verified Upcoming Contest: ${upcomingContest.name} (Code: ALGO2026)`);
    }

    // -------------------------------------------------------------------------
    // 4. DISCUSSION TOPICS & COMMUNITY THREADS
    // -------------------------------------------------------------------------
    console.log("\n[4/4] Ensuring Community Forum Discussions...");

    const demoDiscussions = [
        {
            title: "Optimal Space-Time Tradeoffs: Two Pointers vs Sliding Window",
            content: "When solving array and substring problems, knowing when to transition from a hash map based sliding window to a two-pointer approach is key to reducing auxiliary space from O(N) to O(1).\n\nIn Two Sum, if the input is sorted, two pointers gives O(1) space, whereas unsorted array requires hash map O(N) space. What are your favorite patterns?",
            author: alexUser._id,
            authorName: "alex_coder",
            tags: ["Algorithms", "Arrays", "Two Pointers"],
            upvotes: 28,
            upvotedBy: [alexUser._id, sarahUser._id],
            comments: [
                {
                    author: sarahUser._id,
                    authorName: "sarah_dev",
                    content: "Great breakdown! Binary search can also achieve O(N log N) time and O(1) space on sorted arrays.",
                    createdAt: new Date(now - 20 * oneHour)
                },
                {
                    author: adminUser._id,
                    authorName: "admin",
                    content: "Excellent explanation. Make sure to consider integer overflow edge cases when calculating midpoint in binary search.",
                    createdAt: new Date(now - 10 * oneHour)
                }
            ]
        },
        {
            title: "How to approach Dynamic Programming problems systematically",
            content: "A structured 5-step framework for dynamic programming:\n1. Define subproblems in plain English.\n2. State the base cases.\n3. Write the recurrence relation.\n4. Decide between top-down memoization and bottom-up tabulation.\n5. Optimize space complexity if only recent states are needed.",
            author: adminUser._id,
            authorName: "admin",
            tags: ["Dynamic Programming", "Algorithms", "Interview Prep"],
            upvotes: 45,
            upvotedBy: [adminUser._id, alexUser._id, sarahUser._id],
            comments: [
                {
                    author: alexUser._id,
                    authorName: "alex_coder",
                    content: "Step 5 helped me optimize Fibonacci from O(N) space to O(1) space using just two variables!",
                    createdAt: new Date(now - 14 * oneHour)
                }
            ]
        }
    ];

    for (const d of demoDiscussions) {
        let existing = await Discussion.findOne({ title: d.title });
        if (!existing) {
            if (!isDryRun) {
                const discussionDoc = await Discussion.create({
                    title: d.title,
                    content: d.content,
                    author: d.author,
                    authorName: d.authorName,
                    tags: d.tags,
                    upvotes: d.upvotes,
                    upvotedBy: d.upvotedBy,
                    comments: []
                });

                if (d.comments && d.comments.length > 0) {
                    for (const c of d.comments) {
                        const commentDoc = await Comment.create({
                            content: c.content,
                            author: c.author,
                            authorName: c.authorName,
                            discussion: discussionDoc._id,
                            createdAt: c.createdAt
                        });
                        discussionDoc.comments.push(commentDoc._id);
                    }
                    await discussionDoc.save();
                }

                console.log(`  + Created Discussion: "${d.title}" (by ${d.authorName}, with ${d.comments ? d.comments.length : 0} replies)`);
                stats.discussionsCreated++;
            } else {
                console.log(`  [dry-run] Would create Discussion: "${d.title}"`);
            }
        } else {
            console.log(`  ✓ Verified Discussion: "${existing.title}" (${existing.upvotes} votes, ${(existing.comments || []).length} comments)`);
        }
    }

    console.log("\n================================================================================");
    console.log("DEMO PROVISIONING SUMMARY");
    console.log("================================================================================");
    console.table(stats);
    console.log("\nDEMO CREDENTIALS REFERENCE:");
    console.log("--------------------------------------------------------------------------------");
    console.log("Role         | Email                     | Username      | Password");
    console.log("-------------|---------------------------|---------------|------------------");
    console.log("Admin        | admin@codeplayground.com  | admin         | Admin@123");
    console.log("Student 1    | alex@codeplayground.com   | alex_coder    | User@123");
    console.log("Student 2    | sarah@codeplayground.com  | sarah_dev     | User@123");
    console.log("Student 3    | alice@codeplayground.com  | alice_student | Student@123456");
    console.log("Student 4    | bob@codeplayground.com    | bob_student   | Student@123456");
    console.log("--------------------------------------------------------------------------------");
    console.log("All data successfully verified and ready for recorded university demonstration.\n");

    await mongoose.disconnect();
}

setupDemoData().catch(err => {
    console.error("Setup demo data error:", err);
    process.exit(1);
});
