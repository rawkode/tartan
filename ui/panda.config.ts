import { defineConfig } from '@pandacss/dev';
import { keyframes, semanticColors, tokens } from './src/design-system/theme/academy';
import { recipes, slotRecipes } from './src/design-system/theme/recipes';

const gutter = 'clamp(20px, 4vw, 48px)';

export default defineConfig({
  presets: ['@pandacss/preset-base', '@pandacss/preset-panda'],
  preflight: true,
  strictTokens: true,
  include: ['./src/**/*.{ts,vue,astro}'],
  exclude: [],
  outdir: 'styled-system',
  // Variants are often chosen by a prop at runtime, so emit every one of them.
  staticCss: { recipes: '*' },
  theme: {
    extend: {
      tokens: {
        ...tokens,
        // The strong rule under a section heading or between columns.
        borders: { ...tokens.borders, rule: { value: '1px solid {colors.academy.text}' } },
        spacing: {
          ...tokens.spacing,
          // Full-bleed bands pad to this so their content lines up on the 1180px shell.
          edge: { value: `max(${gutter}, calc((100vw - 1180px) / 2 + ${gutter}))` },
        },
      },
      keyframes,
      semanticTokens: { colors: semanticColors },
      recipes,
      slotRecipes,
    },
  },
  globalCss: {
    html: { colorScheme: 'light' },
    'html.dark': { colorScheme: 'dark' },
    body: {
      backgroundColor: 'academy.canvas',
      color: 'academy.text',
      fontFamily: 'academy-text',
      lineHeight: 'body',
    },
    a: {
      color: 'academy.accent',
      _hover: { textDecoration: 'underline' },
    },
    code: { fontFamily: 'academy-mono', fontSize: 'sm' },
    '::selection': { backgroundColor: 'academy.accent', color: 'academy.accentForeground' },
    ':focus-visible': {
      outline: 'focus',
      outlineColor: 'academy.accent',
      outlineOffset: 'focus',
    },
    // The role decides which controls exist. Set on <html> by Layout.astro.
    "html:not([data-role='owner']) .owner-only, html[data-role='owner'] .not-owner, html[data-role='anon'] .member-only, html:not([data-role='anon']) .anon-only":
      { display: 'none !important' },
  },
});
