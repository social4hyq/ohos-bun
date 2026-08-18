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

// Ready-poll fd histogram (see record_ready_polls below). Fixed-size table,
// no heap allocation on this hot path -- linear scan is fine at this size.
const FD_TABLE_SIZE: usize = 64;
static FD_SLOTS: [AtomicU64; FD_TABLE_SIZE] = {
    const ZERO: AtomicU64 = AtomicU64::new(0);
    [ZERO; FD_TABLE_SIZE]
};
static FD_COUNTS: [AtomicU64; FD_TABLE_SIZE] = {
    const ZERO: AtomicU64 = AtomicU64::new(0);
    [ZERO; FD_TABLE_SIZE]
};
static FD_OTHER_COUNT: AtomicU64 = AtomicU64::new(0); // overflow beyond the 64-slot table
static RP_CALLS: AtomicU64 = AtomicU64::new(0);
static RP_ZERO_N: AtomicU64 = AtomicU64::new(0); // calls with n==0 (genuinely nothing ready)
static RP_N_SUM: AtomicU64 = AtomicU64::new(0);
static RP_N_MAX: AtomicU64 = AtomicU64::new(0);
static LAST_RP_REPORT_MS: AtomicU64 = AtomicU64::new(0);

/// # Safety
/// `fds`/`events` must be valid for `n` reads (or null if `n == 0`), called
/// from the single event-loop thread owning `loop` -- no concurrent access.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ohos_spin_probe_record_ready_polls(n: i32, fds: *const i32, events: *const i32) {
    if !enabled() {
        return;
    }
    RP_CALLS.fetch_add(1, Ordering::Relaxed);
    if n <= 0 {
        RP_ZERO_N.fetch_add(1, Ordering::Relaxed);
    } else {
        RP_N_SUM.fetch_add(n as u64, Ordering::Relaxed);
        RP_N_MAX.fetch_max(n as u64, Ordering::Relaxed);
        if !fds.is_null() {
            for i in 0..n as isize {
                // SAFETY: caller contract.
                let fd = unsafe { *fds.offset(i) };
                let _ev = if events.is_null() { 0 } else { unsafe { *events.offset(i) } };
                if fd < 0 {
                    continue;
                }
                let fd_u = fd as u64;
                let mut placed = false;
                for slot in 0..FD_TABLE_SIZE {
                    let cur = FD_SLOTS[slot].load(Ordering::Relaxed);
                    if cur == fd_u {
                        FD_COUNTS[slot].fetch_add(1, Ordering::Relaxed);
                        placed = true;
                        break;
                    }
                    if cur == 0 {
                        // Claim this slot (racy across threads, but this loop
                        // is single-threaded per-loop in practice; worst case
                        // a slot gets double-claimed and one fd undercounts).
                        if FD_SLOTS[slot]
                            .compare_exchange(0, fd_u, Ordering::Relaxed, Ordering::Relaxed)
                            .is_ok()
                        {
                            FD_COUNTS[slot].fetch_add(1, Ordering::Relaxed);
                            placed = true;
                            break;
                        }
                    }
                }
                if !placed {
                    FD_OTHER_COUNT.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    let now = now_ms();
    let last = LAST_RP_REPORT_MS.load(Ordering::Relaxed);
    if last == 0 {
        LAST_RP_REPORT_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now.saturating_sub(last) < 2000 {
        return;
    }
    if LAST_RP_REPORT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let calls = RP_CALLS.swap(0, Ordering::Relaxed);
    let zero_n = RP_ZERO_N.swap(0, Ordering::Relaxed);
    let n_sum = RP_N_SUM.swap(0, Ordering::Relaxed);
    let n_max = RP_N_MAX.swap(0, Ordering::Relaxed);
    let mut pairs: [(u64, u64); FD_TABLE_SIZE] = [(0, 0); FD_TABLE_SIZE];
    for slot in 0..FD_TABLE_SIZE {
        let fdv = FD_SLOTS[slot].swap(0, Ordering::Relaxed);
        let cnt = FD_COUNTS[slot].swap(0, Ordering::Relaxed);
        pairs[slot] = (fdv, cnt);
    }
    pairs.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    let other = FD_OTHER_COUNT.swap(0, Ordering::Relaxed);
    let avg_n = if calls > 0 { n_sum as f64 / calls as f64 } else { 0.0 };
    let mut top = String::new();
    for &(fdv, cnt) in pairs.iter().take(8) {
        if cnt == 0 {
            break;
        }
        top.push_str(&format!("fd{}={} ", fdv, cnt));
    }
    let line = format!(
        "[spin-fds] calls={} zero_n={} avg_n={:.2} max_n={} other_overflow={} top: {}\n",
        calls, zero_n, avg_n, n_max, other, top
    );
    write_line(&line);
}

// Legacy epoll_pwait return-value histogram (see record_epoll below).
static EP_CALLS: AtomicU64 = AtomicU64::new(0);
static EP_ZERO_EVENTS: AtomicU64 = AtomicU64::new(0); // ret == 0 (genuine timeout, no events)
static EP_HAS_EVENTS: AtomicU64 = AtomicU64::new(0); // ret > 0 (real ready fds reported)
static EP_ERROR: AtomicU64 = AtomicU64::new(0); // ret < 0
static EP_ELAPSED_SUB_MS: AtomicU64 = AtomicU64::new(0); // returned in <1ms regardless of requested timeout
static EP_ELAPSED_SUM_NS: AtomicU64 = AtomicU64::new(0);
static EP_REQ_TIMEOUT_SUM_MS: AtomicU64 = AtomicU64::new(0);
static LAST_EP_REPORT_MS: AtomicU64 = AtomicU64::new(0);

#[unsafe(no_mangle)]
pub extern "C" fn ohos_spin_probe_record_epoll(timeout_ms: i32, ret: i32, elapsed_ns: i64) {
    if !enabled() {
        return;
    }
    EP_CALLS.fetch_add(1, Ordering::Relaxed);
    if ret == 0 {
        EP_ZERO_EVENTS.fetch_add(1, Ordering::Relaxed);
    } else if ret > 0 {
        EP_HAS_EVENTS.fetch_add(1, Ordering::Relaxed);
    } else {
        EP_ERROR.fetch_add(1, Ordering::Relaxed);
    }
    let elapsed_ns_u = elapsed_ns.max(0) as u64;
    if elapsed_ns_u < 1_000_000 {
        EP_ELAPSED_SUB_MS.fetch_add(1, Ordering::Relaxed);
    }
    EP_ELAPSED_SUM_NS.fetch_add(elapsed_ns_u, Ordering::Relaxed);
    if timeout_ms > 0 {
        EP_REQ_TIMEOUT_SUM_MS.fetch_add(timeout_ms as u64, Ordering::Relaxed);
    }

    let now = now_ms();
    let last = LAST_EP_REPORT_MS.load(Ordering::Relaxed);
    if last == 0 {
        LAST_EP_REPORT_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now.saturating_sub(last) < 2000 {
        return;
    }
    if LAST_EP_REPORT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let calls = EP_CALLS.swap(0, Ordering::Relaxed);
    let zero = EP_ZERO_EVENTS.swap(0, Ordering::Relaxed);
    let has = EP_HAS_EVENTS.swap(0, Ordering::Relaxed);
    let err = EP_ERROR.swap(0, Ordering::Relaxed);
    let submsc = EP_ELAPSED_SUB_MS.swap(0, Ordering::Relaxed);
    let elapsed_sum = EP_ELAPSED_SUM_NS.swap(0, Ordering::Relaxed);
    let req_sum_ms = EP_REQ_TIMEOUT_SUM_MS.swap(0, Ordering::Relaxed);
    let avg_elapsed_ns = if calls > 0 { elapsed_sum as f64 / calls as f64 } else { 0.0 };
    let avg_req_ms = if calls > 0 { req_sum_ms as f64 / calls as f64 } else { 0.0 };
    let line = format!(
        "[spin-epoll] calls={} zero_events={} has_events={} error={} elapsed_sub_ms={} avg_elapsed_ns={:.0} avg_requested_ms={:.1}\n",
        calls, zero, has, err, submsc, avg_elapsed_ns, avg_req_ms
    );
    write_line(&line);
}

// Timeout-value histogram (see record_timeout below).
static TO_CALLS: AtomicU64 = AtomicU64::new(0);
static TO_NO_TIMEOUT: AtomicU64 = AtomicU64::new(0); // have_timeout == false (infinite wait armed)
static TO_ZERO: AtomicU64 = AtomicU64::new(0); // exactly 0
static TO_SUB_MS: AtomicU64 = AtomicU64::new(0); // >0 and <1ms
static TO_1_10MS: AtomicU64 = AtomicU64::new(0);
static TO_OVER_10MS: AtomicU64 = AtomicU64::new(0);
static TO_MIN_NS: AtomicU64 = AtomicU64::new(u64::MAX);
static TO_SUM_NS: AtomicU64 = AtomicU64::new(0);
static LAST_TO_REPORT_MS: AtomicU64 = AtomicU64::new(0);

pub fn record_timeout(have_timeout: bool, sec: i64, nsec: i64) {
    if !enabled() {
        return;
    }
    TO_CALLS.fetch_add(1, Ordering::Relaxed);
    if !have_timeout {
        TO_NO_TIMEOUT.fetch_add(1, Ordering::Relaxed);
    } else {
        let ns: u64 = (sec.max(0) as u64).saturating_mul(1_000_000_000).saturating_add(nsec.max(0) as u64);
        if ns == 0 {
            TO_ZERO.fetch_add(1, Ordering::Relaxed);
        } else if ns < 1_000_000 {
            TO_SUB_MS.fetch_add(1, Ordering::Relaxed);
        } else if ns <= 10_000_000 {
            TO_1_10MS.fetch_add(1, Ordering::Relaxed);
        } else {
            TO_OVER_10MS.fetch_add(1, Ordering::Relaxed);
        }
        TO_MIN_NS.fetch_min(ns, Ordering::Relaxed);
        TO_SUM_NS.fetch_add(ns, Ordering::Relaxed);
    }

    let now = now_ms();
    let last = LAST_TO_REPORT_MS.load(Ordering::Relaxed);
    if last == 0 {
        LAST_TO_REPORT_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now.saturating_sub(last) < 2000 {
        return;
    }
    if LAST_TO_REPORT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let calls = TO_CALLS.swap(0, Ordering::Relaxed);
    let none = TO_NO_TIMEOUT.swap(0, Ordering::Relaxed);
    let zero = TO_ZERO.swap(0, Ordering::Relaxed);
    let submsc = TO_SUB_MS.swap(0, Ordering::Relaxed);
    let m10 = TO_1_10MS.swap(0, Ordering::Relaxed);
    let over10 = TO_OVER_10MS.swap(0, Ordering::Relaxed);
    let minns = TO_MIN_NS.swap(u64::MAX, Ordering::Relaxed);
    let sumns = TO_SUM_NS.swap(0, Ordering::Relaxed);
    let with_timeout = calls.saturating_sub(none);
    let avg_ns = if with_timeout > 0 { sumns as f64 / with_timeout as f64 } else { 0.0 };
    let min_display: i64 = if minns == u64::MAX { -1 } else { minns as i64 };
    let line = format!(
        "[spin-timeout] calls={} no_timeout={} zero={} sub_ms={} 1to10ms={} over10ms={} min_ns={} avg_ns={:.0}\n",
        calls, none, zero, submsc, m10, over10, min_display, avg_ns
    );
    write_line(&line);
}

// on_poll branch histogram (see record_onpoll below) -- which fd hits the
// PosixPipeWriter trait-default on_poll, and whether it takes the
// force-unregister-on-empty-buffer branch (the ca2bb787e9 HongMeng fix) or
// falls through to the normal write-attempt path.
static OP_CALLS: AtomicU64 = AtomicU64::new(0);
static OP_EMPTY_UNREGISTERED: AtomicU64 = AtomicU64::new(0); // buf_len==0 && !hup -> force unregister taken
static OP_EMPTY_BUT_HUP: AtomicU64 = AtomicU64::new(0); // buf_len==0 && hup -> falls through instead
static OP_NONEMPTY: AtomicU64 = AtomicU64::new(0); // buf_len>0 -> falls through (real data)
static OP_EMPTY_NOT_POLL_HANDLE: AtomicU64 = AtomicU64::new(0); // empty+no hup but handle() wasn't PollOrFd::Poll -- unregister() SKIPPED entirely
static OP_UNREGISTER_ERR: AtomicU64 = AtomicU64::new(0); // handle() was Poll but poll.unregister() itself returned Err
static OP_LAST_FD: AtomicU64 = AtomicU64::new(u64::MAX);
static OP_LAST_FD_SAME_COUNT: AtomicU64 = AtomicU64::new(0);
static OP_DISTINCT_FD_SWITCHES: AtomicU64 = AtomicU64::new(0);
static LAST_OP_REPORT_MS: AtomicU64 = AtomicU64::new(0);

/// `handle_outcome`: 0 = fell through (nonempty or hup); 1 = empty+no-hup,
/// handle() was PollOrFd::Poll, unregister() returned Ok; 2 = same but
/// unregister() returned Err; 3 = empty+no-hup but handle() was NOT
/// PollOrFd::Poll (unregister() never even attempted).
///
/// `extern "C"` + `#[unsafe(no_mangle)]`: called cross-crate from `bun_io`'s
/// `PipeWriter.rs`, which cannot depend on this crate (`bun_runtime`).
#[unsafe(no_mangle)]
pub extern "C" fn ohos_spin_probe_record_onpoll(fd: i32, buf_len: usize, received_hup: bool, handle_outcome: i32) {
    if !enabled() {
        return;
    }
    OP_CALLS.fetch_add(1, Ordering::Relaxed);
    if buf_len == 0 {
        if received_hup {
            OP_EMPTY_BUT_HUP.fetch_add(1, Ordering::Relaxed);
        } else {
            OP_EMPTY_UNREGISTERED.fetch_add(1, Ordering::Relaxed);
            match handle_outcome {
                2 => {
                    OP_UNREGISTER_ERR.fetch_add(1, Ordering::Relaxed);
                }
                3 => {
                    OP_EMPTY_NOT_POLL_HANDLE.fetch_add(1, Ordering::Relaxed);
                }
                _ => {}
            }
        }
    } else {
        OP_NONEMPTY.fetch_add(1, Ordering::Relaxed);
    }
    let fd_u = fd.max(-1) as i64 as u64;
    let prev = OP_LAST_FD.swap(fd_u, Ordering::Relaxed);
    if prev == fd_u {
        OP_LAST_FD_SAME_COUNT.fetch_add(1, Ordering::Relaxed);
    } else if prev != u64::MAX {
        OP_DISTINCT_FD_SWITCHES.fetch_add(1, Ordering::Relaxed);
    }

    let now = now_ms();
    let last = LAST_OP_REPORT_MS.load(Ordering::Relaxed);
    if last == 0 {
        LAST_OP_REPORT_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now.saturating_sub(last) < 2000 {
        return;
    }
    if LAST_OP_REPORT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let calls = OP_CALLS.swap(0, Ordering::Relaxed);
    let unreg = OP_EMPTY_UNREGISTERED.swap(0, Ordering::Relaxed);
    let empty_hup = OP_EMPTY_BUT_HUP.swap(0, Ordering::Relaxed);
    let nonempty = OP_NONEMPTY.swap(0, Ordering::Relaxed);
    let not_poll = OP_EMPTY_NOT_POLL_HANDLE.swap(0, Ordering::Relaxed);
    let unreg_err = OP_UNREGISTER_ERR.swap(0, Ordering::Relaxed);
    let same = OP_LAST_FD_SAME_COUNT.swap(0, Ordering::Relaxed);
    let switches = OP_DISTINCT_FD_SWITCHES.swap(0, Ordering::Relaxed);
    let line = format!(
        "[spin-onpoll] calls={} empty_unregistered={} empty_but_hup={} nonempty={} empty_not_poll_handle={} unregister_err={} last_fd={} same_fd_streak={} fd_switches={}\n",
        calls, unreg, empty_hup, nonempty, not_poll, unreg_err, fd, same, switches
    );
    write_line(&line);
}

// unregister_with_fd_impl branch histogram -- which of the three early-return
// paths (or the real epoll_ctl syscall) actually fires for the fd11 storm.
// `branch`: 1 = top no-op (no Poll* flags set at all, syscall never
// attempted); 2 = flag-resolution fallthrough (should be unreachable); 3 =
// NeedsRearm-skip (should never fire since on_poll always passes force=true);
// 4 = real epoll_ctl(CTL_DEL) issued -- `extra` carries its raw return value.
static UB_CALLS: AtomicU64 = AtomicU64::new(0);
static UB_NOOP_NO_FLAGS: AtomicU64 = AtomicU64::new(0);
static UB_FLAG_FALLTHROUGH: AtomicU64 = AtomicU64::new(0);
static UB_NEEDSREARM_SKIP: AtomicU64 = AtomicU64::new(0);
static UB_SYSCALL_OK: AtomicU64 = AtomicU64::new(0);
static UB_SYSCALL_ALREADY_GONE: AtomicU64 = AtomicU64::new(0);
static UB_SYSCALL_ERR: AtomicU64 = AtomicU64::new(0);
static LAST_UB_REPORT_MS: AtomicU64 = AtomicU64::new(0);

#[unsafe(no_mangle)]
pub extern "C" fn ohos_spin_probe_record_unregister_branch(branch: i32, extra: i32) {
    if !enabled() {
        return;
    }
    UB_CALLS.fetch_add(1, Ordering::Relaxed);
    match branch {
        1 => {
            UB_NOOP_NO_FLAGS.fetch_add(1, Ordering::Relaxed);
        }
        2 => {
            UB_FLAG_FALLTHROUGH.fetch_add(1, Ordering::Relaxed);
        }
        3 => {
            UB_NEEDSREARM_SKIP.fetch_add(1, Ordering::Relaxed);
        }
        4 => {
            if extra == 0 {
                UB_SYSCALL_OK.fetch_add(1, Ordering::Relaxed);
            } else if extra == -2 {
                UB_SYSCALL_ALREADY_GONE.fetch_add(1, Ordering::Relaxed);
            } else {
                UB_SYSCALL_ERR.fetch_add(1, Ordering::Relaxed);
            }
        }
        _ => {}
    }

    let now = now_ms();
    let last = LAST_UB_REPORT_MS.load(Ordering::Relaxed);
    if last == 0 {
        LAST_UB_REPORT_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now.saturating_sub(last) < 2000 {
        return;
    }
    if LAST_UB_REPORT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let calls = UB_CALLS.swap(0, Ordering::Relaxed);
    let noop = UB_NOOP_NO_FLAGS.swap(0, Ordering::Relaxed);
    let fallthrough = UB_FLAG_FALLTHROUGH.swap(0, Ordering::Relaxed);
    let rearm_skip = UB_NEEDSREARM_SKIP.swap(0, Ordering::Relaxed);
    let sys_ok = UB_SYSCALL_OK.swap(0, Ordering::Relaxed);
    let sys_gone = UB_SYSCALL_ALREADY_GONE.swap(0, Ordering::Relaxed);
    let sys_err = UB_SYSCALL_ERR.swap(0, Ordering::Relaxed);
    let line = format!(
        "[spin-unreg] calls={} noop_no_flags={} flag_fallthrough={} needsrearm_skip={} syscall_ok={} syscall_already_gone={} syscall_err={}\n",
        calls, noop, fallthrough, rearm_skip, sys_ok, sys_gone, sys_err
    );
    write_line(&line);
}

// Dispatch-time flag snapshot: was PollWritable still set on the FilePoll
// *before* on_epoll_event() mutates anything, at the exact moment the ready
// entry comes back out of epoll_pwait's buffer? Answers whether the kernel
// is still delivering events for an fd bun's own bookkeeping already thinks
// is unregistered (real kernel bug), or something re-armed it every tick
// (application-level re-register loop).
static DF_CALLS: AtomicU64 = AtomicU64::new(0);
static DF_WRITABLE_SET: AtomicU64 = AtomicU64::new(0); // PollWritable was still set at dispatch time
static DF_WRITABLE_CLEAR: AtomicU64 = AtomicU64::new(0); // already cleared -- kernel re-delivered anyway
static DF_ONESHOT_SET: AtomicU64 = AtomicU64::new(0);
static DF_NEEDSREARM_SET: AtomicU64 = AtomicU64::new(0);
static LAST_DF_REPORT_MS: AtomicU64 = AtomicU64::new(0);

#[unsafe(no_mangle)]
pub extern "C" fn ohos_spin_probe_record_dispatch_flags(
    fd: i32,
    poll_writable: bool,
    one_shot: bool,
    needs_rearm: bool,
) {
    if !enabled() {
        return;
    }
    DF_CALLS.fetch_add(1, Ordering::Relaxed);
    if poll_writable {
        DF_WRITABLE_SET.fetch_add(1, Ordering::Relaxed);
    } else {
        DF_WRITABLE_CLEAR.fetch_add(1, Ordering::Relaxed);
    }
    if one_shot {
        DF_ONESHOT_SET.fetch_add(1, Ordering::Relaxed);
    }
    if needs_rearm {
        DF_NEEDSREARM_SET.fetch_add(1, Ordering::Relaxed);
    }

    let now = now_ms();
    let last = LAST_DF_REPORT_MS.load(Ordering::Relaxed);
    if last == 0 {
        LAST_DF_REPORT_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now.saturating_sub(last) < 2000 {
        return;
    }
    if LAST_DF_REPORT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let calls = DF_CALLS.swap(0, Ordering::Relaxed);
    let wset = DF_WRITABLE_SET.swap(0, Ordering::Relaxed);
    let wclear = DF_WRITABLE_CLEAR.swap(0, Ordering::Relaxed);
    let oneshot = DF_ONESHOT_SET.swap(0, Ordering::Relaxed);
    let rearm = DF_NEEDSREARM_SET.swap(0, Ordering::Relaxed);
    let line = format!(
        "[spin-dispatch] calls={} last_fd={} writable_set={} writable_clear={} oneshot_set={} needsrearm_set={}\n",
        calls, fd, wset, wclear, oneshot, rearm
    );
    write_line(&line);
}

// register_with_fd_impl entry counter: is anything calling epoll_ctl(ADD/MOD)
// for fd11 at a high rate (an application-level re-register loop), or is
// register basically never called again after the first registration
// (pointing at the kernel re-delivering a stale/deleted registration)?
static REG_CALLS: AtomicU64 = AtomicU64::new(0);
static REG_ADD: AtomicU64 = AtomicU64::new(0);
static REG_MOD: AtomicU64 = AtomicU64::new(0);
static LAST_REG_REPORT_MS: AtomicU64 = AtomicU64::new(0);

#[unsafe(no_mangle)]
pub extern "C" fn ohos_spin_probe_record_register(fd: i32, is_mod: bool) {
    if !enabled() {
        return;
    }
    REG_CALLS.fetch_add(1, Ordering::Relaxed);
    if is_mod {
        REG_MOD.fetch_add(1, Ordering::Relaxed);
    } else {
        REG_ADD.fetch_add(1, Ordering::Relaxed);
    }

    let now = now_ms();
    let last = LAST_REG_REPORT_MS.load(Ordering::Relaxed);
    if last == 0 {
        LAST_REG_REPORT_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now.saturating_sub(last) < 2000 {
        return;
    }
    if LAST_REG_REPORT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let calls = REG_CALLS.swap(0, Ordering::Relaxed);
    let add = REG_ADD.swap(0, Ordering::Relaxed);
    let modc = REG_MOD.swap(0, Ordering::Relaxed);
    let line = format!("[spin-register] calls={} add={} mod={} last_fd={}\n", calls, add, modc, fd);
    write_line(&line);
}

fn write_line(line: &str) {
    use std::os::unix::io::FromRawFd;
    unsafe {
        let path = c"/data/storage/el2/base/tmp/ohos-spin-probe.log";
        let fd = libc::open(
            path.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
            0o644,
        );
        if fd >= 0 {
            let mut f = std::fs::File::from_raw_fd(fd);
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
            std::mem::forget(f);
        }
    }
}

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
    let line = format!(
        "[spin-probe] {:.1}s ticks={} ({:.0}/s) yielded={} immediates={} pending={} pending_only={} blocking={} concurrent_nonempty={} tasks_len avg={:.2} max={}\n",
        secs, t, t as f64 / secs, y, i, p, po, b, cn, avg, mx
    );
    write_line(&line);
}
