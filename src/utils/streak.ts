/**
 * Checks if a given YYYY-MM-DD date is an active scheduled day for a habit.
 */
export function isDateScheduled(
  dateStr: string,
  frequencyType?: string | null,
  frequencyDays?: string | null
): boolean {
  if (!frequencyType || frequencyType === 'DAILY') {
    return true;
  }

  const parts = dateStr.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = dateObj.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  if (frequencyType === 'WEEKDAYS') {
    return dayOfWeek >= 1 && dayOfWeek <= 5;
  }

  if (frequencyType === 'WEEKENDS') {
    return dayOfWeek === 0 || dayOfWeek === 6;
  }

  if (frequencyType === 'CUSTOM_DAYS') {
    if (!frequencyDays) return true;
    const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const currentDayName = dayNames[dayOfWeek] ?? '';
    const activeDays = frequencyDays.toUpperCase().split(',').map((s) => s.trim());
    return activeDays.includes(currentDayName) || activeDays.includes(String(dayOfWeek));
  }

  return true;
}

/**
 * Calculates current streak and best streak taking habit frequency and rest days into account.
 */
export function calculateStreaks(
  completedDates: string[],
  referenceDateStr?: string,
  frequencyType?: string | null,
  frequencyDays?: string | null
): { currentStreak: number; bestStreak: number; lastCompletedDate: string | null } {
  if (!completedDates || completedDates.length === 0) {
    return { currentStreak: 0, bestStreak: 0, lastCompletedDate: null };
  }

  // Deduplicate and sort chronologically (ascending)
  const uniqueSortedDates = Array.from(new Set(completedDates)).sort();
  const lastCompletedDate = uniqueSortedDates[uniqueSortedDates.length - 1] ?? null;
  const completedSet = new Set(uniqueSortedDates);

  // Helper to format Date to YYYY-MM-DD
  const formatUtcDate = (d: Date): string => {
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Helper to shift Date by delta days
  const addDays = (d: Date, delta: number): Date => {
    const next = new Date(d.getTime());
    next.setUTCDate(next.getUTCDate() + delta);
    return next;
  };

  const parseUtcDate = (dStr: string): Date => {
    const parts = dStr.split('-').map(Number);
    const y = parts[0] ?? 1970;
    const m = parts[1] ?? 1;
    const d = parts[2] ?? 1;
    return new Date(Date.UTC(y, m - 1, d));
  };

  // 1. Calculate Best Streak across full history
  let bestStreak = 0;
  if (uniqueSortedDates.length > 0) {
    const firstDateStr = uniqueSortedDates[0]!;
    const lastDateStr = uniqueSortedDates[uniqueSortedDates.length - 1]!;
    let walker = parseUtcDate(firstDateStr);
    const endWalker = parseUtcDate(lastDateStr);

    let runningStreak = 0;
    while (walker.getTime() <= endWalker.getTime()) {
      const curStr = formatUtcDate(walker);
      const scheduled = isDateScheduled(curStr, frequencyType, frequencyDays);
      const isDone = completedSet.has(curStr);

      if (isDone) {
        runningStreak++;
        if (runningStreak > bestStreak) {
          bestStreak = runningStreak;
        }
      } else if (scheduled) {
        // Missed an active scheduled day -> resets running streak
        runningStreak = 0;
      }
      // If not scheduled and not done -> Rest day, runningStreak stays intact!

      walker = addDays(walker, 1);
    }
  }

  // 2. Calculate Current Streak relative to today (or reference date)
  let todayStr = referenceDateStr;
  if (!todayStr) {
    todayStr = formatUtcDate(new Date());
  }

  let currentStreak = 0;
  const todayIsDone = completedSet.has(todayStr);

  let checkDate = parseUtcDate(todayStr);

  if (todayIsDone) {
    // Completed today -> start counting backwards from today
    while (true) {
      const curStr = formatUtcDate(checkDate);
      const isDone = completedSet.has(curStr);
      const scheduled = isDateScheduled(curStr, frequencyType, frequencyDays);

      if (isDone) {
        currentStreak++;
      } else if (scheduled) {
        // Encountered a scheduled day that was missed in the past -> stop
        break;
      }
      // If not scheduled and not done -> Rest day, skip backwards

      checkDate = addDays(checkDate, -1);
      // Safety limit: Don't walk back more than 1000 days
      if (currentStreak > 1000 || checkDate.getUTCFullYear() < 2000) break;
    }
  } else {
    // Not completed today yet.
    // Check if streak is alive from previous scheduled days!
    checkDate = addDays(checkDate, -1);
    let foundFirstScheduled = false;

    while (true) {
      const curStr = formatUtcDate(checkDate);
      const isDone = completedSet.has(curStr);
      const scheduled = isDateScheduled(curStr, frequencyType, frequencyDays);

      if (isDone) {
        foundFirstScheduled = true;
        currentStreak++;
      } else if (scheduled) {
        if (!foundFirstScheduled) {
          // The most recent scheduled day before today was missed -> streak is 0
          currentStreak = 0;
          break;
        } else {
          // Missed an earlier scheduled day -> end of current active streak
          break;
        }
      }
      // If rest day (not scheduled & not done) and we haven't hit a missed scheduled day, keep walking

      checkDate = addDays(checkDate, -1);
      if (currentStreak > 1000 || checkDate.getUTCFullYear() < 2000) break;
    }
  }

  return {
    currentStreak,
    bestStreak: Math.max(bestStreak, currentStreak),
    lastCompletedDate,
  };
}
