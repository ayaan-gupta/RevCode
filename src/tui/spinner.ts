import { dim } from "./ansi.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TICK_MS = 80;

export const THINKING_STATUS_MESSAGES = [
  "Brewing…",
  "Calibrating…",
  "Conjuring…",
  "Contemplating…",
  "Cooking…",
  "Distilling…",
  "Dreaming…",
  "Fermenting…",
  "Germinating…",
  "Incubating…",
  "Marinating…",
  "Mulling…",
  "Noodling…",
  "Percolating…",
  "Pondering…",
  "Ruminating…",
  "Scheming…",
  "Synthesizing…",
  "Tinkering…",
  "Wrangling…",
] as const;

export function pickThinkingStatusMessage(
  random: () => number = Math.random,
): string {
  const index = Math.floor(random() * THINKING_STATUS_MESSAGES.length);
  return THINKING_STATUS_MESSAGES[index]!;
}

export interface SpinnerHandle {
  stop(): void;
}

export class ThinkingSpinner {
  private readonly rich: boolean;
  private interval: ReturnType<typeof setInterval> | undefined;
  private frameIndex = 0;
  private statusMessage = "";

  constructor(rich: boolean) {
    this.rich = rich;
  }

  start(): SpinnerHandle {
    this.statusMessage = pickThinkingStatusMessage();
    this.frameIndex = 0;

    if (!this.rich) {
      process.stdout.write(this.statusMessage);
      return { stop: () => this.stop() };
    }

    this.renderFrame();
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length;
      this.renderFrame();
    }, TICK_MS);

    return {
      stop: () => {
        this.stop();
      },
    };
  }

  private renderFrame(): void {
    const frame = FRAMES[this.frameIndex];
    process.stdout.write(`\r${dim(`${frame} ${this.statusMessage}`)}`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    process.stdout.write("\r\x1b[K");
  }
}
