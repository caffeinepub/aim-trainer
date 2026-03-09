import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  Crosshair,
  Film,
  MapIcon,
  Play,
  RotateCcw,
  Trophy,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = "menu" | "game" | "results" | "replay" | "heatmap";
type Difficulty = "easy" | "medium" | "hard";
type TargetMode = "static" | "moving" | "tracking";
type Duration = 30 | 60 | 120;

interface AimEvent {
  time: number;
  x: number;
  y: number;
  action: "move" | "click";
  hit?: boolean;
}

type TrackingDifficulty = "easy" | "average" | "pro";

interface GameSettings {
  difficulty: Difficulty;
  duration: Duration;
  mode: TargetMode;
  trackingDifficulty: TrackingDifficulty;
}

interface IntervalStat {
  timeSec: number;
  accuracy: number; // 0-100
  hps: number; // hits per second in this interval
}

interface GameResults {
  shots: number;
  hits: number;
  misses: number;
  accuracy: number;
  hps: number;
  score: number;
  duration: Duration;
  aimData: AimEvent[];
  arenaWidth: number;
  arenaHeight: number;
  timelineData: IntervalStat[];
  // Tracking mode extras
  timeOnTargetMs?: number;
  trackingAccuracy?: number;
  gameMode?: TargetMode;
}

interface TargetState {
  x: number;
  y: number;
  radius: number;
  spawnTime: number;
  vx: number;
  vy: number;
  // Tracking mode extras
  angleOffset1?: number;
  angleOffset2?: number;
  speedMag?: number;
  framesTillDirectionChange?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BEST_SCORE_KEY = "aimtrainer_bestscore";
const TARGET_SPEED = 100; // px/s for moving mode
const TRACKING_SPEED_MIN = 80;
const TRACKING_SPEED_MAX = 200;
const HUD_UPDATE_INTERVAL = 100; // ms

function getRadius(difficulty: Difficulty, isMobile: boolean): number {
  const base = { easy: 40, medium: 26, hard: 16 }[difficulty];
  return base + (isMobile ? 10 : 0);
}

interface TrackingParams {
  radius: number;
  speedMin: number;
  speedMax: number;
  dirMin: number;
  dirMax: number;
}

function getTrackingParams(
  td: TrackingDifficulty,
  isMobile: boolean,
): TrackingParams {
  const configs: Record<TrackingDifficulty, TrackingParams> = {
    easy: {
      radius: 50 + (isMobile ? 12 : 0),
      speedMin: 50,
      speedMax: 100,
      dirMin: 70,
      dirMax: 120,
    },
    average: {
      radius: 32 + (isMobile ? 10 : 0),
      speedMin: 80,
      speedMax: 160,
      dirMin: 40,
      dirMax: 80,
    },
    pro: {
      radius: 18 + (isMobile ? 8 : 0),
      speedMin: 140,
      speedMax: 260,
      dirMin: 20,
      dirMax: 45,
    },
  };
  return configs[td];
}

function getBestScore(): number {
  try {
    return (
      Number.parseInt(localStorage.getItem(BEST_SCORE_KEY) || "0", 10) || 0
    );
  } catch {
    return 0;
  }
}

function setBestScore(score: number): void {
  try {
    localStorage.setItem(BEST_SCORE_KEY, score.toString());
  } catch {
    // ignore
  }
}

// ─── Audio ────────────────────────────────────────────────────────────────────

function playHitSound(ctx: AudioContext | null, muted: boolean): void {
  if (muted || !ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  } catch {
    // ignore audio errors
  }
}

function playMissSound(ctx: AudioContext | null, muted: boolean): void {
  if (muted || !ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.08);
  } catch {
    // ignore
  }
}

// ─── Canvas Drawing Helpers ───────────────────────────────────────────────────

function drawTarget(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  scale: number,
  trackingMode = false,
  isOnTarget = false,
) {
  const r = radius * scale;

  ctx.save();
  ctx.translate(x, y);

  if (trackingMode) {
    // Tracking mode: gold/amber when on target, dim red-tinted when off
    const pulsePhase = (Date.now() % 1000) / 1000;

    if (isOnTarget) {
      // Pulsing outer ring
      const pulseRadius = r * (1.6 + pulsePhase * 0.5);
      const pulseAlpha = (1 - pulsePhase) * 0.5;
      const pulseRing = ctx.createRadialGradient(
        0,
        0,
        r * 1.2,
        0,
        0,
        pulseRadius,
      );
      pulseRing.addColorStop(0, `rgba(255, 180, 20, ${pulseAlpha})`);
      pulseRing.addColorStop(1, "rgba(255, 180, 20, 0)");
      ctx.beginPath();
      ctx.arc(0, 0, pulseRadius, 0, Math.PI * 2);
      ctx.fillStyle = pulseRing;
      ctx.fill();

      // Bright gold outer glow ring
      const ringGrad = ctx.createRadialGradient(0, 0, r * 0.9, 0, 0, r * 1.5);
      ringGrad.addColorStop(0, "rgba(255, 200, 50, 0.4)");
      ringGrad.addColorStop(1, "rgba(255, 150, 0, 0)");
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = ringGrad;
      ctx.fill();

      // Main circle glow – intensified
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.2);
      grad.addColorStop(0, "rgba(255, 255, 200, 0.98)");
      grad.addColorStop(0.3, "rgba(255, 210, 50, 0.9)");
      grad.addColorStop(0.65, "rgba(220, 140, 20, 0.7)");
      grad.addColorStop(1, "rgba(180, 80, 0, 0)");
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // Outer ring stroke – gold
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 200, 50, 0.95)";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      // Off-target: dim red-orange tint
      const ringGrad = ctx.createRadialGradient(0, 0, r * 0.9, 0, 0, r * 1.3);
      ringGrad.addColorStop(0, "rgba(255, 80, 60, 0.15)");
      ringGrad.addColorStop(1, "rgba(255, 60, 40, 0)");
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.3, 0, Math.PI * 2);
      ctx.fillStyle = ringGrad;
      ctx.fill();

      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      grad.addColorStop(0, "rgba(255, 200, 180, 0.7)");
      grad.addColorStop(0.4, "rgba(220, 100, 80, 0.55)");
      grad.addColorStop(0.75, "rgba(180, 60, 50, 0.35)");
      grad.addColorStop(1, "rgba(120, 30, 20, 0)");
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // Outer ring stroke – dim red
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(220, 80, 60, 0.6)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Center dot
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = isOnTarget
      ? "rgba(255, 255, 200, 0.98)"
      : "rgba(255, 180, 160, 0.7)";
    ctx.fill();

    // Inner ring stroke
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    ctx.strokeStyle = isOnTarget
      ? "rgba(255, 220, 100, 0.5)"
      : "rgba(200, 100, 80, 0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    // Standard cyan target
    const ringGrad = ctx.createRadialGradient(0, 0, r * 0.9, 0, 0, r * 1.4);
    ringGrad.addColorStop(0, "rgba(0, 220, 255, 0.3)");
    ringGrad.addColorStop(1, "rgba(0, 220, 255, 0)");
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.4, 0, Math.PI * 2);
    ctx.fillStyle = ringGrad;
    ctx.fill();

    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, "rgba(180, 255, 255, 0.95)");
    grad.addColorStop(0.35, "rgba(0, 220, 255, 0.85)");
    grad.addColorStop(0.7, "rgba(0, 160, 220, 0.6)");
    grad.addColorStop(1, "rgba(0, 100, 180, 0)");
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 220, 255, 0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(180, 255, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.restore();
}

// ─── Spawn Target ─────────────────────────────────────────────────────────────

