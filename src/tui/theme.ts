/** RGB tuple used for ANSI truecolor output. */
export type Rgb = readonly [number, number, number];

/** Banner gradient stops (cyan → purple → pink). */
export const GRADIENT_START: Rgb = [103, 232, 249];
export const GRADIENT_MID: Rgb = [167, 139, 250];
export const GRADIENT_END: Rgb = [244, 114, 182];

/** Semantic accent colors for status bar and input frame. */
export const COLOR_CYAN: Rgb = [56, 189, 248];
export const COLOR_PURPLE: Rgb = [192, 132, 252];
export const COLOR_PINK: Rgb = [244, 114, 182];
export const COLOR_MUTED: Rgb = [148, 163, 184];
export const COLOR_WHITE: Rgb = [226, 232, 240];
