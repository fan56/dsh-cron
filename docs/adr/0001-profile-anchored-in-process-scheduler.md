# Profile-anchored, in-process scheduler

dsh has no native cron (official `dsh-schedule` is session-scoped reminders only, and the protocol explicitly excludes cron expressions). We decided dsh-cron v1 is an **in-process plugin whose task store lives at profile level**: tasks persist under the dsh home and fire into whichever live root agent exists, regardless of surface (TUI / web / feishu). This makes tasks cross-session and cross-surface, and positions dsh-cron as the complement of dsh-schedule (session-scoped reminders) rather than a duplicate.

## Considered Options

- **Session-anchored** (pi-kimi-cron semantics, per-session store): rejected — dsh sessions end and archive; per-session cron tasks are unmanageable across multiple surfaces.
- **Out-of-process daemon** (spawn headless `dsh` per fire): rejected for v1 — process lifecycle, crash recovery, and unattended permission handling make it a separate, heavier product; it also collides with the community dsh-cron-scheduler plugin. Revisit as a possible future sibling plugin (dsh-cron-daemon).

## Consequences

- Fires happen only while the dsh profile process is running. A due fire during downtime is not lost (see missed-fire accounting) but cannot execute while nothing is booted.
- One store per dsh home, not per session; task ids are globally unique within a profile.
