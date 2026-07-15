import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultWaveformTheme } from '../waveform-render.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('defaultWaveformTheme', () => {
  it('returns app-neutral colors and does not read app-specific CSS variables', () => {
    const getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn().mockReturnValue('#e0a560'),
    });
    vi.stubGlobal('document', {
      documentElement: {},
    });
    vi.stubGlobal('getComputedStyle', getComputedStyle);

    const theme = defaultWaveformTheme();

    expect(theme.active).toBe('currentColor');
    expect(theme.inactive).toBe('rgba(128,128,128,0.28)');
    expect(theme.background).toBeUndefined();
    expect(getComputedStyle).not.toHaveBeenCalled();
  });
});
