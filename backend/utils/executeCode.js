/**
 * Code Execution Service
 * 
 * Secure cloud-sandboxed code execution engine.
 * Untrusted code is executed exclusively inside isolated cloud sandboxes (Wandbox / Piston).
 * Local host/shell execution has been permanently eliminated (fixes BUG-001 / SEC-001).
 */

// Supported language definitions and compiler mappings
const ALLOWED_LANGUAGES = ["python", "py", "cpp", "c++", "c", "java", "javascript", "js"];

const MAX_CODE_SIZE = 64 * 1024;  // 64 KB
const MAX_STDIN_SIZE = 64 * 1024; // 64 KB

// Wandbox Cloud Sandbox Configuration
const WANDBOX_API_URL = "https://wandbox.org/api/compile.json";
const WANDBOX_COMPILER_MAP = {
    python: "cpython-3.10.15",
    py: "cpython-3.10.15",
    cpp: "gcc-13.2.0",
    "c++": "gcc-13.2.0",
    c: "gcc-13.2.0-c",
    java: "openjdk-jdk-21+35",
    javascript: "nodejs-20.17.0",
    js: "nodejs-20.17.0"
};

// Piston API Configuration (Secondary provider if custom URL or API key is set)
const PISTON_API_URL = process.env.PISTON_API_URL || "https://emkc.org/api/v2/piston/execute";
const PISTON_API_KEY = process.env.PISTON_API_KEY || "";
const PISTON_LANGUAGE_MAP = {
    python: { language: "python", version: "3.10.0", file: "main.py" },
    py: { language: "python", version: "3.10.0", file: "main.py" },
    cpp: { language: "cpp", version: "10.2.0", file: "main.cpp" },
    "c++": { language: "cpp", version: "10.2.0", file: "main.cpp" },
    c: { language: "c", version: "10.2.0", file: "main.c" },
    java: { language: "java", version: "15.0.2", file: "Main.java" },
    javascript: { language: "javascript", version: "18.15.0", file: "main.js" },
    js: { language: "javascript", version: "18.15.0", file: "main.js" }
};

// Lexical token regex for safe Java preprocessing without corrupting comments, string literals, or Java 15+ text blocks
const JAVA_PUBLIC_CLASS_REGEX = /(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""(?:\\.|"(?!"")|[^"\\])*"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\bpublic\s+class\b/g;

function sanitizeJavaSource(code) {
    if (!code || typeof code !== "string") return code;
    return code.replace(JAVA_PUBLIC_CLASS_REGEX, (match, literalOrComment) => {
        // Preserve string literals, char literals, and comments exactly as written
        if (literalOrComment) return literalOrComment;
        // Strip 'public' modifier from actual class declarations
        return "class";
    });
}

/**
 * Universal JSON POST helper using native fetch or fallback
 */
async function postJson(url, payload, headers = {}, timeoutMs = 15000) {
    if (typeof fetch === "function") {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...headers },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            const text = await res.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                data = text;
            }
            return { ok: res.ok, status: res.status, data };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // Fallback to axios if fetch is not available in environment
    const axios = require("axios");
    const response = await axios.post(url, payload, {
        headers: { "Content-Type": "application/json", ...headers },
        timeout: timeoutMs
    });
    return { ok: response.status >= 200 && response.status < 300, status: response.status, data: response.data };
}

/**
 * Execute code via Wandbox Cloud Sandbox
 */
async function executeViaWandbox(code, language, input = "") {
    const langKey = language.toLowerCase();
    const compiler = WANDBOX_COMPILER_MAP[langKey];
    if (!compiler) {
        throw new Error(`Language '${language}' is not supported by Wandbox sandbox.`);
    }

    let codeToSend = code;
    if (langKey === "java") {
        // Wandbox saves source as prog.java; remove 'public' class modifier to avoid compilation error
        codeToSend = sanitizeJavaSource(codeToSend);
        if (!codeToSend.includes("class ")) {
            codeToSend = `class Main {\n    public static void main(String[] args) {\n        ${codeToSend}\n    }\n}`;
        }
    }

    let res = await postJson(WANDBOX_API_URL, {
        compiler,
        code: codeToSend,
        stdin: input || ""
    }, {}, 15000);

    // Automatic retry on transient 429 rate limit or 5xx upstream server error
    if (!res.ok && (res.status === 429 || res.status >= 500)) {
        await new Promise(r => setTimeout(r, 1750));
        res = await postJson(WANDBOX_API_URL, {
            compiler,
            code: codeToSend,
            stdin: input || ""
        }, {}, 15000);
    }

    if (!res.ok) {
        throw new Error(`Wandbox sandbox returned HTTP ${res.status}`);
    }

    const data = res.data;
    if (!data || typeof data !== "object") {
        throw new Error("Invalid response received from execution sandbox.");
    }

    const isSuccess = data.status === "0";
    const stdout = (data.program_output || "").trim();
    const stderr = (data.compiler_error || data.program_error || data.compiler_message || "").trim();

    return {
        status: isSuccess ? "success" : "error",
        output: stdout,
        error: stderr
    };
}

