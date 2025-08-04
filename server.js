const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: false
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// In-memory storage (replace with database in production)
let analytics = {
    totalEntries: 0,
    totalUsers: 0,
    activeUsers: new Map(), // userId -> { lastSeen: timestamp, sessionId: string }
    dailyStats: new Map(), // date -> { entries: number, users: Set }
    userSessions: new Map() // sessionId -> { userId: string, startTime: timestamp }
};

// Helper functions
function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

function generateSessionId() {
    return 'session_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now();
}

function getActiveUsersCount() {
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
    let activeCount = 0;
    
    for (const [userId, userData] of analytics.activeUsers) {
        if (userData.lastSeen > thirtyMinutesAgo) {
            activeCount++;
        } else {
            // Clean up old users
            analytics.activeUsers.delete(userId);
        }
    }
    
    return activeCount;
}

function getTodaysStats() {
    const today = new Date().toDateString();
    const todayStats = analytics.dailyStats.get(today);
    
    if (!todayStats) {
        return { entries: 0, uniqueUsers: 0 };
    }
    
    return {
        entries: todayStats.entries,
        uniqueUsers: todayStats.users.size
    };
}

function updateDailyStats(userId, entryCount = 0) {
    const today = new Date().toDateString();
    
    if (!analytics.dailyStats.has(today)) {
        analytics.dailyStats.set(today, {
            entries: 0,
            users: new Set()
        });
    }
    
    const todayStats = analytics.dailyStats.get(today);
    todayStats.entries += entryCount;
    todayStats.users.add(userId);
}

// Routes

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Initialize user session
app.post('/api/init-session', (req, res) => {
    try {
        const { userId: existingUserId } = req.body;
        
        let userId = existingUserId;
        if (!userId || !analytics.activeUsers.has(userId)) {
            userId = generateUserId();
            analytics.totalUsers++;
        }
        
        const sessionId = generateSessionId();
        const now = Date.now();
        
        // Update active users
        analytics.activeUsers.set(userId, {
            lastSeen: now,
            sessionId: sessionId
        });
        
        // Track session
        analytics.userSessions.set(sessionId, {
            userId: userId,
            startTime: now
        });
        
        // Update daily stats
        updateDailyStats(userId);
        
        res.json({
            success: true,
            userId: userId,
            sessionId: sessionId,
            timestamp: now
        });
        
        console.log(`New session initialized: ${userId} (${sessionId})`);
        
    } catch (error) {
        console.error('Error initializing session:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to initialize session' 
        });
    }
});

// Track user activity (heartbeat)
app.post('/api/heartbeat', (req, res) => {
    try {
        const { userId, sessionId } = req.body;
        
        if (!userId || !sessionId) {
            return res.status(400).json({ 
                success: false, 
                error: 'userId and sessionId required' 
            });
        }
        
        const now = Date.now();
        
        // Update user's last seen timestamp
        if (analytics.activeUsers.has(userId)) {
            analytics.activeUsers.get(userId).lastSeen = now;
        } else {
            analytics.activeUsers.set(userId, {
                lastSeen: now,
                sessionId: sessionId
            });
        }
        
        // Update session
        if (analytics.userSessions.has(sessionId)) {
            // Session exists, just update activity
        } else {
            analytics.userSessions.set(sessionId, {
                userId: userId,
                startTime: now
            });
        }
        
        res.json({ 
            success: true, 
            timestamp: now 
        });
        
    } catch (error) {
        console.error('Error updating heartbeat:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to update activity' 
        });
    }
});

// Track entries
app.post('/api/track-entry', (req, res) => {
    try {
        const { 
            userId, 
            sessionId, 
            entryCount = 1, 
            entryType = 'log',
            metadata = {} 
        } = req.body;
        
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'userId required' 
            });
        }
        
        const now = Date.now();
        
        // Update analytics
        analytics.totalEntries += entryCount;
        
        // Update user activity
        if (analytics.activeUsers.has(userId)) {
            analytics.activeUsers.get(userId).lastSeen = now;
        }
        
        // Update daily stats
        updateDailyStats(userId, entryCount);
        
        res.json({ 
            success: true, 
            totalEntries: analytics.totalEntries,
            timestamp: now 
        });
        
        console.log(`Entry tracked: ${userId} added ${entryCount} entries (type: ${entryType})`);
        
    } catch (error) {
        console.error('Error tracking entry:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to track entry' 
        });
    }
});

