/**
 * Judge Output Comparison & Problem Sanitization Utility (BUG-012, BUG-013, BUG-015)
 * 
 * Provides robust output normalization and comparison for competitive programming grading,
 * as well as defensive sanitization of problem documents before client delivery.
 * 
 * Handles:
 * - Line-ending normalization (CRLF / CR -> LF)
 * - Trailing whitespace per line (without modifying internal whitespace)
 * - Trailing and leading blank lines
 * - Exact string equality after standard judge normalization
 * - Purging reference solutions, hidden test cases, and private fields from problem models
 */

/**
 * Normalize output string using standard competitive programming judge rules:
 * 1. Standardize all line endings to Unix LF (\n).
 * 2. Strip trailing whitespace (spaces and tabs) from each individual line.
 * 3. Strip leading and trailing newlines from the complete output buffer.
 * 4. Strictly preserve internal whitespace between tokens and within lines.
 *
 * @param {string|any} str - The raw output or expected output
 * @returns {string} - Normalized output string
 */
function normalizeOutput(str) {
    if (str === null || str === undefined) {
        return "";
    }
    return String(str)
        .replace(/\r\n/g, "\n")              // Windows CRLF -> LF
        .replace(/\r/g, "\n")                // Classic Mac CR -> LF
        .split("\n")
        .map(line => line.replace(/[ \t]+$/g, "")) // Strip trailing line spaces/tabs only
        .join("\n")
        .replace(/^\n+|\n+$/g, "");          // Strip leading and trailing newlines only (preserves line indentation)
}

/**
 * Compare actual program output against expected test case output.
 * 
 * @param {string|any} actual - Output produced by user's program
 * @param {string|any} expected - Authoritative expected output
 * @returns {boolean} - True if outputs match after standard normalization
 */
function compareOutputs(actual, expected) {
    return normalizeOutput(actual) === normalizeOutput(expected);
}

/**
 * Sanitizes problem representation before returning to public clients (BUG-012 & BUG-013)
 * Strips reference solutions and hides non-sample test cases.
 *
 * @param {Object} problem - Mongoose Problem document or plain object
 * @returns {Object|null} - Sanitized problem object
 */
function sanitizeProblemForClient(problem) {
    if (!problem) return null;
    const obj = problem.toObject ? problem.toObject({ virtuals: true }) : { ...problem };
    
    // Completely purge reference solution fields if any exist (BUG-013)
    delete obj.referenceSolution;
    delete obj.solution;

    // Filter testCases: only expose public / sample test cases (BUG-012)
    if (Array.isArray(obj.testCases)) {
        obj.testCases = obj.testCases
            .filter(tc => !tc.isHidden)
            .map((tc, idx) => ({
                _id: tc._id,
                testCase: idx + 1,
                input: tc.input || "",
                output: tc.output || "",
                isHidden: false
            }));

        // If no test cases are explicitly marked public, provide sampleInput as the sole public case
        if (obj.testCases.length === 0 && (obj.sampleInput || obj.sampleOutput)) {
            obj.testCases = [{
                testCase: 1,
                input: obj.sampleInput || "",
                output: obj.sampleOutput || "",
                isHidden: false
            }];
        }
    }
    return obj;
}

module.exports = {
    normalizeOutput,
    compareOutputs,
    sanitizeProblemForClient
};
