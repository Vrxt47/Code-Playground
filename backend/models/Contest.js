const mongoose = require('mongoose');

const ContestSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    startTime: {
        type: Date,
        required: true
    },
    endTime: {
        type: Date,
        required: true
    },
    difficulty: {
        type: String,
        enum: ['Easy', 'Medium', 'Hard'],
        default: 'Medium'
    },
    problems: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Problem'
    }],
    participants: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        registeredAt: {
            type: Date,
            default: Date.now
        }
    }],
    contestCode: {
        type: String,
        unique: true,
        required: true
    },
    status: {
        type: String,
        enum: ['Upcoming', 'Ongoing', 'Completed'],
        default: 'Upcoming'
    },
    visibility: {  // Fixed typo from 'visiblity' to 'visibility'
        type: String,
        enum: ['Public', 'Private'],
        default: 'Private'  // Added default value
    },
    leaderboard: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        totalScore: {
            type: Number,
            default: 0
        },
        submissions: [{
            problem: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Problem'
            },
            score: Number,
            timeTaken: Number
        }],
        rank: Number,
        ratingProcessed: {
            type: Boolean,
            default: false
        }
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    ratingsFinalized: {
        type: Boolean,
        default: false
    },
    ratingsFinalizationStatus: {
        type: String,
        enum: ['Pending', 'Processing', 'Completed'],
        default: 'Pending'
    },
    finalizationLock: {
        type: String,
        default: null
    },
    finalizationStartedAt: {
        type: Date
    },
    finalizedAt: {
        type: Date
    }
}, {
    timestamps: true
});

// Create a method to update contest status (fixed typo from 'ontestSchema' to 'ContestSchema')
ContestSchema.methods.updateStatus = async function() {
    // If contest ratings have been finalized or completed, status must remain Completed
    if (this.ratingsFinalized || this.ratingsFinalizationStatus === 'Completed') {
        if (this.status !== 'Completed') {
            this.status = 'Completed';
            await this.save();
        }
        return this;
    }

    const now = new Date();
    
    // No need to save if no status change
    if (this.startTime > now && this.status !== 'Upcoming') {
        this.status = 'Upcoming';
        await this.save();
    } else if (this.startTime <= now && this.endTime > now && this.status !== 'Ongoing') {
        this.status = 'Ongoing';
        await this.save();
    } else if (this.endTime <= now && this.status !== 'Completed') {
        this.status = 'Completed';
        await this.save();
    }
    // Return the document whether changed or not
    return this;
};

// Method to get deterministically sorted leaderboard with unique dynamic ranks
ContestSchema.methods.getSortedLeaderboard = function() {
    return (this.leaderboard || []).slice().sort((a, b) => {
        const scoreDiff = (b.totalScore || 0) - (a.totalScore || 0);
        if (scoreDiff !== 0) return scoreDiff;

        const timeA = (a.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
        const timeB = (b.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
        if (timeA !== timeB) return timeA - timeB;

        const idA = a.user ? (a.user._id || a.user).toString() : "";
        const idB = b.user ? (b.user._id || b.user).toString() : "";
        return idA.localeCompare(idB);
    }).map((entry, index) => ({
        ...(typeof entry.toObject === 'function' ? entry.toObject() : entry),
        rank: index + 1
    }));
};

// Method to calculate final leaderboard with deterministic ranking
ContestSchema.methods.calculateFinalLeaderboard = async function() {
    // Sort participants: totalScore desc, then total timeTaken asc, then user ObjectId asc
    this.leaderboard.sort((a, b) => {
        const scoreDiff = (b.totalScore || 0) - (a.totalScore || 0);
        if (scoreDiff !== 0) return scoreDiff;

        const timeA = (a.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
        const timeB = (b.submissions || []).reduce((sum, s) => sum + (s.timeTaken || 0), 0);
        if (timeA !== timeB) return timeA - timeB;

        const idA = a.user ? a.user.toString() : "";
        const idB = b.user ? b.user.toString() : "";
        return idA.localeCompare(idB);
    });
    this.leaderboard = this.leaderboard.map((entry, index) => ({
        ...entry.toObject(),
        rank: index + 1,
        ratingProcessed: !!entry.ratingProcessed
    }));
    return this.save();
};

const Contest = mongoose.model('Contest', ContestSchema);
module.exports = Contest;