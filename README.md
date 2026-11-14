# Code Playground

> A modern, full-stack competitive programming and interactive code practice platform built with Node.js, Express, MongoDB, and Monaco Editor.

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/express-4.21.2-blue.svg)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/mongodb-mongoose-green.svg)](https://www.mongodb.com/)
[![License](https://img.shields.io/badge/license-ISC-orange.svg)](LICENSE)

---

## 1. Project Overview

**Code Playground** is a comprehensive competitive programming, algorithm evaluation, and online contest platform designed for university coursework and programming demonstrations. 

The application provides an interactive browser-based code workspace powered by the Monaco Editor (VS Code engine), sandboxed multi-language remote compilation, automated evaluation against both public and hidden test cases, real-time timed contests, dynamic Elo-style user ratings, global leaderboards, and a community discussion forum.

---

## 2. Key Features

- **Interactive Monaco Code Editor**:
  - Full-featured browser editor with syntax highlighting, line numbers, automatic bracket matching, and indentation.
  - Multi-language support: **C++ (GCC)**, **C (GCC)**, **Java (OpenJDK)**, **Python 3**, and **JavaScript (Node.js)**.
  - Custom standard input (`stdin`) testing console and real-time output panel.

- **Automated Algorithmic Judge & Test Evaluation**:
  - Dual test-case visibility: **Public Sample Cases** (visible to students for debugging) and **Hidden Evaluation Cases** (private cases to prevent hardcoding).
  - Robust judge output comparison normalizing line endings, trailing whitespace, and numerical formatting.
  - Detailed submission feedback: *Accepted*, *Wrong Answer*, *Time Limit Exceeded*, *Compilation Error*, or *Runtime Error*.

- **Real-Time Contests & Leaderboards**:
  - Live contest arena with countdown timers, problem sets, and penalty scoring.
  - Dynamic standings and platform-wide global leaderboard sorted by user rating and problems solved.
  - Atomic rating finalization with Elo calculations, per-contest participation tracking, and rating history logs.

- **Community Discussion Forum**:
  - Categorized discussion threads (General, Questions, Solutions, Feedback).
  - Community upvoting/downvoting system and threaded comment replies.

- **Administrative Management Console**:
  - Role-protected admin portal (`/admin`) for creating and editing problems.
  - Test case management with public/hidden classification toggles.
  - Contest creation, monitoring, manual conclusion, and rating finalization triggers.
  - User role and rating oversight.

- **Security & Integrity Controls**:
  - Sandboxed remote code execution via Piston / Wandbox cloud APIs with local execution safeguards.
  - Double-submit cookie CSRF protection with timing-safe token verification.
  - Tiered rate limiting across authentication, submission, and API endpoints.
  - JWT authentication with `tokenVersion` revocation for immediate logout invalidation.
  - Strict input sanitization and secure avatar image processing with MIME validation.

---

## 3. Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Backend Runtime** | Node.js (v18+ or v20+) |
| **Web Framework** | Express.js 4.x |
| **Database & ODM** | MongoDB, Mongoose 8.x |
| **Templating Engine** | EJS (Embedded JavaScript) |
| **Code Editor** | Monaco Editor (VS Code core via AMD CDN) |
| **Execution Sandboxes** | Wandbox API, Piston API, Local GCC/JDK/Node engines |
| **Authentication & Security** | JSON Web Tokens (`jsonwebtoken`), `bcryptjs`, CSRF tokens, `express-rate-limit` |
| **Image Processing** | `sharp`, `multer` |
| **Containerization** | Docker, Docker Compose |

---

## 4. Prerequisites

Before running the application, ensure the following are installed on your machine:

- **Node.js**: Version 18.0.0 or higher (`node -v`)
- **npm**: Version 9.0.0 or higher (`npm -v`)
- **MongoDB**: Version 6.0 or higher running locally (or a free cloud MongoDB Atlas cluster URI)
- *(Optional)* **Docker & Docker Compose**: For containerized deployment

---

## 5. Installation & Setup

### Step 1: Clone the Repository
```bash
git clone https://github.com/Bhumit0922/Code-Playground.git
cd Code-Playground
```

### Step 2: Install Node Dependencies
```bash
npm install
```

### Step 3: Configure Environment Variables
Copy the `.env.example` template to `.env`:
```bash
cp .env.example .env
```
*(On Windows PowerShell: `Copy-Item .env.example .env`)*

Configure your `.env` settings as needed:
```env
PORT=4000
NODE_ENV=development
MONGODB_URI=mongodb://127.0.0.1:27017/codeplayground
JWT_SECRET=development_super_secret_jwt_key_at_least_32_chars_long
EXECUTION_MODE=cloud
PISTON_API_URL=https://emkc.org/api/v2/piston/execute
```

---

## 6. Database Setup & Seeding

Ensure your MongoDB daemon is running locally:
```bash
# Example local MongoDB startup (Linux/macOS)
mongod --dbpath /data/db

# Windows Service (if installed as a service)
net start MongoDB
```

### Option A: Standard Baseline Seeding
Populates standard algorithmic problems (*Two Sum*, *Valid Parentheses*, *Reverse String*, *Binary Search*, *Maximum Subarray*, etc.), default contests, and baseline user accounts:
```bash
npm run seed
```

### Option B: Comprehensive University Demo Seeding
Populates a complete presentation-ready environment containing active contests, past concluded contests with finalized ratings, active forum discussions, comments, and multiple contestant accounts:
```bash
node backend/scripts/setup_demo_data.js
```
*(Dry-run preview without database writes: `node backend/scripts/setup_demo_data.js --dry-run`)*

---

## 7. Running the Application

### Development Mode (with nodemon auto-reload)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

### Docker Mode (App + MongoDB in Containers)
```bash
docker-compose up --build
```

Once started, access the application in your web browser at:
**[http://localhost:4000](http://localhost:4000)**

---

## 8. Demonstration Accounts Reference

The following pre-configured demonstration accounts are available after running the seed scripts (all passwords use safe development defaults):

| Role | Username | Email | Default Password | Description / Intended Use |
| :--- | :--- | :--- | :--- | :--- |
| **Admin** | `admin` | `admin@codeplayground.com` | `Admin@123` | Full administrative access to `/admin`, problem creation, test case editing, contest lifecycle management. |
| **Contestant** | `alex_coder` | `alex@codeplayground.com` | `User@123` | High-ranked contestant (Rating: 1650), solved submissions, discussion author. |
| **Contestant** | `sarah_dev` | `sarah@codeplayground.com` | `User@123` | Active contestant (Rating: 1580), solved submissions, active discussions. |
| **Contestant** | `alice_student` | `alice@codeplayground.com` | `Student@123456` | Registered participant (Rating: 1520), ready for live contest demonstration. |
| **Student** | `bob_student` | `bob@codeplayground.com` | `Student@123456` | Standard student account registered for upcoming events. |

---

## 9. Main Architecture & Code Modules

```
Code-Playground/
├── backend/
│   ├── config/
│   │   └── db.js                 # Resilient MongoDB connection manager with retry logic
│   ├── middleware/
│   │   ├── auth.js               # JWT token verification, role enforcement, session invalidation
│   │   ├── authcheck.js          # Authentication state checker for page rendering
│   │   ├── csrf.js               # Double-submit cookie CSRF protection
│   │   └── rateLimiter.js        # Tiered rate limiters (auth, submit, API)
│   ├── models/
│   │   ├── User.js               # User accounts, contest ratings, history, tokenVersion
│   │   ├── Problem.js            # Algorithmic problems with public and hidden test cases
│   │   ├── Contest.js            # Timed contests, registration, leaderboards, locks
│   │   ├── Discussion.js         # Forum threads, category tags, upvotes/downvotes
│   │   ├── Comment.js            # Threaded discussion comments
│   │   └── Contact.js            # User contact and support inquiries
│   ├── routes/
│   │   ├── adminRoutes.js        # /admin - Admin dashboard, problem/contest CRUD
│   │   ├── authRoutes.js         # /api/auth - Registration, login, profile, avatars
│   │   ├── contestRoutes.js      # /api/contests - Contest catalog, standings, live arena
│   │   ├── contestjoinRoutes.js  # /api/contests/join - Participant contest registration
│   │   ├── discussRoutes.js      # /api/discuss - Forum posts, voting, comments
│   │   ├── executeRoutes.js      # /api/execute - Ad-hoc code execution sandbox
│   │   ├── problemRoutes.js      # /api/problems - Problem catalog, code evaluation & grading
│   │   └── contactRoutes.js      # /api/contact - Feedback submission
│   ├── scripts/
│   │   └── setup_demo_data.js    # University demo data seeder
│   ├── utils/
│   │   ├── contestService.js     # Leaderboard computations and atomic Elo rating updates
│   │   ├── executeCode.js        # Multi-language sandboxed execution manager (Wandbox / Piston)
│   │   └── judgeComparison.js   # Algorithmic judge output normalizer & test verifier
│   ├── index.js                  # Main Express application initialization & page routing
│   └── seed.js                   # Baseline database seeder
├── frontend/
│   ├── css/                      # Responsive stylesheets (dark theme, glassmorphic UI)
│   ├── imgg/                     # Platform logos, badges, and user avatar storage
│   └── views/                    # EJS page templates
│       ├── partials/             # Shared navbar, header, and footer components
│       ├── admin/                # Admin dashboards (problems, contests, users)
│       ├── editcode.ejs          # Monaco Editor problem-solving arena
│       ├── contestpage.ejs       # Live timed contest arena & standings
│       ├── contests.ejs          # Contests directory & registration
│       ├── leaderboard.ejs       # Global platform rating leaderboard
│       ├── discuss.ejs           # Community discussion board
│       ├── problems.ejs          # Problem bank with difficulty and tag filters
│       ├── profile.ejs           # User profile & rating history chart
│       ├── signin.ejs            # Authentication (Sign In)
│       └── signup.ejs            # Authentication (Sign Up)
├── public/                       # Static public assets served by Express
├── .env.example                  # Environment configuration template
├── docker-compose.yml            # Docker orchestration configuration
├── Dockerfile                    # Container build configuration
├── package.json                  # Dependencies and npm script definitions
└── vercel.json                   # Vercel serverless deployment configuration
```

---

## 10. License

Distributed under the **ISC License**. See `LICENSE` for more information.
