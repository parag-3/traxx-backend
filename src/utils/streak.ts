/**
 * Calculates current streak and best streak from an array of completed ISO date strings (YYYY-MM-DD).
 */
export function calculateStreaks(
  completedDates: string[],
  referenceDateStr?: string
): { currentStreak: number; bestStreak: number; lastCompletedDate: string | null } {
  if (!completedDates || completedDates.length === 0) {
    return { currentStreak: 0, bestStreak: 0, lastCompletedDate: null };
  }

  // Deduplicate and sort chronologically (ascending)
  const uniqueSortedDates = Array.from(new Set(completedDates)).sort();
  const lastCompletedDate = uniqueSortedDates[uniqueSortedDates.length - 1] ?? null;

  // Helper to get day difference between two YYYY-MM-DD dates
  const getDayDiff = (d1: string, d2: string): number => {
    const parts1 = d1.split('-').map(Number);
    const parts2 = d2.split('-').map(Number);
    const y1 = parts1[0] ?? 1970;
    const m1 = parts1[1] ?? 1;
    const day1 = parts1[2] ?? 1;
    const y2 = parts2[0] ?? 1970;
    const m2 = parts2[1] ?? 1;
    const day2 = parts2[2] ?? 1;

    const utc1 = Date.UTC(y1, m1 - 1, day1);
    const utc2 = Date.UTC(y2, m2 - 1, day2);
    const msPerDay = 1000 * 60 * 60 * 24;
    return Math.round((utc2 - utc1) / msPerDay);
  };

  // Helper to format Date to YYYY-MM-DD
  const formatUtcDate = (d: Date): string => {
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // 1. Calculate Best Streak across full history
  let bestStreak = 0;
  let runningStreak = 0;

  for (let i = 0; i < uniqueSortedDates.length; i++) {
    const curr = uniqueSortedDates[i];
    if (!curr) continue;

    if (i === 0) {
      runningStreak = 1;
    } else {
      const prev = uniqueSortedDates[i - 1];
      if (prev) {
        const diff = getDayDiff(prev, curr);
        if (diff === 1) {
          runningStreak++;
        } else if (diff > 1) {
          runningStreak = 1;
        }
      }
    }
    if (runningStreak > bestStreak) {
      bestStreak = runningStreak;
    }
  }

  // 2. Calculate Current Streak relative to today (or reference date)
  let todayStr = referenceDateStr;
  if (!todayStr) {
    const now = new Date();
    todayStr = formatUtcDate(now);
  }

  const yesterdayDate = new Date();
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterdayStr = formatUtcDate(yesterdayDate);

  const dateSet = new Set(uniqueSortedDates);

  let currentStreak = 0;
  let checkDate: Date;

  if (dateSet.has(todayStr)) {
    // Completed today -> walk backwards from today
    const parts = todayStr.split('-').map(Number);
    const y = parts[0] ?? 1970;
    const m = parts[1] ?? 1;
    const d = parts[2] ?? 1;
    checkDate = new Date(Date.UTC(y, m - 1, d));

    while (dateSet.has(formatUtcDate(checkDate))) {
      currentStreak++;
      checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    }
  } else if (lastCompletedDate && (dateSet.has(yesterdayStr) || dateSet.has(lastCompletedDate))) {
    // If not completed today, check if yesterday was completed
    const diffFromToday = getDayDiff(lastCompletedDate, todayStr);
    if (diffFromToday === 1) {
      // Completed yesterday -> active streak preserved!
      const parts = lastCompletedDate.split('-').map(Number);
      const y = parts[0] ?? 1970;
      const m = parts[1] ?? 1;
      const d = parts[2] ?? 1;
      checkDate = new Date(Date.UTC(y, m - 1, d));

      while (dateSet.has(formatUtcDate(checkDate))) {
        currentStreak++;
        checkDate.setUTCDate(checkDate.getUTCDate() - 1);
      }
    } else {
      currentStreak = 0;
    }
  } else {
    currentStreak = 0;
  }

  return {
    currentStreak,
    bestStreak,
    lastCompletedDate,
  };
}
