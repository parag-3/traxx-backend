import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { prisma } from './lib/prisma.js';
import { calculateStreaks } from './utils/streak.js';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Middlewares
app.use(cors({
  origin: 'http://localhost:3000',
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
  res.send('Traxx Habit Tracker API is running!');
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

    res.cookie('auth_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
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
  res.clearCookie('auth_token');
  return res.status(200).json({ success: true });
});

// ----------------------------------------------------
// HABIT CRUD ROUTES
// ----------------------------------------------------

// List all habits with today's log & 7-day mini overview
app.get('/api/habits', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const targetDate = typeof req.query['date'] === 'string' ? req.query['date'] : getTodayIso();

    // Calculate dates for past 7 days
    const past7Days: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
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
      
      // Map past 7 days logs
      const history7Days = past7Days.map((dateStr) => {
        const log = habit.logs.find((l) => l.date === dateStr);
        let color: string | null = null;
        if (log && habit.type === 'STATUS' && log.statusValue) {
          const opt = habit.statusOptions.find((o) => o.value === log.statusValue);
          color = opt ? opt.color : null;
        }
        return {
          date: dateStr,
          isCompleted: log?.isCompleted || false,
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

// Create a new Habit (Numerical or Custom Status)
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
// DAILY LOG CHECK-IN & STREAK RECALCULATION
// ----------------------------------------------------
app.post('/api/habits/:id/log', requireAuth, async (req: AuthRequest, res: Response): Promise<any> => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = getParamStr(req.params['id']);
    if (!id) return res.status(400).json({ error: 'Habit ID required' });

    const { date = getTodayIso(), numericValue, statusValue, notes } = req.body;

    const habit = await prisma.habit.findFirst({
      where: { id, userId },
      include: { statusOptions: true },
    });

    if (!habit) {
      return res.status(404).json({ error: 'Habit not found' });
    }

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
    const log = await prisma.habitLog.upsert({
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

    // Recalculate Streaks for this habit
    const allCompletedLogs = await prisma.habitLog.findMany({
      where: {
        habitId: id,
        isCompleted: true,
      },
      select: { date: true },
      orderBy: { date: 'asc' },
    });

    const completedDates = allCompletedLogs.map((l) => l.date);
    const { currentStreak, bestStreak, lastCompletedDate } = calculateStreaks(completedDates);

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

// Start Server
app.listen(port, () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
});