/**
 * Execute code via Piston Sandbox (used when custom URL/key configured or as fallback)
 */
async function executeViaPiston(code, language, input = "") {
    const langKey = language.toLowerCase();
    const config = PISTON_LANGUAGE_MAP[langKey];
    if (!config) {
        throw new Error(`Language '${language}' is not supported by Piston sandbox.`);
    }

    let codeToSend = code;
    if (config.language === "java") {
        codeToSend = sanitizeJavaSource(codeToSend);
        if (!codeToSend.includes("class ")) {
            codeToSend = `class Main {\n    public static void main(String[] args) {\n        ${codeToSend}\n    }\n}`;
        }
    }

    const headers = {};
    if (PISTON_API_KEY) {
        headers["Authorization"] = PISTON_API_KEY;
    }

    const res = await postJson(PISTON_API_URL, {
        language: config.language,
        version: config.version,
        files: [{ name: config.file, content: codeToSend }],
        stdin: input || "",
        run_timeout: 5000,
        compile_timeout: 10000
    }, headers, 15000);

    if (!res.ok) {
        throw new Error(`Piston sandbox returned HTTP ${res.status}`);
    }

    const { run, compile } = res.data;
    if (compile && compile.code !== 0 && compile.stderr) {
        return {
            status: "error",
            output: "",
            error: compile.stderr.trim()
        };
    }

    if (run) {
        const isSuccess = run.code === 0;
        return {
            status: isSuccess ? "success" : "error",
            output: (run.stdout || run.output || "").trim(),
            error: run.stderr ? run.stderr.trim() : (isSuccess ? "" : `Process exited with code ${run.code}`)
        };
    }

    throw new Error("Invalid response structure received from Piston sandbox.");
}

/**
 * Main code execution function.
 * Validates language, code size, stdin size, and executes exclusively via remote sandbox.
 * Host/shell execution is strictly prohibited.
 */
async function executeCode(code, language, input = "") {
    // 1. Mandatory parameter validation
    if (!code || typeof code !== "string" || !code.trim()) {
        throw new Error("Source code is required for execution.");
    }

    if (!language || typeof language !== "string") {
        throw new Error("Language must be specified.");
    }

    const langKey = language.trim().toLowerCase();
    if (!ALLOWED_LANGUAGES.includes(langKey)) {
        throw new Error(`Unsupported programming language: '${language}'. Supported languages: Python, C++, C, Java, JavaScript.`);
    }

    // 2. Request payload size limits
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_SIZE) {
        throw new Error(`Source code exceeds maximum allowed size of ${MAX_CODE_SIZE / 1024} KB.`);
    }

    if (input && Buffer.byteLength(String(input), "utf8") > MAX_STDIN_SIZE) {
        throw new Error(`Standard input exceeds maximum allowed size of ${MAX_STDIN_SIZE / 1024} KB.`);
    }

    // 3. Cloud sandbox execution (Wandbox primary, Piston fallback)
    let timedOut = false;
    try {
        return await executeViaWandbox(code, langKey, input);
    } catch (wandboxErr) {
        console.error(`[executeCode Wandbox Error]: ${wandboxErr.message}`);
        if (wandboxErr.name === "AbortError" || /timeout|abort/i.test(wandboxErr.message)) {
            timedOut = true;
        }
        // Attempt Piston if configured or as secondary
        try {
            return await executeViaPiston(code, langKey, input);
        } catch (pistonErr) {
            console.error(`[executeCode Piston Error]: ${pistonErr.message}`);
            if (pistonErr.name === "AbortError" || /timeout|abort/i.test(pistonErr.message)) {
                timedOut = true;
            }
            // Controlled error: do not expose host filesystem paths or stack traces
            return {
                status: "error",
                output: "",
                error: timedOut 
                    ? "Time Limit Exceeded. Execution timed out." 
                    : "Code execution service is currently unavailable. Please try again shortly."
            };
        }
    }
}

executeCode.sanitizeJavaSource = sanitizeJavaSource;

module.exports = executeCode;
