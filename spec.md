# Aim Trainer

## Current State
A browser-based aim training app with three modes: Static, Moving, and Tracking. The Tracking mode has the target moving in a random, unpredictable path and the user scores by keeping their cursor over it. The Results screen currently shows Replay, Heatmap, and Performance graphs (accuracy/efficiency over time charts) only for Static and Moving modes — Tracking mode shows only a "Play Again" button with no charts, no replay, and no heatmap. There is no per-mode difficulty system in Tracking mode; it uses the same global difficulty dropdown.

## Requested Changes (Diff)

### Add
- Three difficulty sub-options specifically for Tracking mode displayed as a 3-button row in the Settings panel when "Tracking" mode is selected:
  - **Easy** — large target (radius 50px + mobile bonus), slow speed range (50–100 px/s), infrequent direction changes
  - **Average** — medium target (radius 32px + mobile bonus), medium speed range (80–160 px/s), moderate direction changes
  - **Pro** — small target (radius 18px + mobile bonus), fast speed range (140–260 px/s), frequent direction changes
- In the Tracking results screen, show full post-session analytics identical to other modes:
  - Replay button (Watch Replay) — records cursor movement during tracking and plays back the cursor path
  - Heatmap button (Show Heatmap) — shows density of where the cursor spent time
  - Accuracy/Efficiency performance graphs (time-on-target % per 5-second interval and score/sec per 5-second interval)

### Modify
- `GameSettings` type: add `trackingDifficulty: "easy" | "average" | "pro"` field (default `"average"`)
- `spawnTarget`: use tracking-specific speed constants based on `trackingDifficulty`
- Game loop: use per-difficulty speed ranges and direction-change frequency in tracking mode
- `MenuScreen`: when mode is "tracking", show a second difficulty selector row (3-button: Easy / Average / Pro) below the mode selector, replacing or supplementing the global difficulty for target sizing
- `ResultsScreen` for tracking mode: replace the single "Play Again" button layout with the full 3-button action row (Watch Replay, Show Heatmap, Play Again); show the Performance Analysis charts section
- Tracking `IntervalStat` timeline: compute per-5-second time-on-target% and score/sec for charts (mirrors existing accuracy/hps buckets)
- Recording: in tracking mode, record `move` events from cursor movement so replay and heatmap have data

### Remove
- Nothing removed; the single "Play Again" only layout for tracking results is replaced

## Implementation Plan
1. Add `trackingDifficulty` to `GameSettings` type and default state
2. Add `getTrackingParams(difficulty)` helper returning `{radius, speedMin, speedMax, dirChangeMin, dirChangeMax}`
3. Update `MenuScreen` to show Easy/Average/Pro 3-button row when mode === "tracking"
4. Update `GameScreen` to use tracking params for radius and speed when in tracking mode
5. Update tracking game loop to use per-difficulty speed/direction-change ranges
6. Ensure cursor `move` events are recorded in tracking mode (currently skipped) so replay and heatmap work
7. Compute tracking-specific `timelineData` using time-on-target% per interval and score/sec per interval
8. Update `ResultsScreen` tracking mode to show full 3-button actions and Performance Analysis charts
9. Validate and deploy
