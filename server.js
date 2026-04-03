// ─── Sentry (moet als eerste worden geïnitialiseerd) ─────────────────────────
const Sentry = require('@sentry/node');
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: process.env.NODE_ENV === 'production',
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.2,
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// ─── Core modules ─────────────────────────────────────────────────────────────
const { admin, db } = require('./src/firebase');
const { redisPub, redisSub, checkRateLimit } = require('./src/redis');
const { onlineUsers, activeCalls, inactiveUsers, activeSessions } = require('./src/state');
const { globalLimiter, securityHeaders, makeRateLimiter, makeSecondLimiter } = require('./src/middleware');

// ─── Cleanup module ───────────────────────────────────────────────────────────
const { runCleanup, scheduleDaily } = require('./src/cleanup');

// ─── Route modules ────────────────────────────────────────────────────────────
const authRouter    = require('./src/routes/auth');
const miscRouter    = require('./src/routes/misc');
const usersRouter   = require('./src/routes/users');
const parentRouter  = require('./src/routes/parent');
const friendsRouter = require('./src/routes/friends');
const agendaRouter  = require('./src/routes/agenda');

// ─── Socket handler modules ───────────────────────────────────────────────────
const registerPresence      = require('./src/socket/presence');
const registerMessages      = require('./src/socket/messages');
const registerCalls         = require('./src/socket/calls');
const registerConversations = require('./src/socket/conversations');

// ─── App URL ──────────────────────────────────────────────────────────────────
const APP_URL = process.env.APP_URL;
if (!APP_URL) console.warn('⚠️ APP_URL niet ingesteld — stel dit in als de Cloudflare Pages URL in de Railway omgevingsvariabelen.');

// ─── Express + HTTP + Socket.IO ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// CORS: sta alleen bekende origins toe. Primaire beveiliging = Firebase-token
// verificatie in de Socket.IO auth middleware.
const allowedOrigins = APP_URL
  ? [...APP_URL.split(',').map(s => s.trim()), 'http://localhost:3000', 'http://localhost:5173']
  : null;
const corsOrigin = allowedOrigins
  ? (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(new Error('CORS: origin niet toegestaan'));
    }
  : true; // fallback voor development zonder APP_URL

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
});

// Redis adapter: synchroniseert Socket.IO events tussen meerdere server-instanties
if (redisPub && redisSub) {
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    io.adapter(createAdapter(redisPub, redisSub));
    console.log('✅ Socket.IO Redis adapter actief');
  } catch (e) {
    console.warn('⚠️ Socket.IO Redis adapter mislukt:', e.message);
  }
}

// ─── Express middleware ───────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());
app.use(globalLimiter);
app.use(securityHeaders);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(authRouter);
app.use(miscRouter);
app.use(usersRouter(io, onlineUsers));
app.use(parentRouter(io, onlineUsers));
app.use(friendsRouter(io, onlineUsers));
app.use(agendaRouter(io));


// ─── Socket.IO auth middleware ────────────────────────────────────────────────
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authenticatie vereist.'));
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    socket.userId = decoded.uid;
    next();
  } catch {
    next(new Error('Ongeldig token.'));
  }
});