function spawnTarget(
  arenaWidth: number,
  arenaHeight: number,
  radius: number,
  mode: TargetMode,
  trackingSpeedMin?: number,
  trackingSpeedMax?: number,
  trackingDirMin?: number,
  trackingDirMax?: number,
): TargetState {
  const margin = radius + 10;
  const x = margin + Math.random() * (arenaWidth - margin * 2);
  const y = margin + Math.random() * (arenaHeight - margin * 2);
  const angle = Math.random() * Math.PI * 2;

  if (mode === "tracking") {
    const speedMin = trackingSpeedMin ?? TRACKING_SPEED_MIN;
    const speedMax = trackingSpeedMax ?? TRACKING_SPEED_MAX;
    const dirMin = trackingDirMin ?? 40;
    const dirMax = trackingDirMax ?? 80;
    const speedMag = speedMin + Math.random() * (speedMax - speedMin);
    const framesChange = dirMin + Math.floor(Math.random() * (dirMax - dirMin));
    return {
      x,
      y,
      radius,
      spawnTime: performance.now(),
      vx: Math.cos(angle) * speedMag,
      vy: Math.sin(angle) * speedMag,
      angleOffset1: Math.random() * Math.PI * 2,
      angleOffset2: Math.random() * Math.PI * 2,
      speedMag,
      framesTillDirectionChange: framesChange,
    };
  }

  const speed = mode === "moving" ? TARGET_SPEED : 0;
  return {
    x,
    y,
    radius,
    spawnTime: performance.now(),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
}

// ─── Screen: Menu ─────────────────────────────────────────────────────────────

interface MenuScreenProps {
  settings: GameSettings;
  onSettingsChange: (s: GameSettings) => void;
  onStart: () => void;
  muted: boolean;
  onToggleMute: () => void;
  bestScore: number;
}

function MenuScreen({
  settings,
  onSettingsChange,
  onStart,
  muted,
  onToggleMute,
  bestScore,
}: MenuScreenProps) {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:
          "linear-gradient(160deg, oklch(0.08 0.01 240) 0%, oklch(0.06 0.015 250) 50%, oklch(0.09 0.012 230) 100%)",
      }}
    >
      {/* Header */}
      <header
        className="flex items-center justify-between px-6 py-4 border-b"
        style={{ borderColor: "oklch(var(--border))" }}
      >
        <div className="flex items-center gap-3">
          <Crosshair
            className="w-6 h-6"
            style={{ color: "oklch(var(--cyan))" }}
          />
          <h1
            className="text-2xl font-bold tracking-widest uppercase glow-text"
            style={{ color: "oklch(var(--cyan))" }}
          >
            AIM TRAINER
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {bestScore > 0 && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded text-sm"
              style={{
                background: "oklch(var(--card))",
                border: "1px solid oklch(var(--border))",
              }}
            >
              <Trophy
                className="w-3.5 h-3.5"
                style={{ color: "oklch(var(--chart-3))" }}
              />
              <span style={{ color: "oklch(var(--muted-foreground))" }}>
                BEST
              </span>
              <span
                className="font-bold hud-number"
                style={{ color: "oklch(var(--chart-3))" }}
              >
                {bestScore.toLocaleString()}
              </span>
            </div>
          )}
          <button
            type="button"
            data-ocid="header.toggle"
            onClick={onToggleMute}
            className="p-2 rounded transition-colors"
            style={{
              color: muted
                ? "oklch(var(--muted-foreground))"
                : "oklch(var(--cyan))",
              background: "oklch(var(--card))",
              border: "1px solid oklch(var(--border))",
            }}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted ? (
              <VolumeX className="w-5 h-5" />
            ) : (
              <Volume2 className="w-5 h-5" />
            )}
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-8 p-6 lg:p-12">
        {/* Left: Hero */}
        <div className="flex flex-col items-center lg:items-start gap-6 lg:flex-1 animate-fade-in">
          <div
            className="relative flex items-center justify-center"
            style={{ width: 180, height: 180 }}
          >
            {/* Decorative rings */}
            <div
              className="absolute rounded-full border"
              style={{
                width: 180,
                height: 180,
                borderColor: "oklch(var(--cyan) / 0.15)",
              }}
            />
            <div
              className="absolute rounded-full border"
              style={{
                width: 130,
                height: 130,
                borderColor: "oklch(var(--cyan) / 0.25)",
              }}
            />
            <div
              className="absolute rounded-full border"
              style={{
                width: 80,
                height: 80,
                borderColor: "oklch(var(--cyan) / 0.4)",
              }}
            />
            <div
              className="rounded-full"
              style={{
                width: 30,
                height: 30,
                background:
                  "radial-gradient(circle, oklch(0.88 0.2 195), oklch(0.55 0.14 195))",
                boxShadow: "0 0 30px oklch(var(--cyan) / 0.8)",
              }}
            />
            {/* Crosshair lines */}
            <div
              className="absolute"
              style={{
                width: 200,
                height: 1,
                background: "oklch(var(--cyan) / 0.2)",
              }}
            />
            <div
              className="absolute"
              style={{
                width: 1,
                height: 200,
                background: "oklch(var(--cyan) / 0.2)",
              }}
            />
          </div>

          <div className="text-center lg:text-left">
            <h2
              className="text-4xl lg:text-5xl font-bold mb-3"
              style={{ color: "oklch(var(--foreground))" }}
            >
              Train Your
            </h2>
            <h2
              className="text-4xl lg:text-5xl font-bold mb-6 glow-text"
              style={{ color: "oklch(var(--cyan))" }}
            >
              Aim Precision
            </h2>
            <p
              style={{ color: "oklch(var(--muted-foreground))", maxWidth: 360 }}
              className="text-sm leading-relaxed"
            >
              Click targets as fast and accurately as possible. Or follow moving
              targets to train your tracking aim.
            </p>
          </div>

          <div
            className="flex flex-wrap gap-4 text-xs"
            style={{ color: "oklch(var(--muted-foreground))" }}
          >
            <div className="flex items-center gap-1.5">
              <Zap
                className="w-3.5 h-3.5"
                style={{ color: "oklch(var(--cyan))" }}
              />
              Real-time stats
            </div>
            <div className="flex items-center gap-1.5">
              <Film
                className="w-3.5 h-3.5"
                style={{ color: "oklch(var(--cyan))" }}
              />
              Session replay
            </div>
            <div className="flex items-center gap-1.5">
              <MapIcon
                className="w-3.5 h-3.5"
                style={{ color: "oklch(var(--cyan))" }}
              />
              Heatmap analysis
            </div>
          </div>
        </div>

        {/* Right: Settings */}
        <div
          className="w-full max-w-sm lg:flex-none animate-slide-up rounded-xl p-6 glow-border"
          style={{
            background: "oklch(var(--card))",
            border: "1px solid oklch(var(--border))",
          }}
        >
          <h3
            className="text-sm font-semibold tracking-widest uppercase mb-6"
            style={{ color: "oklch(var(--muted-foreground))" }}
          >
            Session Settings
          </h3>

          <div className="space-y-5">
            {/* Difficulty */}
            <div className="space-y-2">
              <span
                className="text-xs font-medium tracking-widest uppercase"
                style={{ color: "oklch(var(--muted-foreground))" }}
              >
                Difficulty
              </span>
              <Select
                value={settings.difficulty}
                onValueChange={(v) =>
                  onSettingsChange({ ...settings, difficulty: v as Difficulty })
                }
              >
                <SelectTrigger
                  data-ocid="settings.difficulty.select"
                  className="w-full"
                  style={{
                    background: "oklch(var(--input))",
                    border: "1px solid oklch(var(--border))",
                    color: "oklch(var(--foreground))",
                  }}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  style={{
                    background: "oklch(var(--popover))",
                    border: "1px solid oklch(var(--border))",
                  }}
                >
                  <SelectItem value="easy">
                    <span className="flex items-center gap-2">
                      <span className="text-green-400">●</span> Easy — Large
                      Targets (40px)
                    </span>
                  </SelectItem>
                  <SelectItem value="medium">
                    <span className="flex items-center gap-2">
                      <span className="text-yellow-400">●</span> Medium — Normal
                      Targets (26px)
                    </span>
                  </SelectItem>
                  <SelectItem value="hard">
                    <span className="flex items-center gap-2">
                      <span className="text-red-400">●</span> Hard — Small
                      Targets (16px)
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Duration */}
            <div className="space-y-2">
              <span
                className="text-xs font-medium tracking-widest uppercase"
                style={{ color: "oklch(var(--muted-foreground))" }}
              >
                Duration
              </span>
              <Select
                value={String(settings.duration)}
                onValueChange={(v) =>
                  onSettingsChange({
                    ...settings,
                    duration: Number.parseInt(v, 10) as Duration,
                  })
                }
              >
                <SelectTrigger
                  data-ocid="settings.duration.select"
                  className="w-full"
                  style={{
                    background: "oklch(var(--input))",
                    border: "1px solid oklch(var(--border))",
                    color: "oklch(var(--foreground))",
                  }}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  style={{
                    background: "oklch(var(--popover))",
                    border: "1px solid oklch(var(--border))",
                  }}
                >
                  <SelectItem value="30">30 seconds — Quick Session</SelectItem>
                  <SelectItem value="60">60 seconds — Standard</SelectItem>
                  <SelectItem value="120">120 seconds — Extended</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Target Mode — 3-button row */}
            <div className="space-y-2">
              <span
                className="text-xs font-medium tracking-widest uppercase"
                style={{ color: "oklch(var(--muted-foreground))" }}
              >
                Target Mode
              </span>
              <div
                className="flex rounded overflow-hidden"
                style={{ border: "1px solid oklch(var(--border))" }}
              >
                <button
                  type="button"
                  data-ocid="settings.mode.toggle"
                  onClick={() =>
                    onSettingsChange({ ...settings, mode: "static" })
                  }
                  className="flex-1 py-2.5 text-sm font-medium transition-colors"
                  style={{
                    background:
                      settings.mode === "static"
                        ? "oklch(var(--cyan) / 0.2)"
                        : "oklch(var(--input))",
                    color:
                      settings.mode === "static"
                        ? "oklch(var(--cyan))"
                        : "oklch(var(--muted-foreground))",
                    borderRight: "1px solid oklch(var(--border))",
                  }}
                >
                  Static
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onSettingsChange({ ...settings, mode: "moving" })
                  }
                  className="flex-1 py-2.5 text-sm font-medium transition-colors"
                  style={{
                    background:
                      settings.mode === "moving"
                        ? "oklch(var(--cyan) / 0.2)"
                        : "oklch(var(--input))",
                    color:
                      settings.mode === "moving"
                        ? "oklch(var(--cyan))"
                        : "oklch(var(--muted-foreground))",
                    borderRight: "1px solid oklch(var(--border))",
                  }}
                >
                  Moving
                </button>
                <button
                  type="button"
                  data-ocid="settings.tracking.toggle"
                  onClick={() =>
                    onSettingsChange({ ...settings, mode: "tracking" })
                  }
                  className="flex-1 py-2.5 text-sm font-medium transition-colors"
                  style={{
                    background:
                      settings.mode === "tracking"
                        ? "oklch(0.78 0.18 85 / 0.2)"
                        : "oklch(var(--input))",
                    color:
                      settings.mode === "tracking"
                        ? "oklch(0.78 0.18 85)"
                        : "oklch(var(--muted-foreground))",
                  }}
                >
                  Tracking
                </button>
              </div>
              {settings.mode === "tracking" && (
                <p
                  className="text-xs leading-relaxed pt-1"
                  style={{ color: "oklch(var(--muted-foreground))" }}
                >
                  Follow the target with your cursor to score points. No
                  clicking needed.
                </p>
              )}
            </div>

            {/* Tracking Difficulty — only visible in tracking mode */}
            {settings.mode === "tracking" && (
              <div className="space-y-2">
                <span
                  className="text-xs font-medium tracking-widest uppercase"
                  style={{ color: "oklch(var(--muted-foreground))" }}
                >
                  Tracking Difficulty
                </span>
                <div
                  className="flex rounded overflow-hidden"
                  style={{ border: "1px solid oklch(0.78 0.18 85 / 0.35)" }}
                >
                  {(
                    [
                      { value: "easy", label: "Easy" },
                      { value: "average", label: "Average" },
                      { value: "pro", label: "Pro" },
                    ] as { value: TrackingDifficulty; label: string }[]
                  ).map((opt, idx) => {
                    const isActive = settings.trackingDifficulty === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        data-ocid={
                          idx === 0
                            ? "settings.tracking_difficulty.toggle"
                            : undefined
                        }
                        onClick={() =>
                          onSettingsChange({
                            ...settings,
                            trackingDifficulty: opt.value,
                          })
                        }
                        className="flex-1 py-2.5 text-sm font-medium transition-colors"
                        style={{
                          background: isActive
                            ? "oklch(0.78 0.18 85 / 0.2)"
                            : "oklch(var(--input))",
                          color: isActive
                            ? "oklch(0.78 0.18 85)"
                            : "oklch(var(--muted-foreground))",
                          borderRight:
                            idx < 2
                              ? "1px solid oklch(0.78 0.18 85 / 0.25)"
                              : "none",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <Button
            data-ocid="menu.start_button"
            onClick={onStart}
            className="w-full mt-8 py-6 text-base font-bold tracking-widest uppercase btn-glow"
            style={{
              background:
                settings.mode === "tracking"
                  ? "linear-gradient(135deg, oklch(0.78 0.18 85), oklch(0.65 0.2 55))"
                  : "linear-gradient(135deg, oklch(0.65 0.22 195), oklch(0.55 0.2 210))",
              color: "oklch(0.05 0.01 240)",
              border: "none",
            }}
          >
            <Play className="w-5 h-5 mr-2" />
            Start Training
          </Button>
        </div>
      </main>

      <footer
        className="py-4 text-center text-xs"
        style={{ color: "oklch(var(--muted-foreground) / 0.5)" }}
      >
        © {new Date().getFullYear()}.{" "}
        <a
          href={`https://caffeine.ai?utm_source=caffeine-footer&utm_medium=referral&utm_content=${encodeURIComponent(window.location.hostname)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "oklch(var(--cyan) / 0.6)" }}
        >
          Built with ♥ using caffeine.ai
        </a>
      </footer>
    </div>
  );
}

// ─── Screen: Game ─────────────────────────────────────────────────────────────

interface GameScreenProps {
  settings: GameSettings;
  muted: boolean;
  onToggleMute: () => void;
  onGameEnd: (results: GameResults) => void;
  ensureAudioCtx: () => AudioContext | null;
}

function GameScreen({
  settings,
  muted,
  onToggleMute,
  onGameEnd,
  ensureAudioCtx,
}: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isTracking = settings.mode === "tracking";

  // Game state refs (avoid re-renders inside rAF)
  const stateRef = useRef({
    hits: 0,
    misses: 0,
    score: 0,
    running: true,
    target: null as TargetState | null,
    aimData: [] as AimEvent[],
    cursorTrail: [] as { x: number; y: number }[],
    lastMoveTime: 0,
    lastHudUpdate: 0,
    sessionStartTime: Date.now(),
    remainingTime: settings.duration * 1000,
    lastFrameTime: 0,
    // Tracking-specific
    cursorX: 0,
    cursorY: 0,
    timeOnTargetMs: 0,
    framesOnTarget: 0,
    totalFrames: 0,
    isOnTarget: false,
    trackingBuckets: new Map<
      number,
      { framesTotal: number; framesOnTarget: number; scoreSum: number }
    >(),
  });

  const rafRef = useRef<number>(0);
  const bestScore = getBestScore();

  // HUD state (throttled updates)
  const [hud, setHud] = useState<{
    hits: number;
    misses: number;
    score: number;
    remaining: number;
    accuracy: string;
    isOnTarget: boolean;
  }>({
    hits: 0,
    misses: 0,
    score: 0,
    remaining: settings.duration,
    accuracy: "0.0",
    isOnTarget: false,
  });
  const isMobile = window.innerWidth < 600;
  const trackingParams =
    settings.mode === "tracking"
      ? getTrackingParams(settings.trackingDifficulty, isMobile)
      : null;
  const radius =
    settings.mode === "tracking"
      ? (trackingParams?.radius ?? getRadius(settings.difficulty, isMobile))
      : getRadius(settings.difficulty, isMobile);

  const initTarget = useCallback(
    (canvas: HTMLCanvasElement) => {
      const tp =
        settings.mode === "tracking"
          ? getTrackingParams(settings.trackingDifficulty, isMobile)
          : null;
      stateRef.current.target = spawnTarget(
        canvas.width,
        canvas.height,
        radius,
        settings.mode,
        tp?.speedMin,
        tp?.speedMax,
        tp?.dirMin,
        tp?.dirMax,
      );
    },
    [radius, settings.mode, settings.trackingDifficulty, isMobile],
  );

  const endGame = useCallback(() => {
    if (!stateRef.current.running) return;
    stateRef.current.running = false;
    cancelAnimationFrame(rafRef.current);

    const {
      hits,
      misses,
      score,
      aimData,
      timeOnTargetMs,
      framesOnTarget,
      totalFrames,
      trackingBuckets,
    } = stateRef.current;
    const canvas = canvasRef.current;
    const shots = hits + misses;
    const accuracy = shots > 0 ? (hits / shots) * 100 : 0;
    const hps = hits / settings.duration;

    const trackingAccuracy =
      totalFrames > 0 ? (framesOnTarget / totalFrames) * 100 : 0;

    let timelineData: IntervalStat[];

    if (settings.mode === "tracking") {
      // Build timeline from per-frame tracking buckets
      timelineData = Array.from(trackingBuckets.entries())
        .sort(([a], [b]) => a - b)
        .map(([idx, b]) => ({
          timeSec: (idx + 1) * 5,
          accuracy:
            b.framesTotal > 0 ? (b.framesOnTarget / b.framesTotal) * 100 : 0,
          hps: b.scoreSum / 5,
        }));
    } else {
      // Compute per-5-second interval timeline data from click events
      const buckets = new Map<number, { clicks: number; hits: number }>();
      for (const ev of aimData) {
        if (ev.action !== "click") continue;
        const bucketIdx = Math.floor(ev.time / 5000);
        const existing = buckets.get(bucketIdx) ?? { clicks: 0, hits: 0 };
        existing.clicks++;
        if (ev.hit) existing.hits++;
        buckets.set(bucketIdx, existing);
      }
      timelineData = Array.from(buckets.entries())
        .sort(([a], [b]) => a - b)
        .map(([bucketIdx, { clicks, hits: bHits }]) => ({
          timeSec: (bucketIdx + 1) * 5,
          accuracy: clicks > 0 ? (bHits / clicks) * 100 : 0,
          hps: bHits / 5,
        }));
    }

    onGameEnd({
      shots,
      hits,
      misses,
      accuracy,
      hps,
      score,
      duration: settings.duration,
      aimData,
      arenaWidth: canvas?.width ?? 800,
      arenaHeight: canvas?.height ?? 600,
      timelineData,
      timeOnTargetMs,
      trackingAccuracy,
      gameMode: settings.mode,
    });
  }, [onGameEnd, settings.duration, settings.mode]);

  const handleInput = useCallback(
    (x: number, y: number, isClick: boolean) => {
      const state = stateRef.current;
      if (!state.running) return;

      // In tracking mode, always track cursor position; clicks do nothing
      if (isTracking) {
        state.cursorX = x;
        state.cursorY = y;
        // Update cursor trail
        state.cursorTrail.push({ x, y });
        if (state.cursorTrail.length > 30) {
          state.cursorTrail.shift();
        }
        // Also record move events for replay/heatmap (throttled to ~16ms)
        if (!isClick) {
          const now = performance.now();
          const elapsed = Date.now() - state.sessionStartTime;
          if (now - state.lastMoveTime >= 16) {
            state.aimData.push({ time: elapsed, x, y, action: "move" });
            state.lastMoveTime = now;
          }
        }
        return;
      }

      const now = performance.now();
      const elapsed = Date.now() - state.sessionStartTime;

      if (isClick) {
        const target = state.target;
        const hit =
          target !== null &&
          Math.hypot(x - target.x, y - target.y) <= target.radius;

        state.aimData.push({ time: elapsed, x, y, action: "click", hit });

        if (hit) {
          state.hits++;
          state.score += 100;
          const ctx = ensureAudioCtx();
          playHitSound(ctx, muted);
          const canvas = canvasRef.current;
          if (canvas) {
            state.target = spawnTarget(
              canvas.width,
              canvas.height,
              radius,
              settings.mode,
            );
          }
        } else {
          state.misses++;
          const ctx = ensureAudioCtx();
          playMissSound(ctx, muted);
        }
      } else {
        // Update cursor trail (circular buffer, max 30 points)
        state.cursorTrail.push({ x, y });
        if (state.cursorTrail.length > 30) {
          state.cursorTrail.shift();
        }
        // Throttle move recording to ~16ms
        if (now - state.lastMoveTime >= 16) {
          state.aimData.push({ time: elapsed, x, y, action: "move" });
          state.lastMoveTime = now;
        }
      }
    },
    [muted, radius, settings.mode, ensureAudioCtx, isTracking],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Set canvas size
    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      if (stateRef.current.running) {
        initTarget(canvas);
      }
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    initTarget(canvas);
    stateRef.current.lastFrameTime = performance.now();

    // Game loop
    const loop = (now: number) => {
      const state = stateRef.current;
      if (!state.running) return;

      const dt = (now - state.lastFrameTime) / 1000;
      state.lastFrameTime = now;

      // Update remaining time
      state.remainingTime = Math.max(
        0,
        settings.duration * 1000 - (Date.now() - state.sessionStartTime),
      );

      if (state.remainingTime <= 0) {
        endGame();
        return;
      }

      // Move target
      if (settings.mode === "moving" && state.target) {
        const t = state.target;
        t.x += t.vx * dt;
        t.y += t.vy * dt;

        // Bounce off edges
        if (t.x - t.radius < 0) {
          t.x = t.radius;
          t.vx = Math.abs(t.vx);
        }
        if (t.x + t.radius > canvas.width) {
          t.x = canvas.width - t.radius;
          t.vx = -Math.abs(t.vx);
        }
        if (t.y - t.radius < 0) {
          t.y = t.radius;
          t.vy = Math.abs(t.vy);
        }
        if (t.y + t.radius > canvas.height) {
          t.y = canvas.height - t.radius;
          t.vy = -Math.abs(t.vy);
        }
      }

      // Tracking mode: smooth random-walk movement
      if (settings.mode === "tracking" && state.target) {
        const t = state.target;
        const tp = getTrackingParams(settings.trackingDifficulty, isMobile);

        // Ensure tracking extras are initialized
        if (t.angleOffset1 === undefined)
          t.angleOffset1 = Math.random() * Math.PI * 2;
        if (t.angleOffset2 === undefined)
          t.angleOffset2 = Math.random() * Math.PI * 2;
        if (t.speedMag === undefined)
          t.speedMag = (tp.speedMin + tp.speedMax) / 2;
        if (t.framesTillDirectionChange === undefined)
          t.framesTillDirectionChange =
            tp.dirMin + Math.floor(Math.random() * (tp.dirMax - tp.dirMin));

        // Evolve angles slowly each frame
        t.angleOffset1 += 0.02 + Math.random() * 0.04;
        t.angleOffset2 += 0.015 + Math.random() * 0.035;

        // Smoothly vary speed within difficulty range
        t.speedMag =
          tp.speedMin +
          ((Math.sin(t.angleOffset1 * 0.3) + 1) / 2) *
            (tp.speedMax - tp.speedMin);

        // Decrement direction-change counter
        t.framesTillDirectionChange--;
        if (t.framesTillDirectionChange <= 0) {
          // Snap to a completely new random direction
          const newAngle = Math.random() * Math.PI * 2;
          t.vx = Math.cos(newAngle) * t.speedMag;
          t.vy = Math.sin(newAngle) * t.speedMag;
          t.angleOffset1 = Math.random() * Math.PI * 2;
          t.angleOffset2 = Math.random() * Math.PI * 2;
          t.framesTillDirectionChange =
            tp.dirMin + Math.floor(Math.random() * (tp.dirMax - tp.dirMin));
        } else {
          // Smooth curve driven by angle offsets
          const desiredAngle = Math.atan2(
            Math.sin(t.angleOffset2),
            Math.cos(t.angleOffset1),
          );
          t.vx = Math.cos(desiredAngle) * t.speedMag;
          t.vy = Math.sin(desiredAngle) * t.speedMag;
        }

        t.x += t.vx * dt;
        t.y += t.vy * dt;

        // Bounce off edges
        if (t.x - t.radius < 0) {
          t.x = t.radius;
          t.vx = Math.abs(t.vx);
          t.angleOffset1 = Math.random() * Math.PI * 2;
        }
        if (t.x + t.radius > canvas.width) {
          t.x = canvas.width - t.radius;
          t.vx = -Math.abs(t.vx);
          t.angleOffset1 = Math.random() * Math.PI * 2;
        }
        if (t.y - t.radius < 0) {
          t.y = t.radius;
          t.vy = Math.abs(t.vy);
          t.angleOffset2 = Math.random() * Math.PI * 2;
        }
        if (t.y + t.radius > canvas.height) {
          t.y = canvas.height - t.radius;
          t.vy = -Math.abs(t.vy);
          t.angleOffset2 = Math.random() * Math.PI * 2;
        }

        // Tracking score logic
        state.totalFrames++;
        const elapsed = Date.now() - state.sessionStartTime;
        if (state.target) {
          const dist = Math.hypot(
            state.cursorX - state.target.x,
            state.cursorY - state.target.y,
          );
          const onTarget = dist <= state.target.radius;
          state.isOnTarget = onTarget;
          if (onTarget) {
            state.framesOnTarget++;
            state.score += 10;
            state.timeOnTargetMs += dt * 1000;
          }

          // Update 5-second interval buckets for graphs
          const bucketIdx = Math.floor(elapsed / 5000);
          const b = state.trackingBuckets.get(bucketIdx) ?? {
            framesTotal: 0,
            framesOnTarget: 0,
            scoreSum: 0,
          };
          b.framesTotal++;
          if (onTarget) {
            b.framesOnTarget++;
            b.scoreSum += 10;
          }
          state.trackingBuckets.set(bucketIdx, b);
        }
      }

      // Draw
      const ctx = canvas.getContext("2d");
      if (ctx) {
        // Clear
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Background
        ctx.fillStyle = "oklch(0.06 0.01 240)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Grid lines
        ctx.strokeStyle = "rgba(0, 180, 220, 0.05)";
        ctx.lineWidth = 1;
        const gridSize = 60;
        for (let gx = 0; gx <= canvas.width; gx += gridSize) {
          ctx.beginPath();
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, canvas.height);
          ctx.stroke();
        }
        for (let gy = 0; gy <= canvas.height; gy += gridSize) {
          ctx.beginPath();
          ctx.moveTo(0, gy);
          ctx.lineTo(canvas.width, gy);
          ctx.stroke();
        }

        // Draw target with spawn animation
        if (state.target) {
          const age = now - state.target.spawnTime;
          const spawnDuration = 150;
          const scale =
            age < spawnDuration
              ? Math.min(
                  1,
                  0.3 +
                    (age / spawnDuration) *
                      0.9 *
                      Math.sin((age / spawnDuration) * Math.PI * 0.6 + 0.4),
                )
              : 1;

          drawTarget(
            ctx,
            state.target.x,
            state.target.y,
            radius,
            Math.max(0.05, scale),
            settings.mode === "tracking",
            state.isOnTarget,
          );
        }

        // Draw cursor trail
        const trail = state.cursorTrail;
        if (trail.length >= 2) {
          const trailColor =
            settings.mode === "tracking"
              ? state.isOnTarget
                ? "255, 200, 50"
                : "255, 100, 80"
              : "0, 220, 255";

          ctx.save();
          ctx.shadowColor = `rgba(${trailColor}, 0.4)`;
          ctx.shadowBlur = 6;
          for (let ti = 0; ti < trail.length - 1; ti++) {
            const tFrac = (ti + 1) / trail.length; // 0 at oldest, 1 at newest
            const alpha = tFrac * 0.6;
            const lw = 1 + tFrac * 1.5;
            ctx.beginPath();
            ctx.moveTo(trail[ti].x, trail[ti].y);
            ctx.lineTo(trail[ti + 1].x, trail[ti + 1].y);
            ctx.strokeStyle = `rgba(${trailColor}, ${alpha})`;
            ctx.lineWidth = lw;
            ctx.lineCap = "round";
            ctx.stroke();
          }
          ctx.shadowBlur = 0;
          ctx.restore();
        }
      }

      // Throttled HUD update
      if (now - state.lastHudUpdate > HUD_UPDATE_INTERVAL) {
        state.lastHudUpdate = now;
        const shots = state.hits + state.misses;
        const acc = shots > 0 ? ((state.hits / shots) * 100).toFixed(1) : "0.0";
        const remaining = Math.ceil(state.remainingTime / 1000);
        setHud({
          hits: state.hits,
          misses: state.misses,
          score: state.score,
          remaining,
          accuracy: acc,
          isOnTarget: state.isOnTarget,
        });
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    // Input handlers
    const getCanvasPos = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const onMouseMove = (e: MouseEvent) => {
      const pos = getCanvasPos(e.clientX, e.clientY);
      handleInput(pos.x, pos.y, false);
    };

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      const pos = getCanvasPos(e.clientX, e.clientY);
      handleInput(pos.x, pos.y, true);
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      const pos = getCanvasPos(touch.clientX, touch.clientY);
      handleInput(pos.x, pos.y, false);
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      const pos = getCanvasPos(touch.clientX, touch.clientY);
      handleInput(pos.x, pos.y, true);
    };

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchstart", onTouchStart);
    };
  }, [initTarget, handleInput, endGame, settings, radius, isMobile]);

  const timerPct = (hud.remaining / settings.duration) * 100;
  const timerColor =
    timerPct > 50
      ? "oklch(var(--cyan))"
      : timerPct > 25
        ? "oklch(var(--chart-3))"
        : "oklch(var(--destructive))";

  return (
    <div
      className="flex flex-col h-screen"
      style={{ background: "oklch(0.06 0.01 240)" }}
    >
      {/* HUD */}
      <div
        data-ocid="game.hud.panel"
        className="flex items-center justify-between px-4 py-3 gap-4 flex-shrink-0"
        style={{
          background: "oklch(0.09 0.015 240 / 0.95)",
          borderBottom: "1px solid oklch(var(--border))",
        }}
      >
        <div className="flex items-center gap-6">
          {/* Timer */}
          <div className="flex flex-col items-center">
            <span
              className="text-xs tracking-widest uppercase"
              style={{ color: "oklch(var(--muted-foreground))" }}
            >
              Time
            </span>
            <span
              className="text-2xl font-bold hud-number"
              style={{
                color: timerColor,
                minWidth: 48,
                textAlign: "center",
                transition: "color 0.3s",
              }}
            >
              {hud.remaining}
            </span>
          </div>
          {/* Score */}
          <div className="flex flex-col items-center">
            <span
              className="text-xs tracking-widest uppercase"
              style={{ color: "oklch(var(--muted-foreground))" }}
            >
              {isTracking ? "Track Score" : "Score"}
            </span>
            <span
              className="text-2xl font-bold hud-number"
              style={{
                color: isTracking
                  ? "oklch(0.78 0.18 85)"
                  : "oklch(var(--cyan))",
              }}
            >
              {hud.score.toLocaleString()}
            </span>
          </div>
          {/* Tracking mode: ON/OFF target indicator */}
          {isTracking && (
            <div
              data-ocid="game.tracking.indicator"
              className="flex flex-col items-center"
            >
              <span
                className="text-xs tracking-widest uppercase"
                style={{ color: "oklch(var(--muted-foreground))" }}
              >
                Status
              </span>
              <span
                className="text-xs font-bold tracking-wider uppercase flex items-center gap-1"
                style={{
                  color: hud.isOnTarget
                    ? "oklch(0.75 0.2 145)"
                    : "oklch(0.55 0.15 25)",
                }}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{
                    background: hud.isOnTarget
                      ? "oklch(0.75 0.2 145)"
                      : "oklch(0.45 0.12 25)",
                    boxShadow: hud.isOnTarget
                      ? "0 0 6px oklch(0.75 0.2 145)"
                      : "none",
                  }}
                />
                {hud.isOnTarget ? "ON TARGET" : "OFF TARGET"}
              </span>
            </div>
          )}
        </div>

        {/* Timer bar */}
        <div className="flex-1 max-w-xs">
          <div
            className="h-2 rounded-full overflow-hidden"
            style={{ background: "oklch(var(--muted))" }}
          >
            <div
              className="h-full rounded-full transition-all duration-100"
              style={{
                width: `${timerPct}%`,
                background: timerColor,
                boxShadow: `0 0 8px ${timerColor}`,
              }}
            />
          </div>
        </div>

        <div className="flex items-center gap-6">
          {/* Accuracy (only for non-tracking modes) */}
          {!isTracking && (
            <div className="flex flex-col items-center hidden sm:flex">
              <span
                className="text-xs tracking-widest uppercase"
                style={{ color: "oklch(var(--muted-foreground))" }}
              >
                Accuracy
              </span>
              <span
                className="text-2xl font-bold hud-number"
                style={{ color: "oklch(var(--hit-green))" }}
              >
                {hud.accuracy}%
              </span>
            </div>
          )}
          {/* Best score */}
          {bestScore > 0 && (
            <div className="flex flex-col items-center hidden md:flex">
              <span
                className="text-xs tracking-widest uppercase"
                style={{ color: "oklch(var(--muted-foreground))" }}
              >
                Best
              </span>
              <span
                className="text-xl font-bold hud-number"
                style={{ color: "oklch(var(--chart-3))" }}
              >
                {bestScore.toLocaleString()}
              </span>
            </div>
          )}
          {/* Mute */}
          <button
            type="button"
            data-ocid="game.mute.toggle"
            onClick={onToggleMute}
            className="p-2 rounded"
            style={{
              color: muted
                ? "oklch(var(--muted-foreground))"
                : "oklch(var(--cyan))",
              background: "oklch(var(--card))",
              border: "1px solid oklch(var(--border))",
            }}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted ? (
              <VolumeX className="w-4 h-4" />
            ) : (
              <Volume2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Arena */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        <canvas
          ref={canvasRef}
          data-ocid="game.canvas_target"
          className="game-canvas w-full h-full"
        />
        {/* Tracking mode overlay hint */}
        {isTracking && (
          <div
            className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-medium tracking-widest uppercase pointer-events-none"
            style={{
              background: "oklch(0.09 0.015 240 / 0.85)",
              border: "1px solid oklch(0.78 0.18 85 / 0.3)",
              color: "oklch(0.78 0.18 85 / 0.8)",
            }}
          >
            Tracking Mode — Follow the target
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Screen: Results ──────────────────────────────────────────────────────────

interface ResultsScreenProps {
  results: GameResults;
  onReplay: () => void;
  onHeatmap: () => void;
  onRestart: () => void;
  previousBest: number;
  newBest: boolean;
}

function useChartCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  data: IntervalStat[],
  type: "accuracy" | "efficiency",
  isTracking = false,
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 500;
    const cssH = canvas.clientHeight || 220;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const W = cssW;
    const H = cssH;
    const padL = 44;
    const padB = 32;
    const padT = 20;
    const padR = 16;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    // Background
    ctx.fillStyle = "rgb(13, 15, 22)";
    ctx.fillRect(0, 0, W, H);

    const isAccuracy = type === "accuracy";
    const titleColor = isAccuracy
      ? "rgba(0, 220, 255, 0.9)"
      : "rgba(255, 200, 50, 0.9)";
    const lineColor = isAccuracy
      ? "rgba(0, 220, 255, 0.9)"
      : "rgba(255, 200, 50, 0.9)";
    const fillColorTop = isAccuracy
      ? "rgba(0, 220, 255, 0.25)"
      : "rgba(255, 200, 50, 0.2)";
    const title = isAccuracy
      ? isTracking
        ? "Tracking Accuracy Over Time"
        : "Accuracy Over Time"
      : isTracking
        ? "Score / Sec Over Time"
        : "Efficiency (Hits/s)";

    // Title
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = titleColor;
    ctx.textAlign = "left";
    ctx.fillText(title, padL, 14);

    if (data.length < 2) {
      ctx.font = "12px monospace";
      ctx.fillStyle = "rgba(180,180,200,0.5)";
      ctx.textAlign = "center";
      ctx.fillText("Not enough data", W / 2, H / 2);
      return;
    }

    // Determine value range
    const maxTime = data[data.length - 1].timeSec;
    const rawMax = isAccuracy
      ? 100
      : Math.ceil(Math.max(...data.map((d) => d.hps)) / 0.5) * 0.5 || 1;
    const yMin = 0;
    const yMax = rawMax;

    // Helper: map data coords to canvas coords
    const toX = (t: number) => padL + (t / maxTime) * chartW;
    const toY = (v: number) =>
      padT + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

    // Y gridlines + labels
    const yTicks = isAccuracy
      ? [0, 25, 50, 75, 100]
      : Array.from({ length: 5 }, (_, i) =>
          Number.parseFloat(((i / 4) * yMax).toFixed(2)),
        );

    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    for (const tick of yTicks) {
      const py = toY(tick);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + chartW, py);
      ctx.stroke();
      ctx.fillStyle = "rgba(180,180,200,0.6)";
      ctx.fillText(
        isAccuracy ? `${tick}%` : tick.toFixed(1),
        padL - 4,
        py + 3.5,
      );
    }

    // X axis labels
    ctx.textAlign = "center";
    const xLabelCount = Math.min(data.length, 6);
    const xStep = Math.ceil(data.length / xLabelCount);
    for (let i = 0; i < data.length; i += xStep) {
      const d = data[i];
      const px = toX(d.timeSec);
      ctx.fillStyle = "rgba(180,180,200,0.6)";
      ctx.fillText(`${d.timeSec}s`, px, H - padB + 14);
    }
    // Always label the last point
    {
      const last = data[data.length - 1];
      ctx.fillText(`${last.timeSec}s`, toX(last.timeSec), H - padB + 14);
    }

    // Axis lines
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + chartH);
    ctx.lineTo(padL + chartW, padT + chartH);
    ctx.stroke();

    // Build path
    const values = data.map((d) => (isAccuracy ? d.accuracy : d.hps));
    const points = data.map((d, i) => ({
      x: toX(d.timeSec),
      y: toY(values[i]),
    }));

    // Gradient fill
    const fillGrad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
    fillGrad.addColorStop(0, fillColorTop);
    fillGrad.addColorStop(1, "rgba(0,0,0,0)");

    ctx.beginPath();
    ctx.moveTo(points[0].x, padT + chartH);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[points.length - 1].x, padT + chartH);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Dots
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
    }
  }, [canvasRef, data, type, isTracking]);
}

function ResultsScreen({
  results,
  onReplay,
  onHeatmap,
  onRestart,
  previousBest,
  newBest,
}: ResultsScreenProps) {
  const accuracyCanvasRef = useRef<HTMLCanvasElement>(null);
  const efficiencyCanvasRef = useRef<HTMLCanvasElement>(null);
  const isTrackingMode = results.gameMode === "tracking";
  useChartCanvas(
    accuracyCanvasRef,
    results.timelineData,
    "accuracy",
    isTrackingMode,
  );
  useChartCanvas(
    efficiencyCanvasRef,
    results.timelineData,
    "efficiency",
    isTrackingMode,
  );

  // Build stat cards based on mode
  const stats = isTrackingMode
    ? [
        {
          id: "results.time-on-target.card",
          label: "Time on Target",
          value: ((results.timeOnTargetMs ?? 0) / 1000).toFixed(1),
          unit: "s",
          color: "oklch(0.78 0.18 85)",
        },
        {
          id: "results.tracking-accuracy.card",
          label: "Tracking Accuracy",
          value: (results.trackingAccuracy ?? 0).toFixed(1),
          unit: "%",
          color: "oklch(var(--cyan))",
        },
        {
          id: "results.hps.card",
          label: "Score / Sec",
          value: (results.score / results.duration).toFixed(1),
          unit: "",
          color: "oklch(var(--chart-5))",
        },
        {
          id: "results.score.card",
          label: "Final Score",
          value: results.score.toLocaleString(),
          unit: "",
          color: "oklch(var(--chart-3))",
          large: true,
        },
      ]
    : [
        {
          id: "results.shots.card",
          label: "Total Shots",
          value: results.shots,
          unit: "",
          color: "oklch(var(--foreground))",
        },
        {
          id: "results.hits.card",
          label: "Hits",
          value: results.hits,
          unit: "",
          color: "oklch(var(--hit-green))",
        },
        {
          id: "results.misses.card",
          label: "Misses",
          value: results.misses,
          unit: "",
          color: "oklch(var(--miss-red))",
        },
        {
          id: "results.accuracy.card",
          label: "Accuracy",
          value: results.accuracy.toFixed(1),
          unit: "%",
          color: "oklch(var(--cyan))",
        },
        {
          id: "results.hps.card",
          label: "Hits / Sec",
          value: results.hps.toFixed(2),
          unit: "",
          color: "oklch(var(--chart-5))",
        },
        {
          id: "results.score.card",
          label: "Final Score",
          value: results.score.toLocaleString(),
          unit: "",
          color: "oklch(var(--chart-3))",
          large: true,
        },
      ];

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-6"
      style={{
        background:
          "linear-gradient(160deg, oklch(0.08 0.01 240), oklch(0.06 0.015 250))",
      }}
    >
      <div
        data-ocid="results.panel"
        className="w-full max-w-2xl animate-fade-in"
      >
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <h2
              className="text-3xl font-bold tracking-wider uppercase"
              style={{ color: "oklch(var(--foreground))" }}
            >
              Session Complete
            </h2>
            {newBest && (
              <Badge
                className="animate-pulse"
                style={{
                  background: "oklch(var(--chart-3) / 0.2)",
                  color: "oklch(var(--chart-3))",
                  border: "1px solid oklch(var(--chart-3) / 0.5)",
                }}
              >
                <Trophy className="w-3 h-3 mr-1" /> New Best!
              </Badge>
            )}
          </div>
          <p
            className="text-sm"
            style={{ color: "oklch(var(--muted-foreground))" }}
          >
            {results.duration}s {isTrackingMode ? "tracking" : "session"} ·{" "}
            {isTrackingMode
              ? `${((results.timeOnTargetMs ?? 0) / 1000).toFixed(1)}s on target`
              : `${results.shots} shots fired`}
          </p>
          {!newBest && previousBest > 0 && (
            <p
              className="text-xs mt-1"
              style={{ color: "oklch(var(--muted-foreground) / 0.6)" }}
            >
              Best: {previousBest.toLocaleString()}
            </p>
          )}
          {isTrackingMode && (
            <div
              className="inline-flex items-center gap-2 mt-3 px-4 py-1.5 rounded-full text-xs font-semibold tracking-widest uppercase"
              style={{
                background: "oklch(0.78 0.18 85 / 0.12)",
                border: "1px solid oklch(0.78 0.18 85 / 0.3)",
                color: "oklch(0.78 0.18 85)",
              }}
            >
              <span>⊙</span> Tracking Mode
            </div>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
          {stats.map((stat, i) => (
            <div
              key={stat.id}
              data-ocid={stat.id}
              className="rounded-xl p-4 flex flex-col gap-1"
              style={{
                background: "oklch(var(--card))",
                border: "1px solid oklch(var(--border))",
                animationDelay: `${i * 60}ms`,
                animation: "slide-up 0.4s ease-out forwards",
                opacity: 0,
                ...(stat.large ? { gridColumn: "span 2 / span 2" } : {}),
              }}
            >
              <span
                className="text-xs tracking-widest uppercase"
                style={{ color: "oklch(var(--muted-foreground))" }}
              >
                {stat.label}
              </span>
              <span
                className="text-3xl font-bold hud-number"
                style={{ color: stat.color }}
              >
                {stat.value}
                {stat.unit}
              </span>
            </div>
          ))}
        </div>

        {/* Performance Analysis Charts — shown for all modes */}
        <div className="mb-8">
          <h3
            className="text-xs font-semibold tracking-widest uppercase mb-4"
            style={{ color: "oklch(var(--muted-foreground))" }}
          >
            Performance Analysis
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div
              className="rounded-xl overflow-hidden"
              style={{
                background: "oklch(var(--card))",
                border: "1px solid oklch(var(--border))",
              }}
            >
              <canvas
                ref={accuracyCanvasRef}
                data-ocid="results.accuracy.chart_point"
                className="w-full"
                style={{ height: 220, display: "block" }}
              />
            </div>
            <div
              className="rounded-xl overflow-hidden"
              style={{
                background: "oklch(var(--card))",
                border: "1px solid oklch(var(--border))",
              }}
            >
              <canvas
                ref={efficiencyCanvasRef}
                data-ocid="results.efficiency.chart_point"
                className="w-full"
                style={{ height: 220, display: "block" }}
              />
            </div>
          </div>
        </div>

        {/* Actions — same layout for all modes */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Button
            data-ocid="results.replay_button"
            onClick={onReplay}
            variant="outline"
            className="py-5 btn-glow"
            style={{
              border: "1px solid oklch(var(--border))",
              color: "oklch(var(--foreground))",
              background: "oklch(var(--card))",
            }}
            disabled={results.aimData.length === 0}
          >
            <Film className="w-4 h-4 mr-2" />
            Watch Replay
          </Button>
          <Button
            data-ocid="results.heatmap_button"
            onClick={onHeatmap}
            variant="outline"
            className="py-5 btn-glow"
            style={{
              border: "1px solid oklch(var(--border))",
              color: "oklch(var(--foreground))",
              background: "oklch(var(--card))",
            }}
            disabled={results.aimData.length === 0}
          >
            <MapIcon className="w-4 h-4 mr-2" />
            Show Heatmap
          </Button>
          <Button
            data-ocid="results.restart_button"
            onClick={onRestart}
            className="py-5 btn-glow"
            style={{
              background: isTrackingMode
                ? "linear-gradient(135deg, oklch(0.78 0.18 85), oklch(0.65 0.2 55))"
                : "linear-gradient(135deg, oklch(0.65 0.22 195), oklch(0.55 0.2 210))",
              color: "oklch(0.05 0.01 240)",
              border: "none",
            }}
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Play Again
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Screen: Replay ───────────────────────────────────────────────────────────

interface ReplayScreenProps {
  results: GameResults;
  onBack: () => void;
}

function ReplayScreen({ results, onBack }: ReplayScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const rafRef = useRef<number>(0);
  const stateRef = useRef({
    startTime: performance.now(),
    lastEventIdx: 0,
    cursorX: 0,
    cursorY: 0,
    playing: true,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    canvas.width = results.arenaWidth || rect.width;
    canvas.height = results.arenaHeight || rect.height;

    const events = results.aimData;
    const totalDuration =
      events.length > 0
        ? events[events.length - 1].time
        : results.duration * 1000;
    const clickMarkers: {
      x: number;
      y: number;
      hit: boolean;
      alpha: number;
    }[] = [];

    stateRef.current.startTime = performance.now();
    stateRef.current.lastEventIdx = 0;
    stateRef.current.cursorX = canvas.width / 2;
    stateRef.current.cursorY = canvas.height / 2;

    const draw = (now: number) => {
      if (!stateRef.current.playing) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const elapsed = now - stateRef.current.startTime;

      // Process events up to current time
      while (stateRef.current.lastEventIdx < events.length) {
        const ev = events[stateRef.current.lastEventIdx];
        if (ev.time > elapsed) break;

        if (ev.action === "move" || ev.action === "click") {
          stateRef.current.cursorX = ev.x;
          stateRef.current.cursorY = ev.y;
        }
        if (ev.action === "click") {
          clickMarkers.push({
            x: ev.x,
            y: ev.y,
            hit: ev.hit ?? false,
            alpha: 1,
          });
        }
        stateRef.current.lastEventIdx++;
      }

      // Clear
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "oklch(0.06 0.01 240)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid
      ctx.strokeStyle = "rgba(0, 180, 220, 0.05)";
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= canvas.width; gx += 60) {
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, canvas.height);
        ctx.stroke();
      }
      for (let gy = 0; gy <= canvas.height; gy += 60) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(canvas.width, gy);
        ctx.stroke();
      }

      // Fade click markers
      for (let i = clickMarkers.length - 1; i >= 0; i--) {
        const m = clickMarkers[i];
        m.alpha -= 0.008;
        if (m.alpha <= 0) {
          clickMarkers.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(m.x, m.y, 14, 0, Math.PI * 2);
        ctx.fillStyle = m.hit
          ? `rgba(80, 255, 120, ${m.alpha * 0.4})`
          : `rgba(255, 80, 80, ${m.alpha * 0.4})`;
        ctx.fill();
        ctx.strokeStyle = m.hit
          ? `rgba(80, 255, 120, ${m.alpha})`
          : `rgba(255, 80, 80, ${m.alpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();

        // X for miss
        ctx.strokeStyle = m.hit
          ? `rgba(80, 255, 120, ${m.alpha})`
          : `rgba(255, 80, 80, ${m.alpha})`;
        ctx.lineWidth = 2;
        if (!m.hit) {
          ctx.beginPath();
          ctx.moveTo(m.x - 5, m.y - 5);
          ctx.lineTo(m.x + 5, m.y + 5);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(m.x + 5, m.y - 5);
          ctx.lineTo(m.x - 5, m.y + 5);
          ctx.stroke();
        }
      }

      // Cursor
      const cx = stateRef.current.cursorX;
      const cy = stateRef.current.cursorY;

      // Cursor glow
      const cursorGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 20);
      cursorGrad.addColorStop(0, "rgba(0, 220, 255, 0.3)");
      cursorGrad.addColorStop(1, "rgba(0, 220, 255, 0)");
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fillStyle = cursorGrad;
      ctx.fill();

      // Cursor circle
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 220, 255, 0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Crosshair lines
      ctx.strokeStyle = "rgba(0, 220, 255, 0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 16, cy);
      ctx.lineTo(cx - 10, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 10, cy);
      ctx.lineTo(cx + 16, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - 16);
      ctx.lineTo(cx, cy - 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy + 10);
      ctx.lineTo(cx, cy + 16);
      ctx.stroke();

      // Progress
      const pct = Math.min(100, (elapsed / totalDuration) * 100);
      setProgress(pct);

      if (elapsed < totalDuration) {
        rafRef.current = requestAnimationFrame(draw);
      } else {
        stateRef.current.playing = false;
        setIsPlaying(false);
      }
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      stateRef.current.playing = false;
    };
  }, [results]);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "oklch(0.06 0.01 240)" }}
    >
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{
          background: "oklch(0.09 0.015 240 / 0.95)",
          borderBottom: "1px solid oklch(var(--border))",
        }}
      >
        <div className="flex items-center gap-3">
          <Film className="w-5 h-5" style={{ color: "oklch(var(--cyan))" }} />
          <h2
            className="font-bold tracking-wider uppercase"
            style={{ color: "oklch(var(--foreground))" }}
          >
            Session Replay
          </h2>
        </div>
        <div className="flex items-center gap-4">
          <div
            className="flex items-center gap-2 text-xs"
            style={{ color: "oklch(var(--muted-foreground))" }}
          >
            <span
              className="w-3 h-3 rounded-full inline-block"
              style={{ background: "oklch(var(--hit-green))" }}
            />{" "}
            Hit
            <span
              className="w-3 h-3 rounded-full inline-block ml-2"
              style={{ background: "oklch(var(--miss-red))" }}
            />{" "}
            Miss
          </div>
          <Button
            data-ocid="replay.back_button"
            onClick={onBack}
            variant="outline"
            size="sm"
            style={{
              border: "1px solid oklch(var(--border))",
              color: "oklch(var(--foreground))",
              background: "oklch(var(--card))",
            }}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Results
          </Button>
        </div>
      </div>

      <div ref={containerRef} className="flex-1 relative">
        <canvas
          ref={canvasRef}
          data-ocid="replay.canvas_target"
          className="w-full h-full"
          style={{ cursor: "default" }}
        />
        {!isPlaying && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: "oklch(0 0 0 / 0.5)" }}
          >
            <div className="text-center">
              <p
                className="text-lg font-bold mb-4"
                style={{ color: "oklch(var(--cyan))" }}
              >
                Replay Complete
              </p>
              <Button
                onClick={onBack}
                style={{
                  background: "oklch(var(--card))",
                  border: "1px solid oklch(var(--border))",
                  color: "oklch(var(--foreground))",
                }}
              >
                Back to Results
              </Button>
            </div>
          </div>
        )}
      </div>

      <div
        data-ocid="replay.progress.panel"
        className="flex-shrink-0 px-4 py-3"
        style={{
          background: "oklch(0.09 0.015 240 / 0.95)",
          borderTop: "1px solid oklch(var(--border))",
        }}
      >
        <div
          className="flex items-center gap-3 text-xs"
          style={{ color: "oklch(var(--muted-foreground))" }}
        >
          <span className="tracking-widest uppercase">Replay</span>
          <div
            className="flex-1 h-1.5 rounded-full overflow-hidden"
            style={{ background: "oklch(var(--muted))" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progress}%`,
                background: "oklch(var(--cyan))",
                transition: "width 0.1s linear",
                boxShadow: "0 0 6px oklch(var(--cyan) / 0.6)",
              }}
            />
          </div>
          <span>{Math.round(progress)}%</span>
        </div>
      </div>
    </div>
  );
}

// ─── Screen: Heatmap ──────────────────────────────────────────────────────────

interface HeatmapScreenProps {
  results: GameResults;
  onBack: () => void;
}

function HeatmapScreen({ results, onBack }: HeatmapScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const w = results.arenaWidth || container.clientWidth || 800;
    const h = results.arenaHeight || container.clientHeight || 600;
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Dark background
    ctx.fillStyle = "#060b12";
    ctx.fillRect(0, 0, w, h);

    // Draw heat spots on an offscreen canvas first
    const offscreen = document.createElement("canvas");
    offscreen.width = w;
    offscreen.height = h;
    const octx = offscreen.getContext("2d");
    if (!octx) return;

    octx.fillStyle = "black";
    octx.fillRect(0, 0, w, h);

    // Draw radial gradients for each recorded position
    for (const ev of results.aimData) {
      const isClick = ev.action === "click";
      const r = isClick ? 40 : 25;
      const alpha = isClick ? 0.18 : 0.04;

      const grad = octx.createRadialGradient(ev.x, ev.y, 0, ev.x, ev.y, r);
      grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      grad.addColorStop(1, "rgba(255, 255, 255, 0)");
      octx.fillStyle = grad;
      octx.fillRect(ev.x - r, ev.y - r, r * 2, r * 2);
    }

    // Colorize: map white intensity to color ramp
    const imgData = octx.getImageData(0, 0, w, h);
    const colorData = ctx.createImageData(w, h);

    for (let i = 0; i < imgData.data.length; i += 4) {
      const intensity = imgData.data[i] / 255; // 0 to 1

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (intensity <= 0) {
        r = 6;
        g = 11;
        b = 18;
        a = 255;
      } else if (intensity < 0.2) {
        // dark -> blue
        const t = intensity / 0.2;
        r = Math.round(6 + t * (0 - 6));
        g = Math.round(11 + t * (50 - 11));
        b = Math.round(18 + t * (200 - 18));
        a = 255;
      } else if (intensity < 0.4) {
        // blue -> cyan
        const t = (intensity - 0.2) / 0.2;
        r = Math.round(t * 0);
        g = Math.round(50 + t * (200 - 50));
        b = Math.round(200 + t * (220 - 200));
        a = 255;
      } else if (intensity < 0.6) {
        // cyan -> green
        const t = (intensity - 0.4) / 0.2;
        r = Math.round(t * 60);
        g = Math.round(200 + t * (240 - 200));
        b = Math.round(220 - t * 220);
        a = 255;
      } else if (intensity < 0.75) {
        // green -> yellow
        const t = (intensity - 0.6) / 0.15;
        r = Math.round(60 + t * (255 - 60));
        g = Math.round(240);
        b = 0;
        a = 255;
      } else if (intensity < 0.9) {
        // yellow -> orange
        const t = (intensity - 0.75) / 0.15;
        r = 255;
        g = Math.round(240 - t * (240 - 120));
        b = 0;
        a = 255;
      } else {
        // orange -> red
        const t = (intensity - 0.9) / 0.1;
        r = 255;
        g = Math.round(120 - t * 120);
        b = 0;
        a = 255;
      }

      colorData.data[i] = r;
      colorData.data[i + 1] = g;
      colorData.data[i + 2] = b;
      colorData.data[i + 3] = a;
    }

    ctx.putImageData(colorData, 0, 0);

    // Overlay grid
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= w; gx += 60) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
    }
    for (let gy = 0; gy <= h; gy += 60) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    // Click markers
    for (const ev of results.aimData) {
      if (ev.action === "click") {
        ctx.beginPath();
        ctx.arc(ev.x, ev.y, 5, 0, Math.PI * 2);
        ctx.strokeStyle = ev.hit
          ? "rgba(80, 255, 120, 0.8)"
          : "rgba(255, 80, 80, 0.8)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    setRendered(true);
  }, [results]);

  // Color scale legend
  const legendColors = [
    { color: "rgb(0, 50, 200)", label: "Low" },
    { color: "rgb(0, 200, 220)", label: "" },
    { color: "rgb(60, 240, 0)", label: "" },
    { color: "rgb(255, 240, 0)", label: "Med" },
    { color: "rgb(255, 120, 0)", label: "" },
    { color: "rgb(255, 0, 0)", label: "High" },
  ];

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "oklch(0.06 0.01 240)" }}
    >
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{
          background: "oklch(0.09 0.015 240 / 0.95)",
          borderBottom: "1px solid oklch(var(--border))",
        }}
      >
        <div className="flex items-center gap-3">
          <MapIcon
            className="w-5 h-5"
            style={{ color: "oklch(var(--cyan))" }}
          />
          <h2
            className="font-bold tracking-wider uppercase"
            style={{ color: "oklch(var(--foreground))" }}
          >
            Aim Heatmap
          </h2>
        </div>
        <div className="flex items-center gap-4">
          {/* Legend */}
          <div
            className="hidden sm:flex items-center gap-1 text-xs"
            style={{ color: "oklch(var(--muted-foreground))" }}
          >
            {legendColors.map((l) => (
              <span key={l.color} className="flex items-center gap-1">
                <span
                  className="w-3 h-3 rounded-sm inline-block"
                  style={{ background: l.color }}
                />
                {l.label && <span>{l.label}</span>}
              </span>
            ))}
          </div>
          <Button
            data-ocid="heatmap.back_button"
            onClick={onBack}
            variant="outline"
            size="sm"
            style={{
              border: "1px solid oklch(var(--border))",
              color: "oklch(var(--foreground))",
              background: "oklch(var(--card))",
            }}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Results
          </Button>
        </div>
      </div>

      <div ref={containerRef} className="flex-1 relative">
        {!rendered && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: "oklch(0.06 0.01 240)" }}
          >
            <div
              className="text-sm"
              style={{ color: "oklch(var(--muted-foreground))" }}
            >
              Generating heatmap...
            </div>
          </div>
        )}
        <canvas
          ref={canvasRef}
          data-ocid="heatmap.canvas_target"
          className="w-full h-full"
          style={{ cursor: "default" }}
        />
      </div>

      <div
        className="px-4 py-3 flex-shrink-0 text-xs"
        style={{
          background: "oklch(0.09 0.015 240 / 0.95)",
          borderTop: "1px solid oklch(var(--border))",
          color: "oklch(var(--muted-foreground))",
        }}
      >
        <div className="flex items-center justify-between">
          <span>
            {results.aimData
              .filter((e) => e.action === "move")
              .length.toLocaleString()}{" "}
            movement samples ·{" "}
            {results.aimData.filter((e) => e.action === "click").length} click
            events
          </span>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span
                className="w-3 h-1.5 rounded-full inline-block"
                style={{ background: "oklch(var(--hit-green))" }}
              />{" "}
              Hits
            </span>
            <span className="flex items-center gap-1">
              <span
                className="w-3 h-1.5 rounded-full inline-block"
                style={{ background: "oklch(var(--miss-red))" }}
              />{" "}
              Misses
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [muted, setMuted] = useState(false);
  const [settings, setSettings] = useState<GameSettings>({
    difficulty: "medium",
    duration: 60,
    mode: "static",
    trackingDifficulty: "average",
  });
  const [results, setResults] = useState<GameResults | null>(null);
  const [bestScore, setBestScoreState] = useState(getBestScore);
  const [newBest, setNewBest] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      try {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        audioCtxRef.current = new Ctx();
      } catch {
        return null;
      }
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {
        /* ignore */
      });
    }
    return audioCtxRef.current;
  }, []);

  const handleGameEnd = useCallback((gameResults: GameResults) => {
    setResults(gameResults);
    const prevBest = getBestScore();
    const isNewBest = gameResults.score > prevBest;
    setNewBest(isNewBest);
    if (isNewBest) {
      setBestScore(gameResults.score);
      setBestScoreState(gameResults.score);
    }
    setScreen("results");
  }, []);

  const handleStart = useCallback(() => {
    ensureAudioCtx();
    setScreen("game");
  }, [ensureAudioCtx]);

  return (
    <div className="dark">
      {screen === "menu" && (
        <MenuScreen
          settings={settings}
          onSettingsChange={setSettings}
          onStart={handleStart}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
          bestScore={bestScore}
        />
      )}
      {screen === "game" && (
        <GameScreen
          key={`game-${Date.now()}`}
          settings={settings}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
          onGameEnd={handleGameEnd}
          ensureAudioCtx={ensureAudioCtx}
        />
      )}
      {screen === "results" && results && (
        <ResultsScreen
          results={results}
          onReplay={() => setScreen("replay")}
          onHeatmap={() => setScreen("heatmap")}
          onRestart={() => setScreen("menu")}
          previousBest={bestScore}
          newBest={newBest}
        />
      )}
      {screen === "replay" && results && (
        <ReplayScreen
          key="replay"
          results={results}
          onBack={() => setScreen("results")}
        />
      )}
      {screen === "heatmap" && results && (
        <HeatmapScreen
          key="heatmap"
          results={results}
          onBack={() => setScreen("results")}
        />
      )}
    </div>
  );
}
