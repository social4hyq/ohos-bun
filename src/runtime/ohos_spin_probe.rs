//! TEMPORARY DIAGNOSTIC — not for upstreaming.
//!
//! Counts which of the three `has_pending_immediate` conditions forces a
//! non-blocking poll, so we can find what keeps claude-code's event loop
//! spinning at ~100% CPU while idle. Everything else about that spin is
//! invisible from outside the process: `epoll_pwait2` is issued as raw
//! inline `svc #0` (no libc symbol to interpose), and the JS-visible
//! schedulers were measured at only ~33/s -- three orders of magnitude
//! below the observed tick rate.
//!
//! Output goes to stderr every ~2s, but only while OHOS_SPIN_PROBE=1.

use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static TICKS: AtomicU64 = AtomicU64::new(0);
static YIELDED: AtomicU64 = AtomicU64::new(0);
static IMMEDIATES: AtomicU64 = AtomicU64::new(0);
static PENDING: AtomicU64 = AtomicU64::new(0);
static PENDING_ONLY: AtomicU64 = AtomicU64::new(0);
static BLOCKING: AtomicU64 = AtomicU64::new(0);
static TASKS_LEN_SUM: AtomicU64 = AtomicU64::new(0);
static TASKS_LEN_MAX: AtomicU64 = AtomicU64::new(0);
static CONCURRENT_NONEMPTY: AtomicU64 = AtomicU64::new(0);
static LAST_REPORT_MS: AtomicU64 = AtomicU64::new(0);
static ENABLED: AtomicBool = AtomicBool::new(false);
static ENABLED_INIT: AtomicBool = AtomicBool::new(false);

fn enabled() -> bool {
    if !ENABLED_INIT.load(Ordering::Relaxed) {
        let on = std::env::var("OHOS_SPIN_PROBE").map(|v| v == "1").unwrap_or(false);
        ENABLED.store(on, Ordering::Relaxed);
        ENABLED_INIT.store(true, Ordering::Relaxed);
    }
    ENABLED.load(Ordering::Relaxed)
}

fn now_ms() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: writing into a local timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    (ts.tv_sec as u64) * 1000 + (ts.tv_nsec as u64) / 1_000_000
}

pub fn record(
    yielded: bool,
    immediates: bool,
    pending: bool,
    tasks_len: usize,
    concurrent_empty: bool,
) {
    if !enabled() {
        return;
    }
    TICKS.fetch_add(1, Ordering::Relaxed);
    if yielded {
        YIELDED.fetch_add(1, Ordering::Relaxed);
    }
    if immediates {
        IMMEDIATES.fetch_add(1, Ordering::Relaxed);
    }
    if pending {
        PENDING.fetch_add(1, Ordering::Relaxed);
        if !yielded && !immediates {
            PENDING_ONLY.fetch_add(1, Ordering::Relaxed);
        }
    }
    if !yielded && !immediates && !pending {
        BLOCKING.fetch_add(1, Ordering::Relaxed);
    }
    if !concurrent_empty {
        CONCURRENT_NONEMPTY.fetch_add(1, Ordering::Relaxed);
    }
    TASKS_LEN_SUM.fetch_add(tasks_len as u64, Ordering::Relaxed);
    TASKS_LEN_MAX.fetch_max(tasks_len as u64, Ordering::Relaxed);

    let now = now_ms();
    let last = LAST_REPORT_MS.load(Ordering::Relaxed);
    if last == 0 {
        LAST_REPORT_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now.saturating_sub(last) < 2000 {
        return;
    }
    if LAST_REPORT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let secs = (now - last) as f64 / 1000.0;
    let t = TICKS.swap(0, Ordering::Relaxed);
    let y = YIELDED.swap(0, Ordering::Relaxed);
    let i = IMMEDIATES.swap(0, Ordering::Relaxed);
    let p = PENDING.swap(0, Ordering::Relaxed);
    let po = PENDING_ONLY.swap(0, Ordering::Relaxed);
    let b = BLOCKING.swap(0, Ordering::Relaxed);
    let cn = CONCURRENT_NONEMPTY.swap(0, Ordering::Relaxed);
    let sum = TASKS_LEN_SUM.swap(0, Ordering::Relaxed);
    let mx = TASKS_LEN_MAX.swap(0, Ordering::Relaxed);
    let avg = if t > 0 { sum as f64 / t as f64 } else { 0.0 };
    eprintln!(
        "[spin-probe] {:.1}s ticks={} ({:.0}/s) yielded={} immediates={} pending={} pending_only={} blocking={} concurrent_nonempty={} tasks_len avg={:.2} max={}",
        secs, t, t as f64 / secs, y, i, p, po, b, cn, avg, mx
    );
}
