import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { prisma } from './lib/prisma.js';
import { calculateStreaks, isDateScheduled } from './utils/streak.js';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Middlewares
const allowedOrigins = [
  'http://localhost:3000',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl) or allowed origins or any vercel.app domain
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Authenticated Request Interface
interface AuthRequest extends Request {
  user?: {
    userId: string;
    email: string;
    name: string;
    picture?: string;
  };
}

// Authentication Middleware
const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<any> => {
  const token = req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
};

// Helper: Format Date to YYYY-MM-DD
const getTodayIso = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getParamStr = (val: unknown): string => {
  if (Array.isArray(val)) return String(val[0] ?? '');
  if (typeof val === 'string') return val;
  return '';
};

// ----------------------------------------------------
// BASIC & AUTH ROUTES
// ----------------------------------------------------
app.get('/', (req: Request, res: Response) => {
  res.send('Traxx Habit & Task Tracker API is running!');
});

app.get('/api/app-name', (req: Request, res: Response) => {
  res.json({ "app-name": "traxx" });
});

// Google Token Login / Registration
app.post('/api/auth/google', async (req: Request, res: Response): Promise<any> => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Google credential missing' });
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID || '',
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Invalid Google payload' });
    }

    const { email, name, picture, sub } = payload;

    // Upsert user in database
    const user = await prisma.user.upsert({
      where: { email },
      update: {
        name: name || 'User',
        ...(picture ? { picture } : {}),
        googleId: sub,
      },
      create: {
        email,
        name: name || 'User',
        picture: picture || null,
        googleId: sub,
      },
    });

    // Create a JWT session
    const sessionToken = jwt.sign(
      { userId: user.id, email: user.email, name: user.name, picture: user.picture },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const isProd = process.env.NODE_ENV === 'production';

    res.cookie('auth_token', sessionToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
    });
  } catch (error) {
    console.error('[AUTH] Google Auth Error:', error);
    return res.status(401).json({ error: 'Failed to verify Google token' });
  }
});

// Check Session
app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, picture: true },
    });
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    return res.status(200).json({ user });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// Logout
app.post('/api/auth/logout', (req: Request, res: Response): any => {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  });
  return res.status(200).json({ success: true });
});

// ----------------------------------------------------
// HABIT CRUD ROUTES
// ----------------------------------------------------

