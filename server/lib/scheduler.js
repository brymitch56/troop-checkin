'use strict';
// In-process job scheduler — the cross-platform replacement for systemd
// timers, so nightly/weekly jobs behave identically on the Pi, on Windows,
// and in Docker. Plain setTimeout + date math, no dependencies.
//
// DST-safe by construction: instead of a fixed setInterval, each run
// recomputes the NEXT wall-clock occurrence with local-time Date math and
// arms a fresh one-shot timer, so "03:15 local" stays 03:15 across
// spring-forward/fall-back. All timers are unref()'d — they never keep the
// process alive (tests, `node -e` one-offs).
//
// What stays with the OS: "start the app at boot" (systemd on the Pi, Task
// Scheduler on Windows, restart:unless-stopped in Docker). What moves here:
// everything that used to be a *timer*.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Next occurrence of hh:mm local time strictly after `from`.
function nextDaily(from, hh, mm) {
  const next = new Date(from);
  next.setHours(hh, mm, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

// Next occurrence of `dow` (0=Sun..6=Sat) at hh:mm local, strictly after `from`.
function nextWeekly(from, dow, hh, mm) {
  const next = new Date(from);
  next.setHours(hh, mm, 0, 0);
  let ahead = (dow - next.getDay() + 7) % 7;
  if (ahead === 0 && next <= from) ahead = 7;
  next.setDate(next.getDate() + ahead);
  return next;
}

// Arm a self-rechaining one-shot timer. `computeNext(now) -> Date`.
// `jitterMs` adds a random 0..jitterMs delay per fire (spreads load across
// self-hosted instances, mirroring systemd's RandomizedDelaySec).
function chain(name, computeNext, fn, jitterMs = 0) {
  const arm = () => {
    const now = new Date();
    const at = computeNext(now);
    const delay = Math.max(0, at - now) + (jitterMs ? Math.floor(Math.random() * jitterMs) : 0);
    const t = setTimeout(() => {
      try {
        const r = fn();
        if (r && typeof r.catch === 'function') r.catch((e) => console.error(`${name} failed:`, e.message));
      } catch (e) {
        console.error(`${name} failed:`, e.message);
      }
      arm();
    }, delay);
    t.unref();
    return t;
  };
  return arm();
}

function scheduleDaily(name, hh, mm, fn, jitterMs = 0) {
  return chain(name, (now) => nextDaily(now, hh, mm), fn, jitterMs);
}

function scheduleWeekly(name, dow, hh, mm, fn, jitterMs = 0) {
  return chain(name, (now) => nextWeekly(now, dow, hh, mm), fn, jitterMs);
}

module.exports = { nextDaily, nextWeekly, scheduleDaily, scheduleWeekly, DAY_NAMES };