// ─── Socket.IO connection handler ────────────────────────────────────────────
io.on('connection', (socket) => {
  const uid = socket.userId;
  console.log('🔌 Verbonden:', socket.id, uid);

  // In-memory limiters per socket (eerste verdedigingslinie, altijd actief)
  const limits = {
    'message:send':           makeSecondLimiter(10),
    'message:react':          makeRateLimiter(60),
    'message:edit':           makeRateLimiter(20),
    'typing:start':           makeRateLimiter(60),
    'call:offer':             makeRateLimiter(15, 60 * 60 * 1000), // 15 per uur
    'conversation:create':    makeRateLimiter(10, 60 * 60 * 1000), // 10 per uur
    'conversation:addMember': makeRateLimiter(20),
  };
  // Redis-limieten voor cross-instance bescherming (tweede verdedigingslinie)
  const redisLimits = {
    'call:offer':          { max: 15, windowMs: 60 * 60 * 1000 },
    'conversation:create': { max: 10, windowMs: 60 * 60 * 1000 },
    'message:send':        { max: 600, windowMs: 60 * 1000 },
  };
  // Middleware: in-memory check synchroon, Redis check asynchroon
  socket.use(async ([event, ...args], next) => {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    // In-memory check
    const check = limits[event];
    if (check && !check()) {
      console.warn(`[Pulse] Rate limit (lokaal): ${uid} → ${event}`);
      if (cb) cb({ error: 'Te veel verzoeken. Wacht even.' });
      return;
    }
    // Redis cross-instance check
    const rDef = redisLimits[event];
    if (rDef && !(await checkRateLimit(uid, event, rDef.max, rDef.windowMs))) {
      console.warn(`[Pulse] Rate limit (Redis): ${uid} → ${event}`);
      if (cb) cb({ error: 'Te veel verzoeken. Wacht even.' });
      return;
    }
    next();
  });

  // Typing indicators (inline — not worth a separate module)
  const typingTimers = {};
  socket.on('typing:start', ({ convId, name }) => {
    socket.to(convId).emit('typing:update', { uid, name, typing: true });
    clearTimeout(typingTimers[convId]);
    typingTimers[convId] = setTimeout(() => {
      socket.to(convId).emit('typing:update', { uid, typing: false });
      delete typingTimers[convId];
    }, 2000);
  });
  socket.on('typing:stop', ({ convId }) => {
    clearTimeout(typingTimers[convId]);
    delete typingTimers[convId];
    socket.to(convId).emit('typing:update', { uid, typing: false });
  });

  // Register all socket handler modules
  registerPresence(io, socket, uid);
  registerMessages(io, socket, uid);
  registerCalls(io, socket, uid);
  registerConversations(io, socket, uid);

  // ── Verbreken ──
  socket.on('disconnect', async () => {
    const uid = socket.userId ?? socket.data.uid;
    if (uid) {
      onlineUsers[uid]?.delete(socket.id);
      activeCalls.delete(uid);
      if (!onlineUsers[uid]?.size) {
        delete onlineUsers[uid];
        inactiveUsers.delete(uid);
        io.emit('user:status', { uid, online: false });
        db.collection('users').doc(uid).update({ online: false, inactive: false, lastSeen: admin.firestore.FieldValue.serverTimestamp() }).catch(e => console.warn('Offline-update mislukt:', e.message));
        // Sessie afsluiten
        if (activeSessions[uid]) {
          const { sessionDocId, startTime, accumulated, pausedAt } = activeSessions[uid];
          delete activeSessions[uid];
          const activeTime = pausedAt ? 0 : Math.round((Date.now() - startTime) / 1000);
          const duration = accumulated + activeTime;
          db.collection('userSessions').doc(sessionDocId).update({
            endTime: admin.firestore.FieldValue.serverTimestamp(), duration,
          }).catch(e => console.warn('Session end opslaan mislukt:', e.message));
        }
      }
      console.log(`👋 Offline: ${uid}`);
    }
  });
});

// ─── Retentiecleanup — 30 dagen voor alle communicatiegegevens ───────────────
// Direct éénmalig uitvoeren bij opstarten (voor backfill van bestaande data),
// daarna dagelijks om 03:00 via de scheduler in cleanup.js
runCleanup();
scheduleDaily();

// ─── Reset online-status bij serverstart ──────────────────────────────────────
(async () => {
  try {
    const snap = await db.collection('users').where('online', '==', true).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { online: false, inactive: false }));
    await batch.commit();
    console.log(`🔄 Online-status gereset voor ${snap.size} gebruiker(s) bij serverstart`);
  } catch (err) {
    console.warn('Online-reset bij start mislukt:', err.message);
  }
})();

// ─── Sentry error handler (na alle routes) ───────────────────────────────────
Sentry.setupExpressErrorHandler(app);

// Generieke Express error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[Pulse] Server error:', err.message);
  res.status(500).json({ error: 'Interne serverfout' });
});

// ─── Server starten ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Pulse server draait op poort ${PORT}`);
});