// List all habits with today's log & 7-day mini overview & schedule metadata
app.get('/api/habits', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const targetDate = typeof req.query['date'] === 'string' ? req.query['date'] : getTodayIso();

    // Calculate dates for past 7 days relative to targetDate
    const targetParts = targetDate.split('-').map(Number);
    const targetBase = new Date(Date.UTC(targetParts[0] ?? 1970, (targetParts[1] ?? 1) - 1, targetParts[2] ?? 1));

    const past7Days: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(targetBase.getTime());
      d.setUTCDate(d.getUTCDate() - i);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      past7Days.push(`${y}-${m}-${day}`);
    }

    const habits = await prisma.habit.findMany({
      where: { userId, archived: false },
      include: {
        statusOptions: {
          orderBy: { order: 'asc' },
        },
        logs: {
          where: {
            date: { in: past7Days },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const enrichedHabits = habits.map((habit) => {
      const todayLog = habit.logs.find((l) => l.date === targetDate) || null;
      const isScheduledToday = isDateScheduled(targetDate, habit.frequencyType, habit.frequencyDays);

      // Map past 7 days logs
      const history7Days = past7Days.map((dateStr) => {
        const log = habit.logs.find((l) => l.date === dateStr);
        const scheduled = isDateScheduled(dateStr, habit.frequencyType, habit.frequencyDays);
        let color: string | null = null;
        if (log && habit.type === 'STATUS' && log.statusValue) {
          const opt = habit.statusOptions.find((o) => o.value === log.statusValue);
          color = opt ? opt.color : null;
        }
        return {
          date: dateStr,
          isCompleted: log?.isCompleted || false,
          isScheduled: scheduled,
          numericValue: log?.numericValue ?? null,
          statusValue: log?.statusValue ?? null,
          color,
        };
      });

      return {
        id: habit.id,
        title: habit.title,
        description: habit.description,
        category: habit.category,
        color: habit.color,
        icon: habit.icon,
        type: habit.type,
        unit: habit.unit,
        targetValue: habit.targetValue,
        aggregationType: habit.aggregationType,
        frequencyType: habit.frequencyType,
        frequencyDays: habit.frequencyDays,
        frequencyTarget: habit.frequencyTarget,
        reminderEnabled: habit.reminderEnabled,
        reminderTime: habit.reminderTime,
        isScheduledToday,
        currentStreak: habit.currentStreak,
        bestStreak: habit.bestStreak,
        lastCompletedDate: habit.lastCompletedDate,
        statusOptions: habit.statusOptions,
        todayLog,
        history7Days,
      };
    });

    return res.status(200).json(enrichedHabits);
  } catch (error) {
    console.error('[API] Get Habits Error:', error);
    return res.status(500).json({ error: 'Failed to fetch habits' });
  }
});

// Create a new Habit (with Frequency & Reminders)
app.post('/api/habits', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const {
      title,
      description,
      category,
      color = '#6366F1',
      icon = 'CheckCircle',
      type,
      unit,
      targetValue,
      aggregationType = 'SUM',
      frequencyType = 'DAILY',
      frequencyDays,
      frequencyTarget,
      reminderEnabled = false,
      reminderTime,
      statusOptions = [],
    } = req.body;

    if (!title || !type) {
      return res.status(400).json({ error: 'Title and type are required' });
    }

    if (type === 'NUMERICAL') {
      if (!unit || targetValue === undefined || targetValue === null) {
        return res.status(400).json({ error: 'Numerical habits must have a unit and targetValue' });
      }
    }

    const newHabit = await prisma.habit.create({
      data: {
        userId,
        title,
        description: description ? String(description) : null,
        category: category ? String(category) : 'General',
        color: String(color),
        icon: String(icon),
        type: String(type),
        unit: type === 'NUMERICAL' && unit ? String(unit) : null,
        targetValue: type === 'NUMERICAL' && targetValue !== undefined ? parseFloat(targetValue) : null,
        aggregationType: type === 'NUMERICAL' && aggregationType ? String(aggregationType) : null,
        frequencyType: String(frequencyType),
        frequencyDays: frequencyDays ? String(frequencyDays) : null,
        frequencyTarget: frequencyTarget ? parseInt(frequencyTarget, 10) : null,
        reminderEnabled: Boolean(reminderEnabled),
        reminderTime: reminderTime ? String(reminderTime) : null,
        ...(type === 'STATUS' && Array.isArray(statusOptions) && statusOptions.length > 0
          ? {
              statusOptions: {
                create: statusOptions.map((opt: any, idx: number) => ({
                  label: opt.label ? String(opt.label) : 'State',
                  value: opt.value ? String(opt.value) : `STATE_${idx + 1}`,
                  color: opt.color ? String(opt.color) : '#3B82F6',
                  order: typeof opt.order === 'number' ? opt.order : idx,
                  isCompleted: Boolean(opt.isCompleted),
                })),
              },
            }
          : {}),
      },
      include: {
        statusOptions: {
          orderBy: { order: 'asc' },
        },
      },
    });

    return res.status(201).json(newHabit);
  } catch (error) {
    console.error('[API] Create Habit Error:', error);
    return res.status(500).json({ error: 'Failed to create habit' });
  }
});

// Get single habit details
app.get('/api/habits/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Habit ID required' });

    const habit = await prisma.habit.findFirst({
      where: { id, userId },
      include: {
        statusOptions: { orderBy: { order: 'asc' } },
        logs: { orderBy: { date: 'desc' }, take: 30 },
      },
    });

    if (!habit) {
      return res.status(404).json({ error: 'Habit not found' });
    }

    return res.status(200).json(habit);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch habit' });
  }
});

