import express from 'express';
import type { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3001;

// Middlewares
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// Basic route
app.get('/', (req: Request, res: Response) => {
  res.send('Express + TypeScript Server is running!');
});

app.get('/api/app-name', (req: Request, res: Response) => {
  res.json({ "app-name": "traxx" });
});

// Auth route: Verify Google Token and create session
app.post('/api/auth/google', async (req: Request, res: Response): Promise<any> => {
  console.log('[AUTH] Received login request');
  const { credential } = req.body;
  
  if (!credential) {
    console.error('[AUTH] No credential provided');
    return res.status(400).json({ error: 'Google credential missing' });
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID || '',
    });
    const payload = ticket.getPayload();
    if (!payload) {
      console.error('[AUTH] Verifed token but payload is empty');
      return res.status(400).json({ error: 'Invalid Google payload' });
    }

    const { email, name, picture, sub } = payload;
    console.log(`[AUTH] Successfully identified user: ${email}`);

    // Create a JWT session
    const sessionToken = jwt.sign(
      { userId: sub, email, name, picture },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Set HTTP-only cookie
    res.cookie('auth_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    console.log('[AUTH] Set cookie and returning success');
    return res.status(200).json({ success: true, user: { email, name, picture } });
  } catch (error) {
    console.error('[AUTH] Error verifying Google Token:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Auth route: Check current user session
app.get('/api/auth/me', (req: Request, res: Response): any => {
  console.log('[AUTH] Checking session, cookies received:', req.cookies);
  const token = req.cookies.auth_token;
  if (!token) {
    console.log('[AUTH] No auth_token cookie found');
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    console.log(`[AUTH] Session valid for user: ${(user as any).email}`);
    return res.status(200).json({ user });
  } catch (error) {
    console.error('[AUTH] Session token verification failed:', error);
    return res.status(401).json({ error: 'Invalid session' });
  }
});

// Auth route: Logout
app.post('/api/auth/logout', (req: Request, res: Response): any => {
  res.clearCookie('auth_token');
  return res.status(200).json({ success: true });
});

app.listen(port, () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
});
