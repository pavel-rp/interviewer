export type ThemeName = 'ink' | 'paper' | 'contrast';
export type Density = 'comfortable' | 'compact';
export interface Theme {
  name: ThemeName; canvas: string; surface: string; raised: string;
  text: string; secondary: string; muted: string; accent: string; accentInk: string;
  border: string; selected: string; good: string; warning: string; danger: string;
}
export const themes: Record<ThemeName, Theme> = {
  ink: { name: 'ink', canvas: '#10141f', surface: '#192131', raised: '#243047', text: '#e7edf7', secondary: '#bbc8dc', muted: '#93a4bf', accent: '#a6adff', accentInk: '#121629', border: '#4c5d79', selected: '#353f65', good: '#80d4af', warning: '#f4c783', danger: '#ffa3ae' },
  paper: { name: 'paper', canvas: '#f3efe6', surface: '#e6e0d4', raised: '#d7d0c2', text: '#25283b', secondary: '#424960', muted: '#535b70', accent: '#493ca2', accentInk: '#ffffff', border: '#8c8693', selected: '#d3cbe9', good: '#205b42', warning: '#78500e', danger: '#982a3d' },
  contrast: { name: 'contrast', canvas: '#000000', surface: '#101010', raised: '#222222', text: '#ffffff', secondary: '#eeeeee', muted: '#cccccc', accent: '#ffff80', accentInk: '#000000', border: '#ffffff', selected: '#333333', good: '#aaffaa', warning: '#ffff80', danger: '#ffbbbb' },
};
export const spacing = { inset: 2, gap: 2, section: 1 } as const;
export const densityTokens = { comfortable: { rowHeight: 2 }, compact: { rowHeight: 1 } } as const;