// Update Habit
app.put('/api/habits/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Habit ID required' });

    const {
      title,
      description,
      category,
      color,
      icon,
      unit,
      targetValue,
      aggregationType,
      frequencyType,
      frequencyDays,
      frequencyTarget,
      reminderEnabled,
      reminderTime,
      statusOptions,
    } = req.body;

    const existing = await prisma.habit.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Habit not found' });
    }

    const updatedHabit = await prisma.$transaction(async (tx) => {
      if (existing.type === 'STATUS' && Array.isArray(statusOptions)) {
        await tx.habitStatusOption.deleteMany({ where: { habitId: id } });
        await tx.habitStatusOption.createMany({
          data: statusOptions.map((opt: any, idx: number) => ({
            habitId: id,
            label: opt.label ? String(opt.label) : 'State',
            value: opt.value ? String(opt.value) : `STATE_${idx + 1}`,
            color: opt.color ? String(opt.color) : '#3B82F6',
            order: typeof opt.order === 'number' ? opt.order : idx,
            isCompleted: Boolean(opt.isCompleted),
          })),
        });
      }

      return tx.habit.update({
        where: { id },
        data: {
          title: title !== undefined ? String(title) : existing.title,
          description: description !== undefined ? (description ? String(description) : null) : existing.description,
          category: category !== undefined ? (category ? String(category) : null) : existing.category,
          color: color !== undefined ? String(color) : existing.color,
          icon: icon !== undefined ? String(icon) : existing.icon,
          unit: existing.type === 'NUMERICAL' ? (unit !== undefined ? (unit ? String(unit) : null) : existing.unit) : null,
          targetValue: existing.type === 'NUMERICAL' && targetValue !== undefined ? parseFloat(targetValue) : existing.targetValue,
          aggregationType: existing.type === 'NUMERICAL' ? (aggregationType !== undefined ? (aggregationType ? String(aggregationType) : null) : existing.aggregationType) : null,
          frequencyType: frequencyType !== undefined ? String(frequencyType) : existing.frequencyType,
          frequencyDays: frequencyDays !== undefined ? (frequencyDays ? String(frequencyDays) : null) : existing.frequencyDays,
          frequencyTarget: frequencyTarget !== undefined ? (frequencyTarget ? parseInt(frequencyTarget, 10) : null) : existing.frequencyTarget,
          reminderEnabled: reminderEnabled !== undefined ? Boolean(reminderEnabled) : existing.reminderEnabled,
          reminderTime: reminderTime !== undefined ? (reminderTime ? String(reminderTime) : null) : existing.reminderTime,
        },
        include: {
          statusOptions: { orderBy: { order: 'asc' } },
        },
      });
    });

    return res.status(200).json(updatedHabit);
  } catch (error) {
    console.error('[API] Update Habit Error:', error);
    return res.status(500).json({ error: 'Failed to update habit' });
  }
});

// Delete Habit
app.delete('/api/habits/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Habit ID required' });

    const habit = await prisma.habit.findFirst({
      where: { id, userId },
    });

    if (!habit) {
      return res.status(404).json({ error: 'Habit not found' });
    }

    await prisma.habit.delete({
      where: { id },
    });

    return res.status(200).json({ success: true, message: 'Habit deleted successfully' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete habit' });
  }
});

