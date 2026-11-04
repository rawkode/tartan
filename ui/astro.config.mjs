import vue from '@astrojs/vue';
import pandacss from '@pandacss/vite';
import { defineConfig, fontProviders } from 'astro/config';

const font = (name, cssVariable, weights) => ({
  provider: fontProviders.google(),
  name,
  cssVariable,
  weights,
  styles: ['normal'],
  display: 'swap',
});

export default defineConfig({
  integrations: [vue()],
  vite: { plugins: [pandacss()] },
  fonts: [
    font('Red Hat Display', '--font-red-hat-display', ['500', '600', '700', '800', '900']),
    font('Red Hat Text', '--font-red-hat-text', ['400', '500', '600', '700']),
    font('Red Hat Mono', '--font-red-hat-mono', ['400', '500', '600', '700']),
  ],
});