// Get analytics dashboard
app.get('/api/analytics', (req, res) => {
    try {
        const activeUsersCount = getActiveUsersCount();
        const todayStats = getTodaysStats();
        
        // Get recent daily stats (last 7 days)
        const recentStats = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateString = date.toDateString();
            
            const dayStats = analytics.dailyStats.get(dateString);
            recentStats.push({
                date: dateString,
                entries: dayStats ? dayStats.entries : 0,
                uniqueUsers: dayStats ? dayStats.users.size : 0
            });
        }
        
        res.json({
            success: true,
            data: {
                totalEntries: analytics.totalEntries,
                totalUsers: analytics.totalUsers,
                activeUsers: activeUsersCount,
                today: todayStats,
                recentStats: recentStats,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch analytics' 
        });
    }
});

// Admin dashboard (basic HTML)
app.get('/admin', (req, res) => {
    const activeUsersCount = getActiveUsersCount();
    const todayStats = getTodaysStats();
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Disciplin Analytics Dashboard</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                margin: 0;
                padding: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                color: #333;
            }
            .container {
                max-width: 1200px;
                margin: 0 auto;
                background: white;
                border-radius: 15px;
                padding: 30px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            }
            h1 {
                text-align: center;
                color: #4F46E5;
                margin-bottom: 30px;
            }
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 20px;
                margin-bottom: 30px;
            }
            .stat-card {
                background: linear-gradient(135deg, #667eea, #764ba2);
                color: white;
                padding: 25px;
                border-radius: 15px;
                text-align: center;
                box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            }
            .stat-number {
                font-size: 36px;
                font-weight: bold;
                margin-bottom: 10px;
            }
            .stat-label {
                font-size: 16px;
                opacity: 0.9;
            }
            .refresh-btn {
                background: #4F46E5;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                font-size: 16px;
                cursor: pointer;
                margin: 20px auto;
                display: block;
            }
            .refresh-btn:hover {
                background: #3730a3;
            }
            .last-updated {
                text-align: center;
                color: #666;
                font-size: 14px;
                margin-top: 20px;
            }
            .status-indicator {
                display: inline-block;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #10b981;
                margin-right: 8px;
                animation: pulse 2s infinite;
            }
            @keyframes pulse {
                0% { opacity: 1; }
                50% { opacity: 0.5; }
                100% { opacity: 1; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1><span class="status-indicator"></span>Disciplin Analytics Dashboard</h1>
            
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-number">${analytics.totalEntries}</div>
                    <div class="stat-label">Total Entries</div>
                </div>
                
                <div class="stat-card">
                    <div class="stat-number">${analytics.totalUsers}</div>
                    <div class="stat-label">Total Users</div>
                </div>
                
                <div class="stat-card">
                    <div class="stat-number">${activeUsersCount}</div>
                    <div class="stat-label">Active Users (30 min)</div>
                </div>
                
                <div class="stat-card">
                    <div class="stat-number">${todayStats.entries}</div>
                    <div class="stat-label">Today's Entries</div>
                </div>
                
                <div class="stat-card">
                    <div class="stat-number">${todayStats.uniqueUsers}</div>
                    <div class="stat-label">Today's Active Users</div>
                </div>
            </div>
            
            <button class="refresh-btn" onclick="location.reload()">Refresh Data</button>
            
            <div class="last-updated">
                Last updated: ${new Date().toLocaleString()}
                <br>
                Server uptime: ${Math.floor(process.uptime() / 60)} minutes
            </div>
        </div>
        
        <script>
            // Auto-refresh every 30 seconds
            setTimeout(() => {
                location.reload();
            }, 30000);
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        success: false, 
        error: 'Something went wrong!' 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found' 
    });
});

// Cleanup old data periodically (every hour)
setInterval(() => {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
    // Clean up old active users
    for (const [userId, userData] of analytics.activeUsers) {
        if (userData.lastSeen < oneHourAgo) {
            analytics.activeUsers.delete(userId);
        }
    }
    
    // Clean up old sessions
    for (const [sessionId, sessionData] of analytics.userSessions) {
        if (sessionData.startTime < oneDayAgo) {
            analytics.userSessions.delete(sessionId);
        }
    }
    
    console.log('Cleaned up old data');
}, 60 * 60 * 1000); // Every hour

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Disciplin Analytics Server running on port ${PORT}`);
    console.log(`📊 Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`🔗 API endpoint: http://localhost:${PORT}/api`);
});

module.exports = app;