// ----------------------------------------------------
// DAILY LOG CHECK-IN & SCHEDULE-AWARE STREAKS
// ----------------------------------------------------
app.post('/api/habits/:id/log', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Habit ID required' });

    const { date = getTodayIso(), numericValue, statusValue, notes, clear } = req.body;

    const habit = await prisma.habit.findFirst({
      where: { id, userId },
      include: { statusOptions: true },
    });

    if (!habit) {
      return res.status(404).json({ error: 'Habit not found' });
    }

    let log = null;

    if (clear === true) {
      // Clear/remove log for this date
      await prisma.habitLog.deleteMany({
        where: {
          habitId: id,
          date: String(date),
        },
      });
    } else {
      // Determine isCompleted
      let isCompleted = false;
      let finalNumeric: number | null = null;
      let finalStatus: string | null = null;

      if (habit.type === 'NUMERICAL') {
        if (numericValue !== undefined && numericValue !== null && numericValue !== '') {
          finalNumeric = parseFloat(numericValue);
          isCompleted = habit.targetValue !== null ? finalNumeric >= habit.targetValue : finalNumeric > 0;
        }
      } else if (habit.type === 'STATUS') {
        finalStatus = statusValue ? String(statusValue) : null;
        if (finalStatus) {
          const option = habit.statusOptions.find((opt) => opt.value === finalStatus);
          isCompleted = option ? option.isCompleted : false;
        }
      }

      // Upsert Log Entry
      log = await prisma.habitLog.upsert({
        where: {
          habitId_date: {
            habitId: id,
            date: String(date),
          },
        },
        update: {
          numericValue: finalNumeric,
          statusValue: finalStatus,
          isCompleted,
          ...(notes !== undefined ? { notes: notes ? String(notes) : null } : {}),
        },
        create: {
          habitId: id,
          userId,
          date: String(date),
          numericValue: finalNumeric,
          statusValue: finalStatus,
          isCompleted,
          notes: notes ? String(notes) : null,
        },
      });
    }

    // Recalculate Streaks for this habit taking habit frequency into account
    const allCompletedLogs = await prisma.habitLog.findMany({
      where: {
        habitId: id,
        isCompleted: true,
      },
      select: { date: true },
      orderBy: { date: 'asc' },
    });

    const completedDates = allCompletedLogs.map((l) => l.date);
    const { currentStreak, bestStreak, lastCompletedDate } = calculateStreaks(
      completedDates,
      String(date),
      habit.frequencyType,
      habit.frequencyDays
    );

    // Update habit model with new streaks
    const updatedHabit = await prisma.habit.update({
      where: { id },
      data: {
        currentStreak,
        bestStreak,
        lastCompletedDate,
      },
      select: {
        id: true,
        currentStreak: true,
        bestStreak: true,
        lastCompletedDate: true,
      },
    });

    return res.status(200).json({
      success: true,
      log,
      cleared: clear === true,
      streaks: {
        currentStreak: updatedHabit.currentStreak,
        bestStreak: updatedHabit.bestStreak,
        lastCompletedDate: updatedHabit.lastCompletedDate,
      },
    });
  } catch (error) {
    console.error('[API] Log Habit Error:', error);
    return res.status(500).json({ error: 'Failed to record daily log' });
  }
});

// Clear / Delete Habit Log for a specific date
app.delete('/api/habits/:id/log', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Habit ID required' });

    const date = typeof req.query['date'] === 'string' ? req.query['date'] : getTodayIso();

    const habit = await prisma.habit.findFirst({
      where: { id, userId },
    });

    if (!habit) {
      return res.status(404).json({ error: 'Habit not found' });
    }

    await prisma.habitLog.deleteMany({
      where: {
        habitId: id,
        date: String(date),
      },
    });

    // Recalculate Streaks
    const allCompletedLogs = await prisma.habitLog.findMany({
      where: {
        habitId: id,
        isCompleted: true,
      },
      select: { date: true },
      orderBy: { date: 'asc' },
    });

    const completedDates = allCompletedLogs.map((l) => l.date);
    const { currentStreak, bestStreak, lastCompletedDate } = calculateStreaks(
      completedDates,
      String(date),
      habit.frequencyType,
      habit.frequencyDays
    );

    const updatedHabit = await prisma.habit.update({
      where: { id },
      data: {
        currentStreak,
        bestStreak,
        lastCompletedDate,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Log cleared successfully',
      streaks: {
        currentStreak: updatedHabit.currentStreak,
        bestStreak: updatedHabit.bestStreak,
        lastCompletedDate: updatedHabit.lastCompletedDate,
      },
    });
  } catch (error) {
    console.error('[API] Delete Habit Log Error:', error);
    return res.status(500).json({ error: 'Failed to delete daily log' });
  }
});

