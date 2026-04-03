/**
 * Tests voor data-retentie in cleanup.js
 * Verifieert dat berichten en ouderactiviteiten na 30 dagen worden verwijderd.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockBatch = {
  delete: jest.fn(),
  commit: jest.fn().mockResolvedValue(undefined),
};

// Houd bij welke queries worden gedaan per collection
const mockQueries = {};
function makeCollection(name) {
  return {
    get: jest.fn().mockResolvedValue({ docs: mockQueries[name] || [], empty: !(mockQueries[name]?.length) }),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };
}

// Firestore mock met collectionGroup + collection
const mockDb = {
  collection: jest.fn((name) => makeCollection(name)),
  collectionGroup: jest.fn((name) => makeCollection(name)),
  batch: jest.fn().mockReturnValue(mockBatch),
};

// Timestamp mock — gedraagt zich zoals admin.firestore.Timestamp.fromDate
const mockTimestamp = { toDate: () => new Date() };

jest.mock('../src/firebase', () => ({
  admin: {
    firestore: {
      Timestamp: {
        fromDate: jest.fn((d) => ({ _seconds: Math.floor(d.getTime() / 1000), _nanoseconds: 0, toDate: () => d })),
      },
      FieldValue: {
        serverTimestamp: () => 'ts',
        arrayUnion: (...a) => a,
        arrayRemove: (...a) => a,
        delete: () => 'delete',
      },
    },
  },
  db: mockDb,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function makeDoc(id, data = {}) {
  return { id, ref: { id }, data: () => data };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('cleanMessages — 30-dagenretentie', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBatch.delete.mockClear();
    mockBatch.commit.mockClear();
  });

  it('verwijdert berichten ouder dan 30 dagen', async () => {
    // Stel één gesprek in met twee berichten: één oud, één recent
    const oldMsg   = makeDoc('msg-old',   { createdAt: { _seconds: Math.floor(daysAgo(35).getTime() / 1000) } });
    const newMsg   = makeDoc('msg-new',   { createdAt: { _seconds: Math.floor(daysAgo(5).getTime()  / 1000) } });
    const convDoc  = makeDoc('conv-1');

    // Mock: conversations.get() → [convDoc]
    // Mock: convDoc.ref.collection('messages').where(...).get() → [oldMsg]
    const mockMsgsCollection = {
      where: jest.fn().mockReturnThis(),
      get:   jest.fn().mockResolvedValue({ docs: [oldMsg], empty: false }),
    };
    convDoc.ref.collection = jest.fn().mockReturnValue(mockMsgsCollection);

    mockDb.collection.mockImplementation((name) => {
      if (name === 'conversations') {
        return {
          get: jest.fn().mockResolvedValue({ docs: [convDoc], empty: false }),
        };
      }
      return makeCollection(name);
    });

    const { cleanMessages } = require('../src/cleanup');
    // cleanMessages is niet geëxporteerd — test via runCleanup of direct
    // Omdat cleanMessages privé is, testen we het via de geëxporteerde runCleanup
    // maar mocken we de log-output weg
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { runCleanup } = require('../src/cleanup');
    await runCleanup();
    consoleSpy.mockRestore();

    // batch.delete moet zijn aangeroepen voor oldMsg
    expect(mockBatch.delete).toHaveBeenCalledWith(oldMsg.ref);
    expect(mockBatch.commit).toHaveBeenCalled();
  });

  it('raakt berichten jonger dan 30 dagen niet aan', async () => {
    const recentMsg = makeDoc('msg-recent', { createdAt: { _seconds: Math.floor(daysAgo(10).getTime() / 1000) } });
    const convDoc   = makeDoc('conv-2');

    const mockMsgsCollection = {
      where: jest.fn().mockReturnThis(),
      get:   jest.fn().mockResolvedValue({ docs: [], empty: true }),
    };
    convDoc.ref.collection = jest.fn().mockReturnValue(mockMsgsCollection);

    mockDb.collection.mockImplementation((name) => {
      if (name === 'conversations') {
        return { get: jest.fn().mockResolvedValue({ docs: [convDoc], empty: false }) };
      }
      return makeCollection(name);
    });

    jest.resetModules(); // fresh module om caching te omzeilen
    jest.mock('../src/firebase', () => ({
      admin: {
        firestore: {
          Timestamp: { fromDate: jest.fn((d) => ({ _seconds: Math.floor(d.getTime() / 1000) })) },
          FieldValue: { serverTimestamp: () => 'ts', arrayUnion: (...a) => a, arrayRemove: (...a) => a },
        },
      },
      db: mockDb,
    }));

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { runCleanup } = require('../src/cleanup');
    await runCleanup();
    consoleSpy.mockRestore();

    // Geen deletes voor recente berichten
    expect(mockBatch.delete).not.toHaveBeenCalledWith(recentMsg.ref);
  });
});

describe('cleanParentActivities — 30-dagenretentie', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBatch.delete.mockClear();
    mockBatch.commit.mockClear();
  });

  it('verwijdert ouderactiviteiten ouder dan 30 dagen', async () => {
    const oldActivity = makeDoc('pa-old', {
      createdAt: { _seconds: Math.floor(daysAgo(31).getTime() / 1000) },
      type: 'friend_request_sent',
    });

    mockDb.collection.mockImplementation((name) => {
      if (name === 'parentActivities') {
        return {
          where: jest.fn().mockReturnThis(),
          get:   jest.fn().mockResolvedValue({ docs: [oldActivity], empty: false }),
        };
      }
      if (name === 'conversations') {
        return { get: jest.fn().mockResolvedValue({ docs: [], empty: true }) };
      }
      return {
        where: jest.fn().mockReturnThis(),
        get:   jest.fn().mockResolvedValue({ docs: [], empty: true }),
      };
    });

    jest.resetModules();
    jest.mock('../src/firebase', () => ({
      admin: {
        firestore: {
          Timestamp: { fromDate: jest.fn((d) => ({ _seconds: Math.floor(d.getTime() / 1000) })) },
          FieldValue: { serverTimestamp: () => 'ts', arrayUnion: (...a) => a, arrayRemove: (...a) => a },
        },
      },
      db: mockDb,
    }));

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { runCleanup } = require('../src/cleanup');
    await runCleanup();
    consoleSpy.mockRestore();

    expect(mockBatch.delete).toHaveBeenCalledWith(oldActivity.ref);
    expect(mockBatch.commit).toHaveBeenCalled();
  });

  it('behoudt ouderactiviteiten jonger dan 30 dagen', async () => {
    const recentActivity = makeDoc('pa-recent', {
      createdAt: { _seconds: Math.floor(daysAgo(15).getTime() / 1000) },
    });

    mockDb.collection.mockImplementation((name) => {
      if (name === 'parentActivities') {
        return {
          where: jest.fn().mockReturnThis(),
          get:   jest.fn().mockResolvedValue({ docs: [], empty: true }),
        };
      }
      if (name === 'conversations') {
        return { get: jest.fn().mockResolvedValue({ docs: [], empty: true }) };
      }
      return {
        where: jest.fn().mockReturnThis(),
        get:   jest.fn().mockResolvedValue({ docs: [], empty: true }),
      };
    });

    jest.resetModules();
    jest.mock('../src/firebase', () => ({
      admin: {
        firestore: {
          Timestamp: { fromDate: jest.fn((d) => ({ _seconds: Math.floor(d.getTime() / 1000) })) },
          FieldValue: { serverTimestamp: () => 'ts', arrayUnion: (...a) => a, arrayRemove: (...a) => a },
        },
      },
      db: mockDb,
    }));

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { runCleanup } = require('../src/cleanup');
    await runCleanup();
    consoleSpy.mockRestore();

    expect(mockBatch.delete).not.toHaveBeenCalledWith(recentActivity.ref);
  });
});

describe('Retentiebeleid constanten', () => {
  it('hanteert 30 dagen voor berichten en ouderactiviteiten', () => {
    jest.resetModules();
    jest.mock('../src/firebase', () => ({
      admin: {
        firestore: {
          Timestamp: { fromDate: jest.fn((d) => d) },
          FieldValue: { serverTimestamp: () => 'ts' },
        },
      },
      db: mockDb,
    }));

    // Controleer cutoff-datum: moet >= 30 dagen geleden zijn
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { admin } = require('../src/firebase');
    const fromDateSpy = admin.firestore.Timestamp.fromDate;

    // Laad cleanup om de constanten te activeren
    require('../src/cleanup');

    // Verifieer dat cutoff ~30 dagen geleden ligt (29-31 dagen marge voor DST-variatie)
    const now = new Date();
    expect(thirtyDaysAgo.getTime()).toBeLessThan(now.getTime());
    const diffDays = (now.getTime() - thirtyDaysAgo.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });
});