// Get logs in date range (for Calendar / Heatmap)
app.get('/api/habits/:id/logs', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Habit ID required' });

    const startDate = typeof req.query['startDate'] === 'string' ? req.query['startDate'] : undefined;
    const endDate = typeof req.query['endDate'] === 'string' ? req.query['endDate'] : undefined;

    const habit = await prisma.habit.findFirst({
      where: { id, userId },
      include: { statusOptions: true },
    });

    if (!habit) {
      return res.status(404).json({ error: 'Habit not found' });
    }

    const whereClause: { habitId: string; date?: { gte?: string; lte?: string } } = { habitId: id };
    if (startDate && endDate) {
      whereClause.date = {
        gte: startDate,
        lte: endDate,
      };
    }

    const logs = await prisma.habitLog.findMany({
      where: whereClause,
      orderBy: { date: 'asc' },
    });

    const enrichedLogs = logs.map((log) => {
      let color: string | null = null;
      if (habit.type === 'STATUS' && log.statusValue) {
        const opt = habit.statusOptions.find((o) => o.value === log.statusValue);
        color = opt ? opt.color : null;
      }
      return {
        ...log,
        color,
      };
    });

    return res.status(200).json({
      habitId: id,
      logs: enrichedLogs,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Detailed Habit Stats & Analytics
app.get('/api/habits/:id/stats', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Habit ID required' });

    const habit = await prisma.habit.findFirst({
      where: { id, userId },
      include: {
        statusOptions: true,
        logs: { orderBy: { date: 'asc' } },
      },
    });

    if (!habit) {
      return res.status(404).json({ error: 'Habit not found' });
    }

    const totalLogs = habit.logs.length;
    const completedLogs = habit.logs.filter((l) => l.isCompleted);
    const completionRate = totalLogs > 0 ? Math.round((completedLogs.length / totalLogs) * 100) : 0;

    let numericalStats = null;
    if (habit.type === 'NUMERICAL') {
      const validNumbers = habit.logs
        .map((l) => l.numericValue)
        .filter((v): v is number => v !== null && v !== undefined);

      const sum = validNumbers.reduce((acc: number, curr: number) => acc + curr, 0);
      const avg = validNumbers.length > 0 ? Number((sum / validNumbers.length).toFixed(1)) : 0;
      const max = validNumbers.length > 0 ? Math.max(...validNumbers) : 0;

      numericalStats = {
        totalSum: sum,
        dailyAverage: avg,
        maxValue: max,
        unit: habit.unit,
        targetValue: habit.targetValue,
        aggregationType: habit.aggregationType,
      };
    }

    let statusDistribution: any[] = [];
    if (habit.type === 'STATUS') {
      statusDistribution = habit.statusOptions.map((opt) => {
        const count = habit.logs.filter((l) => l.statusValue === opt.value).length;
        const percentage = totalLogs > 0 ? Math.round((count / totalLogs) * 100) : 0;
        return {
          label: opt.label,
          value: opt.value,
          color: opt.color,
          count,
          percentage,
          isCompleted: opt.isCompleted,
        };
      });
    }

    return res.status(200).json({
      habitId: habit.id,
      title: habit.title,
      type: habit.type,
      currentStreak: habit.currentStreak,
      bestStreak: habit.bestStreak,
      totalLoggedDays: totalLogs,
      completedDays: completedLogs.length,
      completionRate: `${completionRate}%`,
      numericalStats,
      statusDistribution,
    });
  } catch (error) {
    console.error('[API] Habit Stats Error:', error);
    return res.status(500).json({ error: 'Failed to fetch habit stats' });
  }
});

// ----------------------------------------------------
// TASK (TO-DO) CRUD ROUTES
// ----------------------------------------------------

// List tasks for a given date
app.get('/api/tasks', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const targetDate = typeof req.query['date'] === 'string' ? req.query['date'] : getTodayIso();

    const tasks = await prisma.task.findMany({
      where: { userId, date: targetDate },
      orderBy: [
        { isCompleted: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    return res.status(200).json(tasks);
  } catch (error) {
    console.error('[API] Get Tasks Error:', error);
    return res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Create new Task
app.post('/api/tasks', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const {
      title,
      description,
      date = getTodayIso(),
      priority = 'MEDIUM',
      category,
      time,
      reminderTime,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }

    const newTask = await prisma.task.create({
      data: {
        userId,
        title: title.trim(),
        description: description ? String(description) : null,
        date: String(date),
        priority: String(priority),
        category: category ? String(category) : 'General',
        time: time ? String(time) : null,
        reminderTime: reminderTime ? String(reminderTime) : null,
      },
    });

    return res.status(201).json(newTask);
  } catch (error) {
    console.error('[API] Create Task Error:', error);
    return res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update Task (Toggle complete, update title/date/priority/time)
app.put('/api/tasks/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Task ID required' });

    const {
      title,
      description,
      date,
      isCompleted,
      priority,
      category,
      time,
      reminderTime,
    } = req.body;

    const existing = await prisma.task.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const updatedTask = await prisma.task.update({
      where: { id },
      data: {
        title: title !== undefined ? String(title) : existing.title,
        description: description !== undefined ? (description ? String(description) : null) : existing.description,
        date: date !== undefined ? String(date) : existing.date,
        isCompleted: isCompleted !== undefined ? Boolean(isCompleted) : existing.isCompleted,
        priority: priority !== undefined ? String(priority) : existing.priority,
        category: category !== undefined ? (category ? String(category) : null) : existing.category,
        time: time !== undefined ? (time ? String(time) : null) : existing.time,
        reminderTime: reminderTime !== undefined ? (reminderTime ? String(reminderTime) : null) : existing.reminderTime,
      },
    });

    return res.status(200).json(updatedTask);
  } catch (error) {
    console.error('[API] Update Task Error:', error);
    return res.status(500).json({ error: 'Failed to update task' });
  }
});

// Delete Task
app.delete('/api/tasks/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Task ID required' });

    const existing = await prisma.task.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await prisma.task.delete({
      where: { id },
    });

    return res.status(200).json({ success: true, message: 'Task deleted successfully' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ----------------------------------------------------
// UNIFIED DAILY PLAN & TO-DO AGGREGATOR
// ----------------------------------------------------
app.get('/api/daily-plan', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const targetDate = typeof req.query['date'] === 'string' ? req.query['date'] : getTodayIso();

    // 1. Fetch all active user habits with status options and today's log
    const habits = await prisma.habit.findMany({
      where: { userId, archived: false },
      include: {
        statusOptions: { orderBy: { order: 'asc' } },
        logs: { where: { date: targetDate } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Filter habits scheduled for this targetDate (or already logged for this day)
    const scheduledHabits = habits
      .filter((habit) => {
        const isScheduled = isDateScheduled(targetDate, habit.frequencyType, habit.frequencyDays);
        const hasLog = habit.logs.length > 0;
        return isScheduled || hasLog;
      })
      .map((habit) => {
        const todayLog = habit.logs[0] || null;
        const isScheduled = isDateScheduled(targetDate, habit.frequencyType, habit.frequencyDays);
        return {
          id: habit.id,
          title: habit.title,
          description: habit.description,
          category: habit.category,
          color: habit.color,
          icon: habit.icon,
          type: habit.type,
          unit: habit.unit,
          targetValue: habit.targetValue,
          aggregationType: habit.aggregationType,
          frequencyType: habit.frequencyType,
          frequencyDays: habit.frequencyDays,
          frequencyTarget: habit.frequencyTarget,
          reminderEnabled: habit.reminderEnabled,
          reminderTime: habit.reminderTime,
          isScheduled,
          currentStreak: habit.currentStreak,
          bestStreak: habit.bestStreak,
          statusOptions: habit.statusOptions,
          todayLog,
          isCompleted: todayLog?.isCompleted || false,
        };
      });

    // 2. Fetch all custom tasks for this targetDate
    const tasks = await prisma.task.findMany({
      where: { userId, date: targetDate },
      orderBy: [
        { isCompleted: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    // 3. Construct unified list of items for the daily to-do planner
    const habitItems = scheduledHabits.map((habit) => ({
      id: `habit-${habit.id}`,
      originalId: habit.id,
      itemType: 'HABIT' as const,
      title: habit.title,
      description: habit.description,
      category: habit.category || 'Habit',
      color: habit.color,
      icon: habit.icon,
      isCompleted: habit.isCompleted,
      time: habit.reminderTime,
      reminderTime: habit.reminderTime,
      priority: 'MEDIUM',
      habitData: habit,
    }));

    const taskItems = tasks.map((task) => ({
      id: `task-${task.id}`,
      originalId: task.id,
      itemType: 'TASK' as const,
      title: task.title,
      description: task.description,
      category: task.category || 'General',
      color: task.priority === 'HIGH' ? '#EF4444' : task.priority === 'LOW' ? '#10B981' : '#3B82F6',
      icon: 'CheckSquare',
      isCompleted: task.isCompleted,
      time: task.time,
      reminderTime: task.reminderTime,
      priority: task.priority,
      taskData: task,
    }));

    const allItems = [...habitItems, ...taskItems];

    const habitsTotal = scheduledHabits.length;
    const habitsCompleted = scheduledHabits.filter((h) => h.isCompleted).length;
    const tasksTotal = tasks.length;
    const tasksCompleted = tasks.filter((t) => t.isCompleted).length;

    const totalCount = habitsTotal + tasksTotal;
    const completedCount = habitsCompleted + tasksCompleted;
    const completionPercentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    return res.status(200).json({
      date: targetDate,
      summary: {
        totalCount,
        completedCount,
        completionPercentage,
        habitsTotal,
        habitsCompleted,
        tasksTotal,
        tasksCompleted,
      },
      habits: scheduledHabits,
      tasks,
      allItems,
    });
  } catch (error) {
    console.error('[API] Daily Plan Error:', error);
    return res.status(500).json({ error: 'Failed to fetch daily plan' });
  }
});

// ----------------------------------------------------
// REMINDERS FOR TODAY
// ----------------------------------------------------
app.get('/api/reminders/today', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const targetDate = typeof req.query['date'] === 'string' ? req.query['date'] : getTodayIso();

    // 1. Habits with reminder enabled that are scheduled for today
    const habits = await prisma.habit.findMany({
      where: {
        userId,
        archived: false,
        reminderEnabled: true,
        reminderTime: { not: null },
      },
      include: {
        logs: { where: { date: targetDate } },
      },
    });

    const activeHabitReminders = habits
      .filter((h) => isDateScheduled(targetDate, h.frequencyType, h.frequencyDays))
      .map((h) => ({
        id: `habit-${h.id}`,
        sourceId: h.id,
        sourceType: 'HABIT',
        title: h.title,
        category: h.category,
        color: h.color,
        icon: h.icon,
        reminderTime: h.reminderTime!,
        isCompleted: h.logs[0]?.isCompleted || false,
      }));

    // 2. Tasks for today with reminderTime
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        date: targetDate,
        reminderTime: { not: null },
      },
    });

    const activeTaskReminders = tasks.map((t) => ({
      id: `task-${t.id}`,
      sourceId: t.id,
      sourceType: 'TASK',
      title: t.title,
      category: t.category,
      color: t.priority === 'HIGH' ? '#EF4444' : '#3B82F6',
      icon: 'Bell',
      reminderTime: t.reminderTime!,
      isCompleted: t.isCompleted,
    }));

    const allReminders = [...activeHabitReminders, ...activeTaskReminders].sort((a, b) =>
      a.reminderTime.localeCompare(b.reminderTime)
    );

    return res.status(200).json(allReminders);
  } catch (error) {
    console.error('[API] Reminders Error:', error);
    return res.status(500).json({ error: 'Failed to fetch reminders' });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
});
